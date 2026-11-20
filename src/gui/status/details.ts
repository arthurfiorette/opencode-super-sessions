import { createEffect, on, untrack } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { type PullDetails, type Ref, type RefState, refKey } from '../../refs/ref.js';
import type { SessionTarget } from '../refs-store.js';
import { at, rpcOn } from '../server.js';

// The checks of a session's pull requests, from `pull.details`, for the Work list's failed checks
// and the composer pill's rows. The server caches details like snapshots, so each surface asks on
// its own instead of sharing a cache.

/** Input of {@link createPullDetails}. */
export interface PullDetailsInput {
  /** The session whose server and Location answer. */
  target(): SessionTarget | undefined;
  /** The pull requests whose details to load, with their snapshots. */
  pulls(): Array<{ ref: Ref; state: RefState | undefined }>;
}

/**
 * Details of `pulls()`, loaded again whenever that set or one of their check counts changes, so a
 * new CI result lists its checks. A key stays undefined while loading, after a failed load, and
 * on a server without the server plugin. Call it under a component or root that owns it.
 */
export function createPullDetails(
  input: PullDetailsInput
): (key: string) => PullDetails | undefined {
  const [details, setDetails] = createStore<Record<string, PullDetails>>({});
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
  createEffect(
    on(stamp, () => {
      const target = untrack(input.target);
      if (target === undefined) return;
      for (const { ref } of untrack(input.pulls)) {
        const key = refKey(ref);
        Promise.resolve()
          .then(() => rpcOn(target.server)['pull.details']({ ref }, at(target.directory)))
          .then(
            (found) => setDetails(key, reconcile(found)),
            // Keep what is on screen: the next CI change or session run asks again.
            () => {}
          );
      }
    })
  );
  return (key) => details[key];
}
