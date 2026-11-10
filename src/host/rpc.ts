import type { PluginApi, RpcApi, RpcCallOptions, RpcClient } from '@opencode/client';
import { SuperSessions } from '../rpc.js';

// How the TUI reaches the server plugin's RPC, and how its errors come back. The rejection is
// `unknown` in the client types; test/fixtures/configured-host.mjs reads real `link` errors
// through this accessor. Line numbers refer to the OpenCode repository at v2.2.7.

/** The parts of a client {@link pluginRpc} uses: the TUI's, or the SDK host's in tests. */
export interface RpcHost {
  readonly rpc: RpcApi;
  readonly plugin: Pick<PluginApi, 'list'>;
}

export type SuperSessionsClient = RpcClient<typeof SuperSessions>;

// How long a call waits for a cold Location to load its plugins, and how often it looks. The
// host's own one-shot commands use the same numbers (packages/cli/src/services/plugin-startup.ts:9).
const LOAD_WAIT = 5000;
const LOAD_POLL = 25;

// Locations whose plugins have loaded, per client, by directory (`''` for the default one).
const loaded = new WeakMap<RpcHost, Map<string, Promise<void>>>();

/**
 * The plugin's RPC client, whose calls first wait for their Location to load its plugins. Since
 * 2.2.7 the host answers a call on a cold Location with `rpc.unavailable` instead of waiting
 * (packages/server/src/handlers/rpc.ts:8), and a Location starts cold the first time anything
 * asks it, such as the sidebar of a session in another project. A Location lists no plugins until
 * its first activation is done (packages/core/src/plugin.ts:50), so a non-empty list means the
 * server plugin, when installed, has registered its handlers. Without the server plugin the call
 * still fails once the list is in, so the TUI degrades as before.
 */
export function pluginRpc(client: RpcHost): SuperSessionsClient {
  const rpc = client.rpc(SuperSessions);
  const ready = loaded.get(client) ?? new Map<string, Promise<void>>();
  loaded.set(client, ready);
  /** Resolves once the Location has loaded its plugins, or after {@link LOAD_WAIT} regardless. */
  const whenLoaded = (location: RpcCallOptions['location']) => {
    const key = location?.directory ?? '';
    const known = ready.get(key);
    if (known !== undefined) return known;
    const waiting = waitForPlugins(client, location);
    ready.set(key, waiting);
    return waiting;
  };
  return new Proxy(rpc, {
    get(target, name, receiver) {
      const method: unknown = Reflect.get(target, name, receiver);
      if (typeof method !== 'function' || name === 'events') return method;
      return async (input: unknown, options?: RpcCallOptions) => {
        await whenLoaded(options?.location);
        try {
          return await method.call(target, input, options);
        } catch (error) {
          // The host drops idle Locations, so one that loaded before may be cold again: look again
          // on the next call.
          if (rpcError(error).type === 'rpc.unavailable') {
            ready.delete(options?.location?.directory ?? '');
          }
          throw error;
        }
      };
    }
  });
}

/** Polls the Location's plugin list until it has entries, for at most {@link LOAD_WAIT}. */
async function waitForPlugins(
  client: RpcHost,
  location: RpcCallOptions['location']
): Promise<void> {
  const deadline = Date.now() + LOAD_WAIT;
  while (Date.now() < deadline) {
    try {
      const plugins = await client.plugin.list(location === undefined ? {} : { location });
      if (plugins.data.length > 0) return;
    } catch {
      // A Location that fails to list fails the call too, with its own error.
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, LOAD_POLL));
  }
}

/**
 * The `type` and `data` of an error a handler returned with `invocation.error`, which the client
 * rejects with as an `RpcError` (packages/protocol/src/errors.ts:21). Both are undefined for any
 * other failure, such as a daemon without the server plugin.
 */
export function rpcError(error: unknown): { type?: unknown; data?: unknown } {
  if (typeof error !== 'object' || error === null) return {};
  return {
    ...('type' in error ? { type: error.type } : {}),
    ...('data' in error ? { data: error.data } : {})
  };
}
