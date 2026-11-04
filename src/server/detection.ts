import type { Plugin } from '@opencode/plugin';
import { detectCreated, detectInPrompt, detectInText, isCloseCommand } from '../refs/detect.js';
import type { EventContext, HandledEvent } from './events.js';
import { linkDetected, resolveRepo } from './links.js';
import type { SessionAccess } from './queue.js';
import { type Runtime, warn } from './runtime.js';
import { refreshInBackground } from './views.js';

/** Narrows an unknown value to a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Registers the shell hook for one Location. Hooks are Location-scoped in the host
 * (`PluginHooks` is a Location node), so each tool call reaches exactly one Location's hook and
 * needs no cross-Location dedupe.
 */
export async function registerShellHook(runtime: Runtime, context: Plugin.Context): Promise<void> {
  await context.tool.hook('execute.after', (event) => {
    if (event.tool !== 'shell' || event.status !== 'completed') return;
    const command = isRecord(event.input) ? event.input.command : undefined;
    const result = event.result.output;
    // Background commands report `running` with partial output; their URLs are not final.
    if (typeof command !== 'string' || !isRecord(result) || result.status === 'running') return;
    const output = typeof result.output === 'string' ? result.output : '';
    // Not awaited: the agent should not wait on GitHub for its shell result.
    onShell(runtime, context.session, event.sessionID, command, output).catch((error: unknown) =>
      warn('Handling a shell command failed', error)
    );
  });
}

/**
 * Links refs a shell command created and refreshes refs it may have merged or closed. Called by
 * the agent's shell tool hook and by `session.shell.ended` for `!` commands. Core publishes
 * `session.shell.*` only from `Session.shell`, never from the shell tool, so each run reaches
 * this once.
 */
async function onShell(
  runtime: Runtime,
  session: SessionAccess,
  sessionID: string,
  command: string,
  output: string
): Promise<void> {
  const created = detectCreated(runtime.definitions, command, output);
  await linkDetected(runtime, session, sessionID, created, 'created');
  if (isCloseCommand(runtime.definitions, command)) {
    refreshInBackground(runtime, session, [sessionID], true);
  }
}

/**
 * Handles one subscribed event: refs in user prompts (bare `#N` included, resolved against the
 * session's repository), full refs in finished assistant text, and refs created or closed by a
 * user `!` command. Prompts, assistant text and deletions also update the message index.
 */
export async function handleEvent(
  runtime: Runtime,
  event: HandledEvent,
  context: EventContext
): Promise<void> {
  if (event.type === 'session.shell.ended') {
    // Core puts the first MiB of combined stdout and stderr here, and the plugin context has no
    // API to page the rest, so a URL printed past that MiB is missed.
    const { data } = event;
    await onShell(runtime, context.session, data.sessionID, data.shell.command, data.output.output);
    return;
  }
  // Not awaited and never throws: the index opens lazily, and link detection must not wait on it.
  indexEvent(runtime, event).catch((error: unknown) =>
    warn('Indexing a message for search failed', error)
  );
  if (event.type === 'session.deleted') return;
  if (event.type === 'session.inbox.enqueued') {
    if (!runtime.options.detect.prompts || event.data.item.type !== 'user') return;
    const { sessionID } = event.data;
    const info = await context.session.get({ sessionID });
    const base = (await resolveRepo(runtime, info.location.directory)).repo;
    const candidates = detectInPrompt(runtime.definitions, event.data.item.payload.text, base);
    await linkDetected(runtime, context.session, sessionID, candidates, 'prompt');
    return;
  }
  if (!runtime.options.detect.mentions) return;
  const candidates = detectInText(runtime.definitions, event.data.text);
  await linkDetected(runtime, context.session, event.data.sessionID, candidates, 'mention');
}

/**
 * Keeps the message index current. Keys match the ones the backfill derives from stored messages:
 * a user message keeps its inbox id, and assistant text is `<message id>:<text ordinal>`.
 */
async function indexEvent(
  runtime: Runtime,
  event: Exclude<HandledEvent, { type: 'session.shell.ended' }>
): Promise<void> {
  const index = await runtime.bodyIndex();
  if (event.type === 'session.deleted') {
    index.removeSession(event.data.sessionID);
    return;
  }
  if (event.type === 'session.inbox.enqueued') {
    const { item } = event.data;
    if (item.type !== 'user') return;
    index.add(event.data.sessionID, event.data.inboxID, item.payload.text, event.created);
    return;
  }
  const { data } = event;
  index.add(data.sessionID, `${data.assistantMessageID}:${data.ordinal}`, data.text, event.created);
}
