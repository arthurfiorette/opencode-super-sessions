import type { SessionInfo } from '@opencode/client';
import type { Plugin } from '@opencode/plugin';
import { lastUserMessageAt } from '../host/events.js';
import { activityTime, latestRunStart } from '../host/session-api.js';
import { createLimiter } from '../process.js';
import type { DoneFact } from '../rpc.js';
import type { Runtime } from './runtime.js';

// Reads of `session.context` at once. Each one parses a session's messages since its last
// compaction on the daemon's event loop, so a browser with forty Done candidates would otherwise
// stall every client for the whole batch.
const CONTEXT_READS = 4;
// Sessions read at once before yielding to the event loop, as `collectViews` reads them.
const READ_CHUNK = 25;

/** The parts of a Location's context {@link doneFacts} and {@link hasPending} use. */
export type DoneContext = Pick<Plugin.Context, 'location' | 'permission'> & {
  readonly session: Pick<Plugin.Context['session'], 'get' | 'context'>;
};

/**
 * What the Done rule needs beyond refs, for each existing session: whether a permission request
 * or a question waits on it, and when the user last wrote. Asking the host for these per session
 * over HTTP boots every evicted Location on the way, so they come from the runtime's event
 * trackers, the handler's own Location's permission list, and one in-process context read per
 * session that ran since it was last read. Unknown ids are left out.
 */
export async function doneFacts(
  runtime: Runtime,
  context: DoneContext,
  sessionIDs: string[]
): Promise<Record<string, DoneFact>> {
  const limit = createLimiter(CONTEXT_READS);
  const unique = [...new Set(sessionIDs)];
  const found: Array<readonly [string, DoneFact] | undefined> = [];
  // The host reads each session from its database on the daemon's event loop, so 200 reads
  // started together would run as one long task that every client of the daemon waits behind.
  for (let start = 0; start < unique.length; start += READ_CHUNK) {
    if (start > 0) await new Promise((resolve) => setImmediate(resolve));
    const chunk = unique.slice(start, start + READ_CHUNK);
    found.push(
      ...(await Promise.all(
        chunk.map(async (id) => {
          const info = await context.session.get({ sessionID: id }).catch(() => undefined);
          if (info === undefined) return undefined;
          const pending = await hasPending(runtime, context, id, info);
          const at = await limit(() => lastPrompt(runtime, context.session, info));
          const fact: DoneFact =
            at === undefined ? { pending } : { pending, lastUserMessageAt: at };
          return [id, fact] as const;
        })
      ))
    );
  }
  return Object.fromEntries(found.filter((entry) => entry !== undefined));
}

/**
 * Whether a permission request or a question waits on the session, like the TUI's recheck before
 * it archives. The trackers cover every Location; `context.permission.list` lists only the
 * handler's own Location's requests, so it confirms them there and a request the tracker missed
 * still counts. Without `info` the list is asked for any session, as the sweep does. A failed
 * read counts as waiting.
 */
export async function hasPending(
  runtime: Runtime,
  context: Pick<Plugin.Context, 'location' | 'permission'>,
  sessionID: string,
  info?: Pick<SessionInfo, 'location'>
): Promise<boolean> {
  if (runtime.forms.has(sessionID) || runtime.permissions.has(sessionID)) return true;
  if (info !== undefined && info.location.directory !== context.location.directory) return false;
  try {
    return (await context.permission.list({ sessionID })).length > 0;
  } catch {
    return true;
  }
}

/**
 * The time of the session's last user message, from the runtime's cache while the session has
 * not run since. A user message starts a run, which moves the activity time; after a compaction
 * without one, the latest run start bounds it (see `lastUserMessageAt`). Null when unknown,
 * including a failed read, which is not cached.
 */
async function lastPrompt(
  runtime: Runtime,
  session: Pick<Plugin.Context['session'], 'context'>,
  info: SessionInfo
): Promise<number | null | undefined> {
  const activity = activityTime(info);
  const cached = runtime.lastPrompts.get(info.id);
  if (cached?.activity === activity) return cached.at;
  try {
    const messages = await session.context({ sessionID: info.id });
    const at = lastUserMessageAt(messages, latestRunStart(info));
    runtime.lastPrompts.set(info.id, { activity, at });
    return at;
  } catch {
    return null;
  }
}
