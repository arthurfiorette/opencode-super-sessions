import type { Plugin } from '@opencode/plugin';
import { latestRunStart, postNotice, sendsNow } from '../host/session-api.js';
import { type RefSource, readSessionRefs, type SessionRefs } from '../refs/ref.js';
import { storedLinks } from '../refs/store.js';
import { linkedItems } from './linked.js';
import { type Runtime, warn } from './runtime.js';
import { storedView } from './views.js';

// Tells the agent about work linked without it: refs and tracker links from user messages, links
// the user made in the browser, and issues a tracked pull request closes. Without it the agent
// learns of them only from a link_work result, and a link it would have called unrelated stays
// on the session. Its own links and what it created are left out: it made them.

/** Sources told in a notice; the others come from the agent's own calls and commands. */
const TOLD: ReadonlySet<RefSource> = new Set(['prompt', 'manual', 'closes']);

// How long before the previous run started its user message may have been linked. Detection
// stamps a link after the message is queued, which is a moment before the run it starts.
const PREVIOUS_MESSAGE = 60_000;

/**
 * Registers the `prompt` hook that posts the notice right before a user message, when that
 * message is what the model reads next (see {@link sendsNow}), so the notice never makes a
 * request of its own. Links made while no such message comes wait for one.
 */
export async function registerNotices(runtime: Runtime, context: Plugin.Context): Promise<void> {
  await context.session.hook('prompt', async (event) => {
    if (!runtime.options.notices) return;
    // A failure here must not hold up or fail the user's message.
    await notice(runtime, context, event).catch((error: unknown) =>
      warn(`Telling the agent about links of ${event.sessionID} failed`, error)
    );
  });
}

/** Posts the links not told yet, if any, and records them as told. */
async function notice(
  runtime: Runtime,
  context: Plugin.Context,
  event: Parameters<typeof sendsNow>[0]
): Promise<void> {
  const info = await context.session.get({ sessionID: event.sessionID });
  // A subagent's prompts come from its parent agent, which knows what it passed.
  if (info.parentID !== undefined || !sendsNow(event, info)) return;
  // Stored links and cached states only: the user's message waits for this hook.
  const items = linkedItems(storedView(runtime, readSessionRefs(info.metadata)));
  const told: string[] = [];
  // Read and marked in one queued write, so two quick messages never tell the same link twice.
  // Marked before posting: a failed post loses the notice rather than risk repeating it.
  await runtime.writes.update(context.session, event.sessionID, (refs) => {
    const fresh = untold(refs);
    // A session no notice reached yet, such as one from before notices, is told only what came
    // with or after its previous message; the rest is marked told, not listed.
    const since =
      refs.noticed === undefined
        ? (latestRunStart(info) ?? info.time.created) - PREVIOUS_MESSAGE
        : Number.NEGATIVE_INFINITY;
    const silent = fresh.filter((link) => link.linkedAt < since).map((link) => link.key);
    const known = new Set(fresh.filter((link) => link.linkedAt >= since).map((link) => link.key));
    told.push(...items.filter((item) => known.has(item.key)).map((item) => item.key));
    if (told.length === 0 && silent.length === 0) return { next: refs, changed: false };
    // Keys no longer linked are dropped, so the list stays as short as the links.
    const linked = new Set(storedLinks(refs).map((link) => link.key));
    const noticed = [...(refs.noticed ?? []).filter((key) => linked.has(key)), ...silent, ...told];
    return { next: { ...refs, noticed }, changed: true };
  });
  const shown = items.filter((item) => told.includes(item.key));
  if (shown.length === 0) return;
  await postNotice(context.session, event.sessionID, {
    description: `Linked ${shown.map((item) => item.label).join(', ')}`,
    text: [
      'Linked to this session without link_work:',
      ...shown.map((item) => `- ${item.line}`),
      "Unlink with unlink_work any that are not part of this session's work, such as one the user only asked about."
    ].join('\n')
  });
}

/** Tracked links of the told sources that no notice has named yet. */
function untold(refs: SessionRefs): Array<{ key: string; linkedAt: number }> {
  const noticed = new Set(refs.noticed);
  return storedLinks(refs).filter((link) => TOLD.has(link.source) && !noticed.has(link.key));
}
