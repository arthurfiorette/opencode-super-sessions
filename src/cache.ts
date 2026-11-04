import type { ForgeError, ForgeProvider, RefCandidate } from './providers/provider.js';
import { type Ref, type RefState, type RefStatus, refKey } from './refs/ref.js';

/** Last known answer for one candidate: its live state, or why it could not be fetched. */
export type Snapshot = { ref: Ref; state: RefState } | ForgeError;

export interface SnapshotCache {
  /** Last known value, even if expired. Never calls the forge. */
  get(key: string): Snapshot | undefined;
  /** Keys whose value is missing or expired and that are not backing off after an error. */
  stale(keys: string[]): string[];
  /**
   * Fetches missing and expired candidates (all of them with `force`) and returns every
   * candidate's value by {@link candidateKey}. Concurrent calls share in-flight fetches, and an
   * error's `retryAt` holds even under `force`.
   */
  ensure(
    provider: ForgeProvider,
    candidates: RefCandidate[],
    options?: { force?: boolean }
  ): Promise<Map<string, Snapshot>>;
}

interface Entry {
  value: Snapshot;
  expiresAt: number;
  /** Set after a rate limit; no fetch happens before it, forced or not. */
  retryAt?: number;
}

const MINUTE = 60_000;
// Merged and resolved refs cannot change state again, so they are never refetched on a timer.
const TTL: Record<RefStatus, number> = {
  open: 2 * MINUTE,
  draft: 2 * MINUTE,
  closed: 15 * MINUTE,
  merged: Number.POSITIVE_INFINITY,
  completed: Number.POSITIVE_INFINITY,
  not_planned: Number.POSITIVE_INFINITY
};
const ERROR_TTL = 30_000;

/**
 * Cache key for a candidate. Equals {@link refKey} when the kind is known; bare `#N` candidates
 * get a kind-less key until the forge says whether they are a PR or an issue.
 */
export function candidateKey(candidate: RefCandidate): string {
  if (candidate.kind) return refKey({ ...candidate, kind: candidate.kind });
  return `${candidate.provider}:${candidate.host}/${candidate.repo}/?/${candidate.number}`.toLowerCase();
}

/**
 * Creates the snapshot cache. The server keeps one per process so every Location shares the
 * same states and never asks the forge twice for one ref.
 */
export function createSnapshotCache(options: { now?: () => number } = {}): SnapshotCache {
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  // Candidate keys that resolved to a different ref key: kind-less `#N`, or a wrong kind guess.
  const aliases = new Map<string, string>();
  const inflight = new Map<string, Promise<void>>();

  /** Finds the entry behind a candidate key, following aliases. */
  const lookup = (key: string) => entries.get(aliases.get(key) ?? key);

  /** Whether the entry must be fetched now. */
  const due = (entry: Entry | undefined, force: boolean, at: number) => {
    if (!entry) return true;
    if (entry.retryAt !== undefined && entry.retryAt > at) return false;
    return force || entry.expiresAt <= at;
  };

  /** Records one provider answer under the ref key it resolved to. */
  const store = (key: string, value: Snapshot, at: number) => {
    if ('ref' in value) {
      const resolved = refKey(value.ref);
      if (resolved !== key) {
        aliases.set(key, resolved);
        entries.delete(key);
      }
      entries.set(resolved, { value, expiresAt: at + TTL[value.state.status] });
      return;
    }
    const resolved = aliases.get(key) ?? key;
    const previous = entries.get(resolved)?.value;
    const expiresAt = value.retryAt ?? at + ERROR_TTL;
    // A transient failure keeps showing the last known state; only `not-found` replaces it,
    // because the ref is gone or no longer visible.
    const kept = previous && 'ref' in previous && value.reason !== 'not-found' ? previous : value;
    entries.set(resolved, {
      value: kept,
      expiresAt,
      ...(value.retryAt === undefined ? {} : { retryAt: value.retryAt })
    });
  };

  /** Fetches candidates in one provider call and registers it as in flight for their keys. */
  const fetch = (
    provider: ForgeProvider,
    batch: Array<{ key: string; candidate: RefCandidate }>
  ) => {
    const promise = provider
      .snapshot(batch.map(({ candidate }) => candidate))
      .then(
        (results) => results,
        (): Snapshot[] => batch.map(() => ({ reason: 'failed' }))
      )
      .then((results) => {
        const at = now();
        for (const [index, { key }] of batch.entries()) {
          store(key, results[index] ?? { reason: 'failed' }, at);
        }
      })
      .finally(() => {
        for (const { key } of batch) {
          if (inflight.get(key) === promise) inflight.delete(key);
        }
      });
    for (const { key } of batch) inflight.set(key, promise);
    return promise;
  };

  return {
    get: (key) => lookup(key)?.value,

    stale(keys) {
      const at = now();
      return keys.filter((key) => due(lookup(key), false, at));
    },

    async ensure(provider, candidates, ensureOptions = {}) {
      const at = now();
      const keys = candidates.map(candidateKey);
      const waits = new Set<Promise<void>>();
      const batch = new Map<string, RefCandidate>();

      for (const [index, key] of keys.entries()) {
        const pending = inflight.get(key);
        if (pending) {
          waits.add(pending);
          continue;
        }
        const candidate = candidates[index];
        if (candidate && due(lookup(key), ensureOptions.force === true, at)) {
          batch.set(key, candidate);
        }
      }
      if (batch.size > 0) {
        waits.add(
          fetch(
            provider,
            [...batch].map(([key, candidate]) => ({ key, candidate }))
          )
        );
      }
      await Promise.all(waits);

      const result = new Map<string, Snapshot>();
      for (const key of keys) {
        const value = lookup(key)?.value;
        if (value) result.set(key, value);
      }
      return result;
    }
  };
}
