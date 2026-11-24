import { type Context, createKeyed } from '@opencode/plugin/gui';
import { onCleanup } from 'solid-js';
import { openSessionIDs } from '../host/gui.js';
import { rpcOn, serverPluginMissing } from './server.js';

// The window's open session tabs, reported to each server the way a TUI reports its open sessions
// (`installMaintenance` in src/settings/maintenance.ts), so auto-archive and worktree cleanup
// treat a session open in a Desktop tab as open. The window has no pins of its own.

/** A burst of tab changes is reported once, this long after the last, as the TUI does. */
const PRESENCE_DELAY = 1000;
/** Under the server's 15-minute presence expiry, with room for one missed report, as the TUI. */
const HEARTBEAT = 5 * 60_000;
/** The most open sessions one `presence` call takes (`presence` in src/rpc.ts). */
const OPEN_LIMIT = 200;
/** Where the window keeps its client id, so a reload reports under the same id. */
const CLIENT_KEY = 'opencode-super-sessions.presence';

/**
 * This window's presence id. Session storage belongs to the window and survives its reloads, so a
 * reloaded window replaces its own entry instead of leaving one that expires only after 15
 * minutes.
 */
function windowClientID(): string {
  try {
    const stored = sessionStorage.getItem(CLIENT_KEY);
    if (stored) return stored;
    const created = `desktop-${crypto.randomUUID()}`;
    sessionStorage.setItem(CLIENT_KEY, created);
    return created;
  } catch {
    return `desktop-${crypto.randomUUID()}`;
  }
}

/**
 * Reports the window's open session tabs to every server the window lists: once a burst of tab
 * changes settles, and every {@link HEARTBEAT}. A server that answers without the server half is
 * left out until the window reloads. Stops with the plugin (`ctx.signal`), so a closed or
 * reloaded window stops reporting and the server forgets it after 15 minutes.
 */
export function reportPresence(ctx: Pick<Context, 'servers' | 'tabs' | 'signal'>): void {
  const clientID = windowClientID();
  const missing = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** Sends each server the sessions open on it. Failures wait for the next change or heartbeat. */
  const send = () => {
    timer = undefined;
    if (ctx.signal.aborted) return;
    for (const id of ctx.servers.list()) {
      const server = ctx.servers.get(id);
      if (server === undefined || missing.has(id)) continue;
      const open = openSessionIDs(ctx.tabs, id).slice(0, OPEN_LIMIT);
      void Promise.resolve()
        .then(() => rpcOn(server).presence({ clientID, pinned: [], open }))
        .catch((error: unknown) => {
          if (serverPluginMissing(error)) missing.add(id);
        });
    }
  };
  /** Sends once the current burst of changes settles. */
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(send, PRESENCE_DELAY);
  };

  // One key per set of open tabs and servers: a run reports that set, and the next set's run
  // replaces it. Never empty, so a window with no tabs reports too.
  createKeyed(
    () =>
      ctx.servers
        .list()
        .map((id) => `${id}:${openSessionIDs(ctx.tabs, id).join(',')}`)
        .join('\n') || 'none',
    schedule
  );
  const heartbeat = setInterval(schedule, HEARTBEAT);
  const stop = () => {
    clearTimeout(timer);
    clearInterval(heartbeat);
  };
  ctx.signal.addEventListener('abort', stop, { once: true });
  onCleanup(stop);
}
