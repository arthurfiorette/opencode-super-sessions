import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { OpenCodeEvent, SessionInfo, SessionMessageInfo } from '@opencode/client';
import { Plugin } from '@opencode/plugin';
import {
  ANSWER,
  createHost,
  directory,
  GENERATED_TITLE,
  REASONING,
  SHELL_COMMAND,
  SHELL_OUTPUT,
  startScriptedModel,
  until
} from './harness.js';

// Host behavior the server plugin and the TUI read at runtime. Types catch renamed fields when the
// `@opencode/*` pins move; these tests catch the same field carrying something else, an event
// that stops firing, or an API that changes meaning (merge instead of replace, a filter that no
// longer matches), none of which a type or a user would notice until refs go missing.

/** The `execute.after` payload, reduced to what src/server/detection.ts reads. */
interface HookEvent {
  tool: string;
  sessionID: string;
  input: unknown;
  status: 'completed' | 'error';
  result?: { output?: unknown };
}

const hooks: HookEvent[] = [];
const events = new Map<string, OpenCodeEvent>();
let probe: Plugin.Context | undefined;

// Records what the plugin would see through the same context APIs it uses. `setup` runs once per
// Location and every Location's subscription sees every event, so events are keyed by id.
const recorder = Plugin.define({
  id: 'contract-probe',
  async setup(context) {
    probe ??= context;
    await context.tool.hook('execute.after', (event) => {
      hooks.push(structuredClone(event));
    });
    const abort = new AbortController();
    void (async () => {
      for await (const event of context.event.subscribe({ signal: abort.signal })) {
        events.set(event.id, event);
      }
    })().catch(() => {});
    return () => abort.abort();
  }
});

let model: Awaited<ReturnType<typeof startScriptedModel>>;
let host: Awaited<ReturnType<typeof createHost>>;

before(async () => {
  model = await startScriptedModel();
  host = await createHost(model.baseURL, [recorder]);
});

after(async () => {
  await host?.close();
  await model?.close();
});

/** Waits for a recorded event of `type` that `matches` accepts. */
function event<Type extends OpenCodeEvent['type']>(
  type: Type,
  matches: (event: Extract<OpenCodeEvent, { type: Type }>) => boolean
) {
  const find = () =>
    [...events.values()].find(
      (item): item is Extract<OpenCodeEvent, { type: Type }> =>
        item.type === type && matches(item as Extract<OpenCodeEvent, { type: Type }>)
    );
  return until(find, (found) => found !== undefined) as Promise<
    Extract<OpenCodeEvent, { type: Type }>
  >;
}

/** Runs one scripted agent turn (reasoning, a shell call, reasoning, text) to completion. */
async function agentRun(name: string, text: string) {
  const session = await host.sessions.create({ location: { directory: directory(name) } });
  await host.sessions.prompt({ sessionID: session.id, text });
  await event('session.execution.succeeded', (item) => item.data.sessionID === session.id);
  return session.id;
}

/** All messages of a session, oldest first. */
async function messages(sessionID: string): Promise<SessionMessageInfo[]> {
  return (await host.message.list({ sessionID, order: 'asc' })).data;
}

test('an agent shell call reaches execute.after as tool shell with the command and output detection reads', {
  timeout: 60_000
}, async () => {
  const sessionID = await agentRun('hook', 'run the command');
  const hook = hooks.find((item) => item.sessionID === sessionID);
  assert.ok(hook, 'execute.after did not fire for the agent shell call');
  assert.equal(hook.tool, 'shell');
  assert.equal(hook.status, 'completed');
  // src/server/detection.ts reads these four fields and drops the call when any is off.
  assert.deepEqual(hook.input, { command: SHELL_COMMAND });
  const output = (hook.result?.output ?? {}) as Record<string, unknown>;
  assert.match(String(output.output), new RegExp(SHELL_OUTPUT));
  assert.notEqual(output.status, 'running');
});

test('prompt and text events carry the text detection reads and the ids the backfill derives', {
  timeout: 60_000
}, async () => {
  const prompt = 'Fix https://github.com/acme/widgets/issues/7 please';
  const sessionID = await agentRun('events', prompt);

  const enqueued = await event(
    'session.inbox.enqueued',
    (item) => item.data.sessionID === sessionID
  );
  assert.equal(enqueued.data.item.type, 'user');
  assert.equal(enqueued.data.item.type === 'user' && enqueued.data.item.payload.text, prompt);
  const ended = await event('session.text.ended', (item) => item.data.sessionID === sessionID);
  assert.equal(ended.data.text, ANSWER);

  // Live indexing keys a prompt by its inbox id and a text by `<assistant id>:<text ordinal>`;
  // the backfill rebuilds those keys from `session.context`. A mismatch indexes everything twice.
  const context: SessionMessageInfo[] = await host.sessions.context({ sessionID });
  const user = context.find((message) => message.type === 'user');
  assert.equal(user?.id, enqueued.data.inboxID);
  assert.equal(user?.type === 'user' && user.text, prompt);
  const answer = context.find((message) => message.id === ended.data.assistantMessageID);
  assert.ok(answer?.type === 'assistant', 'session.context has no message with the text event id');
  const texts = answer.content.filter((part) => part.type === 'text');
  // The answer follows a reasoning part, so its content index is 1 and its text ordinal is 0.
  assert.equal(answer.content.indexOf(texts[ended.data.ordinal] as never), 1);
  assert.equal(texts[ended.data.ordinal]?.text, ANSWER);
});

test('message.list returns the transcript shapes the preview draws, in pages that join up', {
  timeout: 60_000
}, async () => {
  const sessionID = await agentRun('transcript', 'show me a transcript');
  const all = await messages(sessionID);

  const [toolStep, answerStep] = all.filter((message) => message.type === 'assistant');
  assert.ok(toolStep?.type === 'assistant' && answerStep?.type === 'assistant');
  // The preview draws a step footer only for terminal finishes (transcript-model.ts NON_TERMINAL).
  assert.equal(toolStep.finish, 'tool-calls');
  assert.equal(answerStep.finish, 'stop');
  assert.deepEqual(
    toolStep.content.map((part) => part.type),
    ['reasoning', 'tool']
  );
  const reasoning = toolStep.content[0];
  assert.equal(reasoning?.type === 'reasoning' && reasoning.text, REASONING);
  const call = toolStep.content[1];
  assert.ok(call?.type === 'tool');
  assert.equal(call.name, 'shell');
  assert.equal(call.state.status, 'completed');
  assert.deepEqual(call.state.status === 'completed' && call.state.input, {
    command: SHELL_COMMAND
  });
  const content = call.state.status === 'completed' ? (call.state.content ?? []) : [];
  assert.match(
    content.map((item) => (item.type === 'text' ? item.text : '')).join(''),
    new RegExp(SHELL_OUTPUT)
  );
  // Without an idle message the preview falls back to legacy turn timing.
  assert.equal(all.at(-1)?.type, 'idle');

  // The Done rule reads the last user message through the type filter.
  const users = await host.message.list({ sessionID, order: 'desc', limit: 1, type: 'user' });
  assert.deepEqual(
    users.data.map((message: SessionMessageInfo) => message.id),
    all.filter((message) => message.type === 'user').map((message) => message.id)
  );

  // The preview loads the newest page, then older ones with the cursor alone.
  const first = await host.message.list({ sessionID, order: 'desc', limit: 2 });
  const cursor = first.cursor.next;
  assert.ok(cursor, 'a partial page has no next cursor');
  const rest = await host.message.list({ sessionID, cursor, limit: 100 });
  assert.deepEqual(
    [...first.data, ...rest.data].map((message) => message.id).reverse(),
    all.map((message) => message.id)
  );
});

test('a user ! command publishes session.shell.ended with its command and output, not execute.after', {
  timeout: 60_000
}, async () => {
  const session = await host.sessions.create({ location: { directory: directory('bang') } });
  await host.sessions.shell({ sessionID: session.id, command: 'echo bang-output' });
  const ended = await event('session.shell.ended', (item) => item.data.sessionID === session.id);
  assert.equal(ended.data.shell.command, 'echo bang-output');
  assert.match(ended.data.output.output, /bang-output/);
  // The shell hook and this event both link `created` refs; firing both would handle a run twice.
  assert.equal(
    hooks.some((item) => item.sessionID === session.id),
    false
  );
});

test('server plugin session.update replaces metadata and session.get returns it with the location', async () => {
  assert.ok(probe);
  const location = { directory: directory('metadata') };
  const session = await host.sessions.create({
    location,
    metadata: { 'another-plugin': { keep: true }, 'super-sessions': { v: 1 } }
  });
  // The write queue in src/server/queue.ts copies other keys because of this replace.
  await probe.session.update({ sessionID: session.id, metadata: { 'super-sessions': { v: 2 } } });
  const info = await probe.session.get({ sessionID: session.id });
  assert.deepEqual(info.metadata, { 'super-sessions': { v: 2 } });
  assert.equal(info.location.directory, location.directory);
  // The sidebar refetches refs on this event.
  await event('session.metadata.updated', (item) => item.data.sessionID === session.id);
});

test('deleting a session publishes session.deleted with its id', async () => {
  const session = await host.sessions.create({ location: { directory: directory('deleted') } });
  await host.sessions.remove({ sessionID: session.id });
  // Pins, the message index and the browser drop the session on this event.
  await event('session.deleted', (item) => item.data.sessionID === session.id);
});

test('the HTTP client archives and restores, and the archived filter follows', async () => {
  const location = { directory: directory('archive') };
  const session = await host.sessions.create({ location });
  const listed = async (archived: boolean) =>
    (await host.sessions.list({ directory: location.directory, archived })).data.map(
      (item: SessionInfo) => item.id
    );

  await host.sessions.update({ sessionID: session.id, archived: true });
  assert.equal(typeof (await host.sessions.get({ sessionID: session.id })).time.archived, 'number');
  assert.deepEqual(await listed(true), [session.id]);
  assert.deepEqual(await listed(false), []);
  await host.sessions.update({ sessionID: session.id, archived: false });
  assert.deepEqual(await listed(false), [session.id]);
  assert.deepEqual(await listed(true), []);
});

test('the HTTP client regenerates a title from an empty one and publishes renames', {
  timeout: 60_000
}, async () => {
  // The title agent needs a conversation to title.
  const sessionID = await agentRun('retitle', 'title me');
  await host.sessions.update({ sessionID, title: 'Manual title' });
  // The archive suffix option watches renames.
  await event(
    'session.renamed',
    (item) => item.data.sessionID === sessionID && item.data.title === 'Manual title'
  );
  // ctrl+t in the browser sends an empty title to ask the host's title agent for a new one.
  await host.sessions.update({ sessionID, title: '' });
  await until(
    async () => (await host.sessions.get({ sessionID })).title,
    (title) => title === GENERATED_TITLE
  );
});

test('session.list scopes by project subpath, directory, title, root sessions and cursor', async () => {
  const repo = directory('repo');
  const app = directory('repo', 'packages', 'app');
  git(repo, 'init', '-q');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  const loose = directory('loose');

  const top = await host.sessions.create({ location: { directory: repo }, title: 'needle top' });
  const nested = await host.sessions.create({
    location: { directory: app },
    title: 'needle nested'
  });
  const child = await host.sessions.create({
    location: { directory: repo },
    parentID: top.id,
    title: 'needle child'
  });
  const other = await host.sessions.create({ location: { directory: loose }, title: 'haystack' });
  const ids = async (input: Parameters<typeof host.sessions.list>[0]) =>
    (await host.sessions.list({ ...input, parentID: null })).data
      .map((item: SessionInfo) => item.id)
      .sort();

  // "This project" in the browser: the host's `global` project filters by directory, any other
  // by project id and the directory's subpath inside it (src/page/model.ts `searchScope`, after
  // the built-in list in packages/tui/src/component/dialog-session-list.tsx). A loose directory
  // gets a project of its own in 2.2.5, so the subpath there is empty.
  const scope = async (target: string) => {
    const info = await host.location.get({ location: { directory: target } });
    if (info.project.id === 'global') return { directory: info.directory };
    return {
      project: info.project.id,
      subpath: path.relative(info.project.directory, info.directory).replaceAll('\\', '/')
    };
  };
  assert.deepEqual(await ids(await scope(repo)), [top.id]);
  assert.deepEqual(await ids(await scope(app)), [nested.id]);
  assert.deepEqual(await ids(await scope(loose)), [other.id]);
  // Server search filters by directory for directory scopes.
  assert.deepEqual(await ids({ directory: loose }), [other.id]);
  assert.deepEqual(await ids({ search: 'needle' }), [top.id, nested.id].sort());

  const { project } = await host.location.get({ location: { directory: repo } });
  const id = project.id;
  assert.deepEqual(await ids({ project: id }), [top.id, nested.id].sort());
  assert.ok(
    (await host.sessions.list({ project: id })).data.some(
      (item: SessionInfo) => item.id === child.id
    ),
    'child sessions vanished without parentID'
  );

  // Archive-marked and the backfill page with the first request's filters plus the cursor.
  const page = { project: id, parentID: null, order: 'desc', limit: 1 } as const;
  const first = await host.sessions.list(page);
  const cursor = first.cursor.next;
  assert.ok(cursor, 'a partial page has no next cursor');
  const second = await host.sessions.list({ ...page, cursor });
  assert.deepEqual(
    [...first.data, ...second.data].map((item) => item.id).sort(),
    [top.id, nested.id].sort()
  );
});

/** Runs git without the developer's hooks, signing or identity. */
function git(cwd: string, ...args: string[]) {
  execFileSync(
    'git',
    [
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=',
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-C',
      cwd,
      ...args
    ],
    { stdio: 'pipe' }
  );
}
