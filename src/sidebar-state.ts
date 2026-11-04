import type { SessionRefView } from './rpc.js';

/** RPC calls the sidebar makes for one session. */
export interface SidebarSource {
  /** Cached links and states. Fast; never waits on the forge. */
  refs(sessionID: string): Promise<SessionRefView | undefined>;
  /** Waits for the forge to refresh expired states. Can take seconds. */
  refresh(sessionID: string): Promise<SessionRefView | undefined>;
}

/** Fetches the refs of the session the sidebar shows and drops answers that arrive too late. */
export interface SidebarController {
  /** Switches to a session (or reloads the current one): cached refs first, then a refresh. */
  show(sessionID: string): Promise<void>;
  /** Background refresh of the current session. */
  refresh(): Promise<void>;
  /** Stops publishing. Answers still in flight are dropped. */
  dispose(): void;
}

/** Creates the controller. `changed` receives every view to draw, or undefined to hide. */
export function createSidebarState(
  source: SidebarSource,
  changed: (view: SessionRefView | undefined) => void
): SidebarController {
  let session: string | undefined;
  let view: SessionRefView | undefined;
  let disposed = false;
  let issued = 0;
  let applied = 0;
  let polling: Promise<void> | undefined;
  let again = false;

  /** Runs one call and publishes its answer unless a newer one, a switch or disposal beat it. */
  async function request(method: keyof SidebarSource, sessionID: string): Promise<void> {
    const sequence = ++issued;
    let next: SessionRefView | undefined;
    try {
      next = await source[method](sessionID);
    } catch {
      // Keep what is on screen: a failed call is usually transient and the next poll retries.
      return;
    }
    // A slow refresh can finish after a later `refs` call or after the user moved to another
    // session; drawing it then would show older or foreign refs.
    if (disposed || sessionID !== session || sequence < applied) return;
    applied = sequence;
    view = next;
    changed(next);
  }

  /**
   * One refresh at a time. A request made while one runs (a link added mid-poll) runs once more
   * afterwards, because the running call may have read the session before the change.
   */
  function refresh(): Promise<void> {
    if (disposed || session === undefined) return Promise.resolve();
    if (polling) {
      again = true;
      return polling;
    }
    polling = (async () => {
      do {
        again = false;
        if (session !== undefined) await request('refresh', session);
      } while (again && !disposed);
    })().finally(() => {
      polling = undefined;
    });
    return polling;
  }

  return {
    async show(sessionID) {
      if (disposed) return;
      if (sessionID !== session) {
        session = sessionID;
        if (view !== undefined) {
          view = undefined;
          changed(undefined);
        }
      }
      await request('refs', sessionID);
      await refresh();
    },
    refresh,
    dispose() {
      disposed = true;
    }
  };
}
