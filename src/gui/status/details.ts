import { createLatest } from '@opencode/plugin/gui';
import { untrack } from 'solid-js';
import { type PullDetails, type Ref, type RefState, refKey } from '../../refs/ref.js';
import type { ForgeQueue } from '../forge-queue.js';
import type { SessionTarget } from '../refs-store.js';
import { rpcAt, rpcOn } from '../server.js';

// The checks of a session's pull requests, from `pull.details`, for the Work list's failed checks
// and the composer pill's rows. The server caches details like snapshots, so each surface asks on
// its own instead of sharing a cache.

/** Input of {@link createPullDetails}. */
export interface PullDetailsInput {
  /** The session whose server and Location answer. */
  target(): SessionTarget | undefined;
  /** The pull requests whose details to load, with their snapshots. */
  pulls(): Array<{ ref: Ref; state: RefState | undefined }>;
  /** The window's queue of forge-bound calls; each pull request's details take one turn. */
  queue: ForgeQueue;
}

/**
 * Details of `pulls()`, loaded again whenever that set or one of their check counts changes, so a
 * new CI result lists its checks. An answer for an earlier set is dropped. A key stays undefined
 * while loading, after a failed first load, and on a server without the server plugin; a failed
 * later load keeps the previous details. Call it under a component or root that owns it.
 */
export function createPullDetails(
  input: PullDetailsInput
): (key: string) => PullDetails | undefined {
  /** What the details depend on, as one string; empty, and so inactive, without a session. */
  const stamp = () => {
    const target = input.target();
    if (target === undefined) return '';
    const pulls = input.pulls().map(({ ref, state }) => {
      const review = state?.review;
      const counts = [
        review?.checks,
        review?.checksPassed,
        review?.checksTotal,
        review?.checksFailed,
        review?.checksPending
      ];
      return `${refKey(ref)}@${counts.join('/')}`;
    });
    return [target.server.id, target.sessionID, ...pulls].join(' ');
  };
  const details = createLatest(stamp, async (_, signal) => {
    const target = untrack(input.target);
    const pulls = untrack(input.pulls);
    if (target === undefined) return {};
    const options = await rpcAt(target.server, target.directory);
    // Read after the first await: the first run starts while `details` is still being created.
    const previous = untrack(() => details.latest) ?? {};
    const found = await Promise.all(
      pulls.map(async ({ ref }) => {
        const key = refKey(ref);
        try {
          const answer = await input.queue.run(
            target.server.id,
            (limit) => rpcOn(target.server)['pull.details']({ ref }, { ...options, signal: limit }),
            signal
          );
          return [key, answer] as const;
        } catch {
          // Keep what is on screen: the next CI change or session run asks again.
          return [key, previous[key]] as const;
        }
      })
    );
    const next: Record<string, PullDetails> = {};
    for (const [key, answer] of found) if (answer !== undefined) next[key] = answer;
    return next;
  });
  return (key) => details.latest?.[key];
}
