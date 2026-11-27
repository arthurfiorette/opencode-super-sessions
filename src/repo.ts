import { stat } from 'node:fs/promises';
import path from 'node:path';
import { gitIn } from './host/git.js';
import { createLimiter, type Runner, run } from './process.js';
import type { ForgeDefinition, RepoRef } from './providers/provider.js';

/** What the plugin knows about a session directory's git checkout. Every field is optional. */
export interface RepoInfo {
  repo?: RepoRef;
  /** Name of the remote `repo` came from. */
  remote?: string;
  /** From `refs/remotes/<remote>/HEAD`; unset when the clone never recorded it. */
  defaultBranch?: string;
  /** Current branch; unset when HEAD is detached or the directory is not a checkout. */
  branch?: string;
  /** Whether `branch` has an upstream, i.e. was pushed or tracks a remote branch. */
  upstream?: boolean;
  /**
   * Repository of the upstream's remote, when a definition recognizes it. In a fork checkout
   * `repo` is the original (`upstream`) and this is the fork (`origin`) the branch was pushed to.
   */
  headRepo?: RepoRef;
}

export interface RepoResolver {
  /** Reads `directory`, from the cache unless `force`, which runs git again. */
  resolve(directory: string, options?: { force?: boolean }): Promise<RepoInfo>;
}

type RemoteInfo = Pick<RepoInfo, 'repo' | 'remote' | 'defaultBranch'> & {
  /** Every recognized remote by name, to map the branch's upstream to its repository. */
  remotes?: Map<string, RepoRef>;
};
/** `upstreamRef` is the short upstream name, such as `origin/fix/login`. */
type BranchInfo = Pick<RepoInfo, 'branch'> & { upstreamRef?: string };

const REMOTE_TTL_MS = 15 * 60_000;
// Short: the agent switches branches inside sessions and the row should follow soon after.
const BRANCH_TTL_MS = 10_000;
const TIMEOUT_MS = 5000;
// A `refs` call for every session in all projects resolves dozens of new directories at once,
// and each spawn blocks the daemon's event loop for a moment. Unbounded, they pile into stalls
// of a few hundred milliseconds that lag every client of the daemon.
const MAX_CONCURRENT = 8;
// Paths and file URLs: clones of local repositories never map to a forge.
const LOCAL_REMOTE = /^(?:file:|\/|~|\.{1,2}[\\/]|[A-Za-z]:[\\/]|\\\\)/;

/**
 * Picks the remote that names the session's repository, in t3code's order: `upstream` (the
 * original when working from a fork), then `origin`, then the first name alphabetically.
 */
function chooseRemote(remotes: Map<string, RepoRef>): [string, RepoRef] | undefined {
  for (const name of ['upstream', 'origin']) {
    const repo = remotes.get(name);
    if (repo) return [name, repo];
  }
  return [...remotes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))[0];
}

/** One cached value of {@link memo}. */
interface Cached<T> {
  value: Promise<T>;
  /** When the value expires; until it resolves, the TTL counts from when its load started. */
  expiresAt: number;
  /** How long past `expiresAt` the value still answers while it reloads. */
  ttl: number;
  /** The load that replaces this expired value, while it runs. */
  next?: Promise<T> | undefined;
}

/**
 * Caches one async value per key; concurrent callers share the pending value. An expired value is
 * still returned at once while a background load replaces it, so a `refs` call for hundreds of
 * sessions never waits on git for a directory it has read before. Git spawns block the daemon's
 * event loop for a moment each, and expired caches made a warm open spend up to 0.55 s on them.
 * Past twice its TTL a value no longer answers and callers wait for the load, so nothing reads a
 * checkout older than that. `ttl` takes the loaded value, so a missing directory can expire sooner
 * than a found one. `force` loads again, waits for it, and replaces the cached value.
 */
function memo<T>(
  ttl: (value: T) => number,
  load: (key: string) => Promise<T>
): (key: string, force?: boolean) => Promise<T> {
  const cache = new Map<string, Cached<T>>();
  /** Starts a load for `key` and caches it, with the TTL its value asks for once it resolves. */
  const store = (key: string, value: Promise<T>, started: number) => {
    // The TTL depends on the value, so a pending value never expires; callers share it.
    const entry: Cached<T> = { value, expiresAt: Number.POSITIVE_INFINITY, ttl: 0 };
    cache.set(key, entry);
    value.then(
      (result) => {
        entry.ttl = ttl(result);
        entry.expiresAt = started + entry.ttl;
      },
      () => {
        // A failed load is not kept: the next call loads again.
        if (cache.get(key) === entry) cache.delete(key);
      }
    );
    return entry;
  };
  return (key, force = false) => {
    const cached = cache.get(key);
    const now = Date.now();
    if (!force && cached !== undefined) {
      if (cached.expiresAt > now) return cached.value;
      if (cached.next === undefined) {
        const started = now;
        // Spawning git blocks the event loop for a few ms each; started on the next turn, the
        // spawns run after the caller answered instead of before.
        const next = new Promise<void>((resolve) => setImmediate(resolve)).then(() => load(key));
        cached.next = next;
        next.then(
          () => {
            // A forced load in the meantime holds a newer value.
            if (cache.get(key) === cached) store(key, next, started);
          },
          () => {
            cached.next = undefined;
          }
        );
      }
      if (cached.expiresAt + cached.ttl > now) return cached.value;
      // Too old to answer: wait for the load, or keep the old value if git fails.
      return cached.next.catch(() => cached.value);
    }
    return store(key, load(key), now).value;
  };
}

/**
 * Creates a resolver that reads the forge repository, default branch and current branch of a
 * directory with git. Remote data is cached 15 minutes per directory and branch data 10 seconds,
 * then served stale for one more TTL while git reads it again; a directory that does not exist
 * runs no git for 10 seconds. At most {@link MAX_CONCURRENT} git processes run at once per
 * resolver; the runtime holds one.
 */
export function createRepoResolver(options: {
  definitions: ForgeDefinition[];
  git?: Runner;
}): RepoResolver {
  const runner = options.git ?? run;
  const limit = createLimiter(MAX_CONCURRENT);

  /** Runs git against `directory`; returns trimmed stdout on success. */
  const git = async (directory: string, args: string[]) => {
    const result = await limit(() => gitIn(runner, directory, TIMEOUT_MS)(...args));
    return result.code === 0 ? result.stdout.trim() : undefined;
  };

  /** Maps each fetch remote a definition recognizes to its repository. */
  const recognize = (output: string) => {
    const remotes = new Map<string, RepoRef>();
    for (const line of output.split(/\r?\n/)) {
      const match = /^(\S+)\t(\S+) \(fetch\)$/.exec(line);
      if (!match?.[1] || !match[2] || LOCAL_REMOTE.test(match[2])) continue;
      for (const definition of options.definitions) {
        const repo = definition.recognizeRemote(match[2]);
        if (repo) {
          remotes.set(match[1], repo);
          break;
        }
      }
    }
    return remotes;
  };

  /**
   * Whether a directory exists. Removed worktrees keep their sessions, so without this every
   * `refs` call would spawn git for each of them only to fail. A missing directory is remembered
   * only as long as a branch, so a worktree created again at the same path shows within seconds.
   */
  const exists = memo(
    (found) => (found ? REMOTE_TTL_MS : BRANCH_TTL_MS),
    (directory) =>
      stat(directory).then(
        () => true,
        (error: NodeJS.ErrnoException) => error.code !== 'ENOENT' && error.code !== 'ENOTDIR'
      )
  );

  /** Repository, remote and default branch of a directory. */
  const remoteInfo = memo(
    () => REMOTE_TTL_MS,
    async (directory): Promise<RemoteInfo> => {
      const output = await git(directory, ['remote', '-v']);
      const remotes = output ? recognize(output) : new Map<string, RepoRef>();
      const chosen = chooseRemote(remotes);
      if (!chosen) return {};
      const [remote, repo] = chosen;
      const head = await git(directory, ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]);
      const defaultBranch = head?.startsWith(`${remote}/`)
        ? head.slice(remote.length + 1)
        : undefined;
      return { repo, remote, remotes, ...(defaultBranch ? { defaultBranch } : {}) };
    }
  );

  /** Current branch of a directory and whether it has an upstream. */
  const branchInfo = memo(
    () => BRANCH_TTL_MS,
    async (directory): Promise<BranchInfo> => {
      const branch = await git(directory, ['rev-parse', '--abbrev-ref', 'HEAD']);
      // rev-parse prints the literal `HEAD` when detached.
      if (!branch || branch === 'HEAD') return {};
      const upstream = await git(directory, [
        'rev-parse',
        '--abbrev-ref',
        '--symbolic-full-name',
        '@{u}'
      ]);
      return upstream ? { branch, upstreamRef: upstream } : { branch };
    }
  );

  return {
    /** Resolves a directory; a non-git directory resolves to an empty object. */
    async resolve(directory, options = {}) {
      const key = path.resolve(directory);
      const force = options.force === true;
      // A forced resolve looks at the directory again too, as after a worktree was recreated.
      if (!(await exists(key, force))) return {};
      const [{ remotes, ...remote }, { upstreamRef, ...branch }] = await Promise.all([
        remoteInfo(key, force),
        branchInfo(key, force)
      ]);
      if (branch.branch === undefined) return remote;
      const headRepo = upstreamRef && remotes ? upstreamRepo(remotes, upstreamRef) : undefined;
      return {
        ...remote,
        ...branch,
        upstream: upstreamRef !== undefined,
        ...(headRepo ? { headRepo } : {})
      };
    }
  };
}

/**
 * Finds the repository of the remote an upstream such as `origin/fix/login` belongs to. Remote
 * and branch names may both contain slashes, so the longest remote name that prefixes it wins.
 */
function upstreamRepo(remotes: Map<string, RepoRef>, upstreamRef: string): RepoRef | undefined {
  let best: [string, RepoRef] | undefined;
  for (const [name, repo] of remotes) {
    if (!upstreamRef.startsWith(`${name}/`)) continue;
    if (best === undefined || name.length > best[0].length) best = [name, repo];
  }
  return best?.[1];
}
