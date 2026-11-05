import type { Plugin } from '@opencode/plugin';
import { activityStamp } from '../host/session-api.js';
import { METADATA_KEY, readSessionRefs, type SessionRefs, sessionRefsSchema } from '../refs/ref.js';
import { type RefsUpdate, withSessionRefs } from '../refs/store.js';

/** The part of a Location's session API the write queue needs. */
export type SessionAccess = Pick<Plugin.Context['session'], 'get' | 'update'>;

/** Pure change applied to a session's current refs. Returns `changed: false` to skip the write. */
export type RefsMutation = (refs: SessionRefs) => RefsUpdate;

export interface WriteQueue {
  /**
   * Reads the session's metadata, applies `mutate` and writes the result when it changed. Calls
   * for one session run one at a time, in call order, across every Location. Resolves to the
   * refs after the mutation, whether or not a write happened.
   */
  update(session: SessionAccess, sessionID: string, mutate: RefsMutation): Promise<SessionRefs>;
}

/**
 * Creates the per-session write queue. `session.update({ metadata })` replaces the whole metadata
 * object, so two writers that read before either writes would drop one change. Every link change
 * from tools, hooks, events and RPC goes through one process-wide queue to rule that out.
 *
 * A stored value that does not parse, such as one a newer plugin version wrote, is never
 * replaced: the update rejects and `warn` names the session. The first write to a session
 * without run times also stamps `activeAt` (see `activityStamp`).
 */
export function createWriteQueue(warn: (message: string) => void = () => {}): WriteQueue {
  const tails = new Map<string, Promise<unknown>>();

  return {
    update(session, sessionID, mutate) {
      const previous = tails.get(sessionID) ?? Promise.resolve();
      // A failed write must not block the next one, so the chain continues on either outcome.
      const next = previous.then(noop, noop).then(async () => {
        const info = await session.get({ sessionID });
        const stored = info.metadata?.[METADATA_KEY];
        if (stored !== undefined && !sessionRefsSchema.safeParse(stored).success) {
          const message = `Session ${sessionID} holds a ${METADATA_KEY} value this version cannot read, so its links were not changed`;
          warn(message);
          throw new Error(message);
        }
        const result = mutate(readSessionRefs(info.metadata));
        if (!result.changed) return result.next;
        // This write moves `time.updated`, the only activity record of a session without run
        // times, so the value it had is kept for `activityTime`.
        const stamp = activityStamp(info);
        const next = stamp === undefined ? result.next : { ...result.next, activeAt: stamp };
        await session.update({
          sessionID,
          // SessionRefs is plain JSON, which the schema-typed metadata cannot infer.
          metadata: withSessionRefs(info.metadata, next) as typeof info.metadata & {}
        });
        return next;
      });
      tails.set(sessionID, next);
      // Drops the entry once the chain is idle so finished sessions do not accumulate.
      const release = () => {
        if (tails.get(sessionID) === next) tails.delete(sessionID);
      };
      next.then(release, release);
      return next;
    }
  };
}

/** Ignores a previous step's outcome. */
function noop(): void {}
