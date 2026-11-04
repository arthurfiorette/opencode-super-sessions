import { spawn } from 'node:child_process';
import { childDirectory, childEnvironment } from './environment.js';

export interface RunOptions {
  /** Defaults to {@link childDirectory}, never the daemon's working directory. */
  cwd?: string;
  timeoutMs: number;
  /** Written to stdin, which is then closed. Without it stdin is closed immediately. */
  input?: string;
  /** Added on top of the sanitized {@link childEnvironment}. */
  env?: Record<string, string>;
  /** Per stream. The child is killed once either stream passes it. Defaults to 8 MiB. */
  maxOutputBytes?: number;
}

/**
 * Why a run did not complete normally. `missing` covers an executable that does not exist or
 * cannot be executed, so callers can report a missing tool instead of a generic failure.
 */
export type RunFailure = 'missing' | 'timeout' | 'overflow' | 'error';

export interface RunResult {
  /** Exit code, or null when the process was killed or never started. */
  code: number | null;
  stdout: string;
  stderr: string;
  failure?: RunFailure;
}

export type Runner = (command: string, args: string[], options: RunOptions) => Promise<RunResult>;

// Grace period between SIGTERM and SIGKILL for children that ignore the first signal.
const KILL_GRACE_MS = 2000;
const MISSING_CODES = new Set(['ENOENT', 'EACCES', 'ENOTDIR', 'EISDIR']);

/**
 * Runs an executable without a shell and with a sanitized environment. Resolves on every outcome,
 * including non-zero exits, timeouts and spawn errors, so callers classify results instead of
 * catching.
 */
export const run: Runner = (command, args, options) =>
  new Promise((resolve) => {
    const limit = options.maxOutputBytes ?? 8 * 1024 * 1024;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const size = { stdout: 0, stderr: 0 };
    let failure: RunFailure | undefined;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn(command, args, {
      cwd: options.cwd ?? childDirectory(),
      env: { ...childEnvironment(), ...options.env },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs);

    /** Records why the child is being stopped and kills it, escalating if it ignores SIGTERM. */
    const stop = (reason: RunFailure) => {
      failure ??= reason;
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref();
    };

    /** Resolves once; later `close` or `error` events are ignored. */
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        code,
        // Decoded once at the end so multi-byte characters split across chunks stay intact.
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        ...(failure ? { failure } : {})
      });
    };

    /** Buffers a stream up to the output limit. */
    const collect = (name: 'stdout' | 'stderr', chunks: Buffer[]) => (chunk: Buffer) => {
      size[name] += chunk.length;
      if (size[name] > limit) return stop('overflow');
      chunks.push(chunk);
    };

    child.stdout.on('data', collect('stdout', stdout));
    child.stderr.on('data', collect('stderr', stderr));
    child.on('error', (error: NodeJS.ErrnoException) => {
      // Spawn errors arrive before any pid exists; later errors (a failed kill) keep the exit path.
      if (child.pid !== undefined) return;
      failure ??= MISSING_CODES.has(error.code ?? '') ? 'missing' : 'error';
      finish(null);
    });
    child.on('close', (code, signal) => {
      if (signal && !failure) failure = 'error';
      finish(code);
    });

    // A child that exits without reading stdin makes the write fail with EPIPE; the exit code
    // already tells the caller what happened.
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
  });

/**
 * Creates a FIFO limiter that runs at most `max` tasks at once. Shared by every Location through
 * the process-global provider, so the cap applies to the whole daemon.
 */
export function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];

  /** Starts the next queued task when a slot is free. */
  const next = () => {
    if (active >= max) return;
    const start = queue.shift();
    if (!start) return;
    active++;
    start();
  };

  return (task) =>
    new Promise((resolve, reject) => {
      queue.push(() => {
        // Wrapped so a task that throws synchronously still releases its slot.
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}
