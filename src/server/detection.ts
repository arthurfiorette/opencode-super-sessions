import type { Plugin } from '@opencode/plugin';
import { assistantText, shellRun, userPrompt } from '../host/events.js';
import { shellCall } from '../host/tool-hook.js';
import type { RepoRef } from '../providers/provider.js';
import { detectCreated, detectInPrompt, detectInText, isCloseCommand } from '../refs/detect.js';
import { pushedBranches, runsPush } from '../refs/push.js';
import { addPushed } from '../refs/store.js';
import type { EventContext, HandledEvent } from './events.js';
import { linkDetected, resolveRepo } from './links.js';
import type { SessionAccess } from './queue.js';
import { type Runtime, warn } from './runtime.js';
import { refreshInBackground } from './views.js';

/**
 * Registers the shell hook for one Location. Hooks are Location-scoped in the host
 * (`PluginHooks` is a Location node), so each tool call reaches exactly one Location's hook and
 * needs no cross-Location dedupe.
 */
export async function registerShellHook(runtime: Runtime, context: Plugin.Context): Promise<void> {
  await context.tool.hook('execute.after', (event) => {
    const call = shellCall(event);
    if (call === undefined) return;
    // Not awaited: the agent should not wait on GitHub for its shell result.
    onShell(runtime, context.session, call.sessionID, call.command, call.output).catch(
      (error: unknown) => warn('Handling a shell command failed', error)
    );
  });
}

/**
 * Links refs a shell command created, records branches it pushed and refreshes refs it may have
 * merged or closed. Called by the agent's shell tool hook and by `session.shell.ended` for `!`
 * commands, which never reach the hook, so each run reaches this once.
 */
async function onShell(
  runtime: Runtime,
  session: SessionAccess,
  sessionID: string,
  command: string,
  output: string
): Promise<void> {
  const created = detectCreated(runtime.definitions, command, output);
  await Promise.all([
    linkDetected(runtime, session, sessionID, created, 'created'),
    // A failed push record must not stop the refresh below.
    recordPush(runtime, session, sessionID, command, output).catch((error: unknown) =>
      warn(`Recording a push in ${sessionID} failed`, error)
    )
  ]);
  if (isCloseCommand(runtime.definitions, command)) {
    refreshInBackground(runtime, session, [sessionID], true);
  }
}

/**
 * Records the branches a `git push` wrote in the session's metadata, so the branch pull request
 * counts for the session even when another session opened it. Without git's report in the
 * output, the branch checked out in the session's directory stands in for the push's target.
 */
async function recordPush(
  runtime: Runtime,
  session: SessionAccess,
  sessionID: string,
  command: string,
  output: string
): Promise<void> {
  if (!runsPush(command)) return;
  const info = await session.get({ sessionID });
  // Read again rather than from the 10 second cache: the same script may have switched branches
  // right before it pushed.
  const current = (await resolveRepo(runtime, info.location.directory, { force: true })).branch;
  const branches = pushedBranches(command, output, current);
  if (branches.length === 0) return;
  await runtime.writes.update(session, sessionID, (refs) => addPushed(refs, branches));
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
    const run = shellRun(event);
    await onShell(runtime, context.session, run.sessionID, run.command, run.output);
    return;
  }
  // Not awaited and never throws: the index opens lazily, and link detection must not wait on it.
  indexEvent(runtime, event).catch((error: unknown) =>
    warn('Indexing a message for search failed', error)
  );
  if (event.type === 'session.deleted') return;
  if (event.type === 'session.inbox.enqueued') {
    const prompt = userPrompt(event);
    if (!runtime.options.detect.prompts || prompt === undefined) return;
    const info = await context.session.get({ sessionID: prompt.sessionID });
    const base = (await resolveRepo(runtime, info.location.directory)).repo;
    await linkPrompt(runtime, context.session, prompt.sessionID, prompt.text, base);
    return;
  }
  if (!runtime.options.detect.mentions) return;
  const text = assistantText(event);
  const candidates = detectInText(runtime.definitions, text.text);
  await linkDetected(runtime, context.session, text.sessionID, candidates, 'mention');
}

/** Links the refs in a user prompt, resolving bare numbers against `base`, the session's repository. */
export async function linkPrompt(
  runtime: Runtime,
  session: SessionAccess,
  sessionID: string,
  text: string,
  base: RepoRef | undefined
): Promise<void> {
  const { candidates, bare } = detectInPrompt(runtime.definitions, text, base);
  await linkDetected(runtime, session, sessionID, candidates, 'prompt', bare);
}

/** Keeps the message index current, under the keys the backfill derives from stored messages. */
async function indexEvent(
  runtime: Runtime,
  event: Exclude<HandledEvent, { type: 'session.shell.ended' }>
): Promise<void> {
  const index = await runtime.bodyIndex();
  if (event.type === 'session.deleted') {
    index.removeSession(event.data.sessionID);
    return;
  }
  const entry = event.type === 'session.inbox.enqueued' ? userPrompt(event) : assistantText(event);
  if (entry !== undefined) index.add(entry.sessionID, entry.key, entry.text, entry.created);
}
