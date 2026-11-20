import type { Context, ServerRef, SessionRef } from '@opencode/plugin/gui';
import { builtinServer } from '../host/gui.js';
import { pluginRpc, type SuperSessionsClient, serverPluginMissing } from '../host/rpc.js';

// Which server the GUI asks, and how. The desktop app can list several servers, and each session
// belongs to one; this plugin's server half answers only on servers where it is installed.

export { serverPluginMissing };

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
 * answers for it, as the TUI does.
 */
export function at(directory: string): { location: { directory: string } } {
  return { location: { directory } };
}
