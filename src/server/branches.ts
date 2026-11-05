import type { BranchPull, ForgeError, ForgeProvider, RepoRef } from '../providers/provider.js';
import type { Ref } from '../refs/ref.js';

/** One branch lookup: the repository PRs live in, the branch, and the repository it was pushed to. */
export interface BranchTarget {
  repo: RepoRef;
  branch: string;
  /** The fork the branch was pushed to; defaults to `repo`. */
  headRepo?: RepoRef;
}

export interface BranchCache {
  /** Last known pull requests for the branch, even if expired. Never calls the forge. */
  get(target: BranchTarget): BranchPull[] | undefined;
  /** Whether the entry is missing or expired. */
  stale(target: BranchTarget): boolean;
  /** Why the last lookup failed, when it did. `not-found` is an answer, not a failure. */
  failure(target: BranchTarget): ForgeError | undefined;
  /**
   * Looks the branch up when its entry is missing or expired (always with `force`, unless an
   * error is still backing off). Concurrent calls for one branch share a request.
   */
  ensure(
    provider: ForgeProvider,
    target: BranchTarget,
    options?: { force?: boolean }
  ): Promise<BranchPull[] | undefined>;
}

interface Entry {
  pulls: BranchPull[] | undefined;
  expiresAt: number;
  /** An error's backoff, honored even by forced lookups. */
  retryAt?: number;
  /** The last lookup's error, other than `not-found`. */
  failure?: ForgeError;
}

const MINUTE = 60_000;
// An open PR can merge or a new one can appear at any time, so open branches recheck sooner.
const OPEN_TTL = MINUTE;
const SETTLED_TTL = 5 * MINUTE;
const ERROR_TTL = 30_000;

/**
 * Cache key: `host/repo@branch`, with the head repository added for fork branches. Branch names
 * are case-sensitive in git; hosts and repositories are not.
 */
function branchKey(target: BranchTarget): string {
  const repo = `${target.repo.host}/${target.repo.repo}`.toLowerCase();
  const head = target.headRepo?.repo.toLowerCase();
  const fork = head === undefined || head === target.repo.repo.toLowerCase() ? '' : `${head}:`;
  return `${repo}@${fork}${target.branch}`;
}

/**
 * Creates the process-wide cache of pull requests per branch. `isOpen` tells whether a ref's last
 * known state is open, which picks the shorter TTL; unknown states count as open.
 */
export function createBranchCache(options: {
  isOpen: (ref: Ref) => boolean;
  now?: () => number;
}): BranchCache {
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const inflight = new Map<string, Promise<BranchPull[] | undefined>>();

  /** Stores a provider answer with the TTL its outcome earns. */
  const store = (key: string, result: BranchPull[] | ForgeError) => {
    const at = now();
    if (!Array.isArray(result)) {
      // Keeps the last good answer visible through a transient failure.
      const pulls = entries.get(key)?.pulls;
      entries.set(key, {
        pulls: result.reason === 'not-found' ? [] : pulls,
        expiresAt: result.retryAt ?? at + ERROR_TTL,
        ...(result.retryAt === undefined ? {} : { retryAt: result.retryAt }),
        ...(result.reason === 'not-found' ? {} : { failure: result })
      });
      return;
    }
    const ttl = result.some((pull) => options.isOpen(pull.ref)) ? OPEN_TTL : SETTLED_TTL;
    entries.set(key, { pulls: result, expiresAt: at + ttl });
  };

  /** Whether an entry must be fetched now. */
  const due = (entry: Entry | undefined, force: boolean) => {
    if (entry === undefined) return true;
    const at = now();
    if (entry.retryAt !== undefined && entry.retryAt > at) return false;
    return force || entry.expiresAt <= at;
  };

  return {
    get: (target) => entries.get(branchKey(target))?.pulls,

    stale: (target) => due(entries.get(branchKey(target)), false),

    failure: (target) => entries.get(branchKey(target))?.failure,

    ensure(provider, target, ensureOptions = {}) {
      const key = branchKey(target);
      const pending = inflight.get(key);
      if (pending !== undefined) return pending;
      const entry = entries.get(key);
      if (!due(entry, ensureOptions.force === true)) return Promise.resolve(entry?.pulls);
      const request = provider
        .branchPullRequests(target.repo, target.branch, target.headRepo)
        .catch((): ForgeError => ({ reason: 'failed' }))
        .then((result) => {
          store(key, result);
          return entries.get(key)?.pulls;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, request);
      return request;
    }
  };
}

/**
 * How much earlier than the session a pull request may say it was opened and still count as
 * opened by it. The session's creation time comes from this machine's clock and the pull
 * request's from the forge's, and a clock that syncs rarely (Windows syncs weekly by default)
 * drifts by seconds to a minute. Two minutes covers that drift, while a pull request another
 * session opened on the branch is usually hours or days older than the next session there.
 */
export const OPENED_SLACK_MS = 2 * 60_000;

/** The session facts {@link sessionBranchPulls} decides on. */
export interface BranchOwner {
  /** When the session was created, epoch milliseconds. */
  created: number;
  /** Branches the session pushed. */
  pushed: readonly string[];
}

/**
 * The branch pull requests that came out of the session: those opened at or after it was
 * created, give or take {@link OPENED_SLACK_MS}, and every one on a branch it pushed. A pull
 * request whose opening time the forge did not report counts, as every branch pull request did
 * before this rule. Explicit links never go through this; they always count.
 */
export function sessionBranchPulls(
  pulls: readonly BranchPull[],
  branch: string,
  owner: BranchOwner
): Ref[] {
  const pushed = owner.pushed.includes(branch);
  return pulls
    .filter(
      (pull) =>
        pushed || pull.createdAt === undefined || pull.createdAt >= owner.created - OPENED_SLACK_MS
    )
    .map((pull) => pull.ref);
}
