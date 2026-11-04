// How a plugin RPC error reaches the client. The rejection is `unknown` in the client types;
// test/fixtures/configured-host.mjs reads real `link` errors through this accessor. Line numbers
// refer to the OpenCode repository at v2.2.5.

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
