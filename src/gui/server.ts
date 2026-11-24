import type { RpcCallOptions } from '@opencode/client';
import type { Context, ServerRef, SessionRef } from '@opencode/plugin/gui';
import { builtinServer } from '../host/gui.js';
import { pluginRpc, type SuperSessionsClient, serverPluginMissing } from '../host/rpc.js';

// Which server the GUI asks, and how. The desktop app can list several servers, and each session
// belongs to one; this plugin's server half answers only on servers where it is installed.

export { serverPluginMissing };

/** How long a directory whose lookup failed sends its RPCs to the default Location. */
const UNREACHABLE_RETRY = 60_000;

/** A directory's Location lookup: whether it resolved, and when it failed. */
interface Lookup {
  readonly reachable: Promise<boolean>;
  failedAt?: number;
}

// Location lookups per client, by directory. Keyed by client, so windows never share entries and
// a restarted or re-authenticated server, which gets a new client, looks again.
const lookups = new WeakMap<object, Map<string, Lookup>>();

/**
 * The server to ask about a session: its own, or without one (Home, a draft) the app's own
 * server, which runs this plugin's server half. Undefined before the app interface mounts.
 */
export function serverFor(
  ctx: Pick<Context, 'servers'>,
  session?: Pick<SessionRef, 'server'>
): ServerRef | undefined {
  return session?.server ?? builtinServer(ctx.servers);
}

/**
 * This plugin's RPC on a server. Build it where you call it: a restarted or re-authenticated
 * server gets a new `client` under the same ref. Calls wait for the Location's plugins to load;
 * one that fails with {@link serverPluginMissing} ran on a server without the server half.
 */
export function rpcOn(server: ServerRef): SuperSessionsClient {
  return pluginRpc(server.client);
}

/**
 * Call options that send an RPC to a directory's Location, where the session's own Location
 * answers for it, as the TUI does. A directory whose `location.get` failed, such as a worktree
 * the cleanup removed, gets no `location`, so the server's default Location answers instead
 * (`src/page/model.ts` does the same with the TUI's own Location). A failed directory is looked
 * up again after {@link UNREACHABLE_RETRY}.
 */
export async function rpcAt(server: ServerRef, directory: string): Promise<RpcCallOptions> {
  const client = server.client;
  let known = lookups.get(client);
  if (known === undefined) {
    known = new Map();
    lookups.set(client, known);
  }
  let lookup = known.get(directory);
  if (lookup?.failedAt !== undefined && Date.now() - lookup.failedAt > UNREACHABLE_RETRY) {
    lookup = undefined;
  }
  if (lookup === undefined) {
    const entry: Lookup = {
      reachable: client.location.get({ location: { directory } }).then(
        () => true,
        () => {
          entry.failedAt = Date.now();
          return false;
        }
      )
    };
    lookup = entry;
    known.set(directory, entry);
  }
  return (await lookup.reachable) ? { location: { directory } } : {};
}
