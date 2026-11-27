import type { Plugin } from '@opencode/plugin';
import { lastUserMessageAt } from '../host/events.js';
import { activityTime } from '../host/session-api.js';
import { createLimiter } from '../process.js';
import type { DoneFact } from '../rpc.js';
import type { Runtime } from './runtime.js';

// Reads of `session.context` at once. Each one parses a session's messages since its last
// compaction on the daemon's event loop, so a browser with forty Done candidates would otherwise
// stall every client for the whole batch.
const CONTEXT_READS = 4;

/**
 * What the Done rule needs beyond refs, for each existing session: whether a permission request
 * or a question waits on it, and when the user last wrote. The window and the TUI used to ask the
 * host for these per session over HTTP, which booted every evicted Location on the way; here they
 * come from the runtime's event trackers and one in-process context read per session that ran
 * since it was last read. Unknown ids are left out.
 */
export async function doneFacts(
  runtime: Runtime,
  session: Pick<Plugin.Context['session'], 'get' | 'context'>,
  sessionIDs: string[]
): Promise<Record<string, DoneFact>> {
  const limit = createLimiter(CONTEXT_READS);
  const found = await Promise.all(
    [...new Set(sessionIDs)].map(async (id) => {
      const info = await session.get({ sessionID: id }).catch(() => undefined);
      if (info === undefined) return undefined;
      const pending = runtime.forms.has(id) || runtime.permissions.has(id);
      const at = await limit(() => lastPrompt(runtime, session, id, activityTime(info)));
      const fact: DoneFact = at === undefined ? { pending } : { pending, lastUserMessageAt: at };
      return [id, fact] as const;
    })
  );
  return Object.fromEntries(found.filter((entry) => entry !== undefined));
}

/**
 * The time of the session's last user message, from the runtime's cache while the session has
 * not run since. A user message starts a run, which moves the activity time. Null when unknown,
 * including a failed read, which is not cached.
 */
async function lastPrompt(
  runtime: Runtime,
  session: Pick<Plugin.Context['session'], 'context'>,
  sessionID: string,
  activity: number
): Promise<number | null | undefined> {
  const cached = runtime.lastPrompts.get(sessionID);
  if (cached?.activity === activity) return cached.at;
  try {
    const at = lastUserMessageAt(await session.context({ sessionID }));
    runtime.lastPrompts.set(sessionID, { activity, at });
    return at;
  } catch {
    return null;
  }
}
