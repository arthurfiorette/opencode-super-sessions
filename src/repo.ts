import path from 'node:path';
import { type Runner, run } from './process.js';
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
  resolve(directory: string): Promise<RepoInfo>;
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
// No credential prompts, and no index refresh that could fight the agent's own git commands for
// `index.lock`.
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
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

/** Caches one async value per key until it expires; concurrent callers share the pending value. */
function memo<T>(ttl: number, load: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const cache = new Map<string, { value: Promise<T>; expiresAt: number }>();
  return (key) => {
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = load(key);
    cache.set(key, { value, expiresAt: Date.now() + ttl });
    return value;
  };
}

/**
 * Creates a resolver that reads the forge repository, default branch and current branch of a
 * directory with git. Remote data is cached 15 minutes per directory and branch data 10 seconds.
 */
export function createRepoResolver(options: {
  definitions: ForgeDefinition[];
  git?: Runner;
}): RepoResolver {
  const runner = options.git ?? run;

  /** Runs git against `directory`; returns trimmed stdout on success. */
  const git = async (directory: string, args: string[]) => {
    const result = await runner('git', ['-C', directory, ...args], {
      timeoutMs: TIMEOUT_MS,
      env: GIT_ENV
    });
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

  /** Repository, remote and default branch of a directory. */
  const remoteInfo = memo(REMOTE_TTL_MS, async (directory): Promise<RemoteInfo> => {
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
  });

  /** Current branch of a directory and whether it has an upstream. */
  const branchInfo = memo(BRANCH_TTL_MS, async (directory): Promise<BranchInfo> => {
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
  });

  return {
    /** Resolves a directory; a non-git directory resolves to an empty object. */
    async resolve(directory) {
      const key = path.resolve(directory);
      const [{ remotes, ...remote }, { upstreamRef, ...branch }] = await Promise.all([
        remoteInfo(key),
        branchInfo(key)
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
