import type { Plugin } from '@opencode/plugin';
import { postNotice, sendsNow } from '../host/session-api.js';
import { refKey, type SessionRefs } from '../refs/ref.js';
import { recognizeLink } from '../refs/work-link.js';
import { linkedItems } from './linked.js';
import { type Runtime, warn } from './runtime.js';
import { buildViews } from './views.js';

// Tells the agent about work linked without it: refs and tracker links from the user's messages,
// links the user made in the browser, and issues a tracked pull request closes. Without it the
// agent learns of them only from a link_work result, and a link it would have called unrelated
// stays on the session. The agent's own links and what it created are left out: it made them.

/** Sources told in a notice; the others come from the agent's own calls and commands. */
const TOLD = new Set(['prompt', 'manual', 'closes']);

/**
 * Registers the `prompt` hook that posts the notice right before a user message that goes to the
 * model now, so it rides on that request and never makes one of its own (see {@link sendsNow}).
 * Links made while no such message comes stay untold until one does.
 */
export async function registerNotices(runtime: Runtime, context: Plugin.Context): Promise<void> {
  await context.session.hook('prompt', async (event) => {
    if (!runtime.options.notices || !sendsNow(event)) return;
    // A failure here must not hold up or fail the user's message.
    await notice(runtime, context, event.sessionID).catch((error: unknown) =>
      warn(`Telling the agent about links of ${event.sessionID} failed`, error)
    );
  });
}

/** Posts the links made since the last notice, if any, and records that they were told. */
async function notice(runtime: Runtime, context: Plugin.Context, sessionID: string) {
  const info = await context.session.get({ sessionID });
  const keys = new Set<string>();
  const now = Date.now();
  // Read and marked in one queued write, so two quick messages never tell the same link twice.
  await runtime.writes.update(context.session, sessionID, (refs) => {
    for (const key of untold(refs, refs.noticedAt ?? info.time.created)) keys.add(key);
    return keys.size === 0
      ? { next: refs, changed: false }
      : { next: { ...refs, noticedAt: now }, changed: true };
  });
  if (keys.size === 0) return;
  // Cached states only: the user's message waits for this hook.
  const view = (await buildViews(runtime, context.session, [sessionID], { wait: false }))[
    sessionID
  ];
  const items = view === undefined ? [] : linkedItems(view).filter((item) => keys.has(item.key));
  if (items.length === 0) return;
  await postNotice(context.session, sessionID, {
    description: `Linked ${items.map((item) => item.label).join(', ')}`,
    text: [
      'Linked to this session automatically:',
      ...items.map((item) => `- ${item.line}`),
      'Unlink with unlink_work any that this session does not work on.'
    ].join('\n')
  });
}

/** Keys of links of the told sources made after `since` that are not dismissed. */
function untold(refs: SessionRefs, since: number): string[] {
  const dismissed = new Set(refs.dismissed);
  return [
    ...refs.links.flatMap((link) =>
      TOLD.has(link.source) && link.linkedAt > since ? [refKey(link.ref)] : []
    ),
    ...(refs.urls ?? []).flatMap((link) => {
      const key = recognizeLink(link.url)?.key;
      return key !== undefined && TOLD.has(link.source) && link.linkedAt > since ? [key] : [];
    })
  ].filter((key) => !dismissed.has(key));
}
