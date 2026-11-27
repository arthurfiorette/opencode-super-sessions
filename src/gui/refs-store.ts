import { createKeyed, type ServerRef } from '@opencode/plugin/gui';
import { type Accessor, createMemo, createRoot, onCleanup, untrack } from 'solid-js';
import { createStore, reconcile, unwrap } from 'solid-js/store';
import type { SessionRefView } from '../rpc.js';
import { createSidebarState, type SidebarController } from '../sidebar-state.js';
import type { ForgeQueue } from './forge-queue.js';
import { rpcAt, rpcOn, serverPluginMissing } from './server.js';

// One fetcher per session for every GUI surface that shows its refs (the header, the Work lists,
// the composer pill), so they agree and ask the server once. It lives in setup, not in module
// state, and an entry lives only while something reads it.

/** How often a session's refs are refreshed from the forge while something shows them. */
const REFRESH_INTERVAL = 60_000;

/** A run ending is when the agent may have opened, pushed or merged something. */
const RUN_ENDS = [
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted'
] as const;

/** The session whose refs to read, and where to ask. */
export interface SessionTarget {
  readonly server: ServerRef;
  readonly sessionID: string;
  /** The session's directory, whose Location answers for it. */
  readonly directory: string;
}

/**
 * A session's refs as the GUI shows them.
 * - `loading`: nothing has answered yet.
 * - `ready`: `view` is the latest answer; undefined when the server knows no refs for it.
 * - `unavailable`: the session's server runs no server half of this plugin, so there are no refs
 *   to show.
 * - `error`: the first read failed for another reason. The next answer that comes in, from a
 *   session event, the minute's refresh or a reload, replaces it.
 */
export interface RefsState {
  readonly status: 'loading' | 'ready' | 'unavailable' | 'error';
  readonly view: SessionRefView | undefined;
}

/** The shared refs of sessions; see {@link createRefsStore}. */
export interface RefsStore {
  /**
   * Reads a session's refs for as long as the current owner (a component or a `createKeyed`
   * run) lives: cached refs first, then a forge refresh, again after every run of the session
   * and every minute. Undefined while `target` gives no session.
   */
  use(target: Accessor<SessionTarget | undefined>): Accessor<RefsState | undefined>;
  /**
   * Asks for a session's refs again, such as after the GUI linked or unlinked something, when
   * something reads them. Resolves once the answer is in.
   */
  reload(target: SessionTarget): Promise<void>;
  /** The window's queue of forge-bound calls, for the readers' own `pull.details`. */
  readonly queue: ForgeQueue;
}

/** What one read session holds while something reads it. */
interface Entry {
  users: number;
  controller: SidebarController;
  dispose(): void;
}

/** The cache key of a session: sessions are unique per server only. */
function keyOf(target: SessionTarget): string {
  return `${target.server.id}\n${target.sessionID}`;
}

/**
 * Creates the store. Call it once in setup, under the plugin's owner. `queue` is the window's
 * queue of forge-bound calls, which the store's refreshes and the readers' `pull.details` share.
 * `cached` gives refs another part of the window already holds for a session, such as the
 * browser's lists: a session's first reader shows them at once while the store asks again.
 */
export function createRefsStore(
  queue: ForgeQueue,
  cached: (target: SessionTarget) => SessionRefView | undefined = () => undefined
): RefsStore {
  const [states, setStates] = createStore<Record<string, RefsState | undefined>>({});
  const entries = new Map<string, Entry>();

  /** Starts fetching a session's refs: the RPC calls, the event listeners and the timer. */
  function open(key: string, target: SessionTarget): Entry {
    return createRoot((dispose) => {
      let closed = false;
      // Ends the entry's calls when nothing reads the session anymore, so a tab that closed or a
      // row the browser's preview passed frees its request slot.
      const abort = new AbortController();
      /**
       * One RPC call. Marks the session unavailable when its server has no server half, and
       * failed when nothing answered for it yet, so no surface waits on it forever. A `refresh`
       * waits on the forge, so it takes its turn in the window's {@link ForgeQueue}.
       */
      const call = async (method: 'refs' | 'refresh') => {
        try {
          const options = await rpcAt(target.server, target.directory);
          const ask = (signal: AbortSignal = abort.signal) =>
            rpcOn(target.server)[method](
              { sessionIDs: [target.sessionID] },
              { ...options, signal }
            );
          const answer = await (method === 'refresh'
            ? queue.run(target.server.id, ask, abort.signal)
            : ask(abort.signal));
          return answer[target.sessionID];
        } catch (error) {
          if (!closed && serverPluginMissing(error)) {
            setStates(key, { status: 'unavailable', view: undefined });
          } else if (!closed && untrack(() => states[key]?.status) === 'loading') {
            setStates(key, { status: 'error', view: undefined });
          }
          throw error;
        }
      };
      const controller = createSidebarState(
        { refs: () => call('refs'), refresh: () => call('refresh') },
        (view) => setStates(key, reconcile({ status: 'ready', view }))
      );
      // `data` is the server's live event feed; a restarted server brings a new one.
      createKeyed(
        () => target.server.data,
        (data) => {
          const offs = [
            // Link changes write the session's metadata; the cached answer has them at once.
            data.on('session.metadata.updated', (event) => {
              if (event.data.sessionID === target.sessionID) {
                void controller.show(target.sessionID);
              }
            }),
            ...RUN_ENDS.map((type) =>
              data.on(type, (event) => {
                if (event.data.sessionID === target.sessionID) void controller.refresh();
              })
            )
          ];
          onCleanup(() => {
            for (const off of offs) off();
          });
        }
      );
      // A server without the server half answers every minute the same way; a session event or
      // a reload asks again, and a `ready` answer brings the polling back.
      const timer = setInterval(() => {
        if (untrack(() => states[key]?.status) !== 'unavailable') void controller.refresh();
      }, REFRESH_INTERVAL);
      onCleanup(() => {
        closed = true;
        abort.abort();
        clearInterval(timer);
        controller.dispose();
      });
      void controller.show(target.sessionID);
      return { users: 0, controller, dispose };
    });
  }

  /** Counts one more reader of a session, opening its entry for the first. */
  function acquire(key: string, target: SessionTarget): void {
    let entry = entries.get(key);
    if (entry === undefined) {
      if (states[key] === undefined) {
        // A copy: the browser's store reconciles its own object, and this one reconciles the
        // answers into what it holds.
        const seed = untrack(() => cached(target));
        setStates(
          key,
          seed === undefined
            ? { status: 'loading', view: undefined }
            : { status: 'ready', view: structuredClone(unwrap(seed)) }
        );
      }
      entry = open(key, target);
      entries.set(key, entry);
    }
    entry.users++;
  }

  /**
   * Counts one reader less, closing the entry after the last. Its state stays until the next
   * microtask, so a reader that moves on to the same session in the same update, as a header
   * does when the session moves to another directory, keeps the refs on screen.
   */
  function release(key: string): void {
    const entry = entries.get(key);
    if (entry === undefined || --entry.users > 0) return;
    entries.delete(key);
    entry.dispose();
    queueMicrotask(() => {
      if (!entries.has(key)) setStates(key, undefined);
    });
  }

  onCleanup(() => {
    for (const entry of entries.values()) entry.dispose();
    entries.clear();
  });

  return {
    queue,
    use(target) {
      const key = createMemo(() => {
        const current = target();
        return current === undefined ? undefined : keyOf(current);
      });
      createKeyed(
        target,
        (current) => {
          const entryKey = keyOf(current);
          acquire(entryKey, current);
          onCleanup(() => release(entryKey));
        },
        {
          equals: (previous, next) =>
            keyOf(previous) === keyOf(next) && previous.directory === next.directory
        }
      );
      return () => {
        const current = key();
        if (current === undefined) return undefined;
        const known = states[current];
        if (known !== undefined) return known;
        // Before the entry opens, in the same update as a session switch: what the window
        // already holds, so a reader never draws the loading state over a cached answer.
        const shown = untrack(target);
        const seed = shown === undefined ? undefined : untrack(() => cached(shown));
        return seed === undefined ? undefined : { status: 'ready', view: seed };
      };
    },
    reload(target) {
      return entries.get(keyOf(target))?.controller.show(target.sessionID) ?? Promise.resolve();
    }
  };
}
