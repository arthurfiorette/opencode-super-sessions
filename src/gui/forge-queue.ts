// The window's calls that wait on a forge (`refresh`, `pull.details`) outside the browser. The
// app lets four requests per server run at once (packages/app/src/runtime/server/request-queue-
// machine.ts:4 at v2.4.2), and a `pull.details` can take 15 s, so the Work lists, headers and the
// pill of every open tab together held all four slots and the browser's own reads waited behind
// them. They run one at a time per server here instead, which leaves the other slots to
// everything else. Servers do not share slots, so each has its own line.

/**
 * How long one call may hold its server's line. The server's `gh` and `glab` calls time out at
 * 20 s, so a call past this is hung, and the calls behind it must not wait for it.
 */
const CALL_TIMEOUT = 30_000;

/** Runs forge-bound calls one at a time per server, in call order. */
export interface ForgeQueue {
  /**
   * Runs `task` once the calls before it on `server` (a `ServerRef.id`) finished. A `signal` that
   * aborts while the task waits takes it out of the line at once and rejects with the signal's
   * reason. The task gets a signal that also aborts after {@link CALL_TIMEOUT}, to pass on to its
   * request; once that signal aborts, the next call starts whether or not the task settled.
   */
  run<T>(
    server: string,
    task: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T>;
}

/** One server's line: whether a call holds it, and the calls waiting, oldest first. */
interface Line {
  busy: boolean;
  waiting: Array<() => void>;
}

/** Creates an empty {@link ForgeQueue}. Call it once per window. */
export function createForgeQueue(): ForgeQueue {
  const lines = new Map<string, Line>();

  /** Starts the oldest waiting call of `line` when nothing holds it. */
  const advance = (line: Line) => {
    if (line.busy) return;
    const next = line.waiting.shift();
    if (next === undefined) return;
    line.busy = true;
    next();
  };

  return {
    run(server, task, signal) {
      let line = lines.get(server);
      if (line === undefined) {
        line = { busy: false, waiting: [] };
        lines.set(server, line);
      }
      const own = line;
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const leave = () => {
          const index = own.waiting.indexOf(start);
          if (index === -1) return;
          own.waiting.splice(index, 1);
          reject(signal?.reason);
        };
        const start = () => {
          signal?.removeEventListener('abort', leave);
          const timeout = AbortSignal.timeout(CALL_TIMEOUT);
          const limit = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
          const released = new Promise<never>((_, rejectReleased) => {
            limit.addEventListener('abort', () => rejectReleased(limit.reason), { once: true });
          });
          Promise.race([task(limit), released])
            .then(resolve, reject)
            .finally(() => {
              own.busy = false;
              advance(own);
            });
        };
        signal?.addEventListener('abort', leave, { once: true });
        own.waiting.push(start);
        advance(own);
      });
    }
  };
}
