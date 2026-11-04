import type { Plugin } from '@opencode/plugin';
import { detectCreated, detectInPrompt, detectInText, isCloseCommand } from '../refs/detect.js';
import type { EventContext, HandledEvent } from './events.js';
import { linkDetected, resolveRepo } from './links.js';
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
    onShell(runtime, context, event.sessionID, command, output).catch((error: unknown) =>
      warn('Handling a shell command failed', error)
    );
  });
}

/** Links refs a shell command created and refreshes refs it may have merged or closed. */
async function onShell(
  runtime: Runtime,
  context: Plugin.Context,
  sessionID: string,
  command: string,
  output: string
): Promise<void> {
  const created = detectCreated(runtime.definitions, command, output);
  await linkDetected(runtime, context.session, sessionID, created, 'created');
  if (isCloseCommand(runtime.definitions, command)) {
    refreshInBackground(runtime, context.session, [sessionID], true);
  }
}

/**
 * Handles one subscribed event: refs in user prompts (bare `#N` included, resolved against the
 * session's repository) and full refs in finished assistant text.
 */
export async function handleEvent(
  runtime: Runtime,
  event: HandledEvent,
  context: EventContext
): Promise<void> {
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
