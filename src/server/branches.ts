import type { ForgeError, ForgeProvider, RepoRef } from '../providers/provider.js';
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
  get(target: BranchTarget): Ref[] | undefined;
  /** Whether the entry is missing or expired. */
  stale(target: BranchTarget): boolean;
  /**
   * Looks the branch up when its entry is missing or expired (always with `force`, unless an
   * error is still backing off). Concurrent calls for one branch share a request.
   */
  ensure(
    provider: ForgeProvider,
    target: BranchTarget,
    options?: { force?: boolean }
  ): Promise<Ref[] | undefined>;
}

interface Entry {
  refs: Ref[] | undefined;
  expiresAt: number;
  /** An error's backoff, honored even by forced lookups. */
  retryAt?: number;
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
  const inflight = new Map<string, Promise<Ref[] | undefined>>();

  /** Stores a provider answer with the TTL its outcome earns. */
  const store = (key: string, result: Ref[] | ForgeError) => {
    const at = now();
    if (!Array.isArray(result)) {
      // Keeps the last good answer visible through a transient failure.
      const refs = entries.get(key)?.refs;
      entries.set(key, {
        refs: result.reason === 'not-found' ? [] : refs,
        expiresAt: result.retryAt ?? at + ERROR_TTL,
        ...(result.retryAt === undefined ? {} : { retryAt: result.retryAt })
      });
      return;
    }
    const ttl = result.some(options.isOpen) ? OPEN_TTL : SETTLED_TTL;
    entries.set(key, { refs: result, expiresAt: at + ttl });
  };

  /** Whether an entry must be fetched now. */
  const due = (entry: Entry | undefined, force: boolean) => {
    if (entry === undefined) return true;
    const at = now();
    if (entry.retryAt !== undefined && entry.retryAt > at) return false;
    return force || entry.expiresAt <= at;
  };

  return {
    get: (target) => entries.get(branchKey(target))?.refs,

    stale: (target) => due(entries.get(branchKey(target)), false),

    ensure(provider, target, ensureOptions = {}) {
      const key = branchKey(target);
      const pending = inflight.get(key);
      if (pending !== undefined) return pending;
      const entry = entries.get(key);
      if (!due(entry, ensureOptions.force === true)) return Promise.resolve(entry?.refs);
      const request = provider
        .branchPullRequests(target.repo, target.branch, target.headRepo)
        .catch((): ForgeError => ({ reason: 'failed' }))
        .then((result) => {
          store(key, result);
          return entries.get(key)?.refs;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, request);
      return request;
    }
  };
}
