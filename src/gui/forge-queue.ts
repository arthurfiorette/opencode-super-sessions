// The window's calls that wait on a forge (`refresh`, `pull.details`) outside the browser. The
// app lets four requests per server run at once (packages/app/src/runtime/server/request-queue-
// machine.ts:4 at v2.4.2), and a `pull.details` can take 15 s, so the Work lists, headers and the
// pill of every open tab together held all four slots and the browser's own reads waited behind
// them. They run one at a time per server here instead, which leaves the other slots to
// everything else. Servers do not share slots, so each has its own line.

/** Runs forge-bound calls one at a time per server, in call order. */
export interface ForgeQueue {
  /**
   * Runs `task` once the calls before it on `server` (a `ServerRef.id`) finished. A `signal` that
   * aborts while the task waits drops it with the signal's reason; the task gets the signal to
   * pass on to its request.
   */
  run<T>(server: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

/** Creates an empty {@link ForgeQueue}. Call it once per window. */
export function createForgeQueue(): ForgeQueue {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run(server, task, signal) {
      const result = (tails.get(server) ?? Promise.resolve()).then(() => {
        signal?.throwIfAborted();
        return task();
      });
      // The next call waits for this one whatever its outcome.
      tails.set(
        server,
        result.catch(() => {})
      );
      return result;
    }
  };
}
