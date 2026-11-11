import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { OpenCodeEvent, SessionInfo, SessionMessageInfo } from '@opencode/client';
import { Plugin } from '@opencode/plugin';
import {
  assistantText,
  shellRun,
  storedHistory,
  storedTexts,
  userPrompt
} from '../../src/host/events.js';
import {
  activityTime,
  forkSession,
  listFilters,
  postNotice,
  projectScope,
  regenerateTitle,
  sendsNow,
  sessionPrompts,
  sessionScope,
  setArchived
} from '../../src/host/session-api.js';
import { shellCall } from '../../src/host/tool-hook.js';
import { projectWorktrees, removeWorktree } from '../../src/host/worktree.js';
import { markScanned } from '../../src/refs/store.js';
import { createWriteQueue } from '../../src/server/queue.js';
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

// The tests read host payloads through the same src/host accessors the plugin uses, so a failure
// here names the accessor to fix.

const NOTICE_PROMPT = 'Is this related?';
const NOTICE = {
  text: 'Linked to this session without link_work: issue 7',
  description: 'Linked 7'
};

const hooks: Parameters<typeof shellCall>[0][] = [];
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
    // What src/server/notices.ts does, for prompts of the notice test only.
    await context.session.hook('prompt', async (event) => {
      if (event.prompt.text !== NOTICE_PROMPT) return;
      if (!sendsNow(event, await context.session.get({ sessionID: event.sessionID }))) return;
      await postNotice(context.session, event.sessionID, NOTICE);
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

test('an agent shell call reaches execute.after in the shape the shell hook reads', {
  timeout: 60_000
}, async () => {
  const sessionID = await agentRun('hook', 'run the command');
  const calls = hooks.filter((item) => item.sessionID === sessionID).map(shellCall);
  const call = calls.find((item) => item !== undefined);
  assert.ok(call, 'no execute.after event read as a finished shell call');
  assert.equal(call.command, SHELL_COMMAND);
  assert.match(call.output, new RegExp(SHELL_OUTPUT));
});

test('the plugin tells every agent step, once, what it tracks without link_work', {
  timeout: 60_000
}, async () => {
  const before = model.requests.length;
  await agentRun('instruction', 'track this');
  // The run takes two steps (the shell call, then the answer); each is its own request.
  const steps = model.requests.slice(before);
  assert.equal(steps.length, 2);
  for (const step of steps) {
    const system = step.system.join('\n');
    assert.equal(system.split('You MUST call link_work').length - 1, 1, system);
  }
});

// A notice that reached the model on its own would spend a request the user never asked for, and
// one shown as a user message would read as the user's words.
test('a notice posted from the prompt hook reaches the model with the prompt and adds no request', {
  timeout: 60_000
}, async () => {
  const before = model.requests.length;
  const sessionID = await agentRun('notice', NOTICE_PROMPT);
  const steps = model.requests.slice(before);
  assert.equal(steps.length, 2);
  assert.deepEqual(steps[0]?.user.slice(-2), [NOTICE.text, NOTICE_PROMPT]);

  const shown = (await messages(sessionID)).filter(
    (message) => message.type === 'synthetic' || message.type === 'user'
  );
  assert.deepEqual(
    shown.map((message) =>
      message.type === 'synthetic' ? ['synthetic', message.description] : ['user', message.text]
    ),
    [
      ['synthetic', NOTICE.description],
      ['user', NOTICE_PROMPT]
    ]
  );
});

test('prompt and text events carry the text detection reads and the ids the backfill derives', {
  timeout: 60_000
}, async () => {
  const prompt = 'Fix https://github.com/acme/widgets/issues/7 please';
  const sessionID = await agentRun('events', prompt);

  const prompted = userPrompt(
    await event('session.inbox.enqueued', (item) => item.data.sessionID === sessionID)
  );
  assert.equal(prompted?.text, prompt);
  const answered = assistantText(
    await event('session.text.ended', (item) => item.data.sessionID === sessionID)
  );
  assert.equal(answered.text, ANSWER);

  // The backfill rebuilds the index from `session.context`; a key that differs from the live one
  // indexes the same text twice. The answer follows a reasoning part, so a key counting every
  // part instead of text parts only would differ here.
  const stored = storedTexts(sessionID, await host.sessions.context({ sessionID }));
  const byKey = new Map(stored.map((entry) => [entry.key, entry.text]));
  assert.equal(byKey.get(prompted.key), prompt);
  assert.equal(byKey.get(answered.key), ANSWER);
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

  // The history scan reads the same pages for sessions the plugin never saw live.
  const history = storedHistory(all);
  assert.deepEqual(
    history.map((entry) => (entry.type === 'shell' ? entry.command : entry.text)),
    ['show me a transcript', SHELL_COMMAND, ANSWER]
  );
  const shell = history.find((entry) => entry.type === 'shell');
  assert.match(shell?.type === 'shell' ? shell.output : '', new RegExp(SHELL_OUTPUT));

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
  const run = shellRun(
    await event('session.shell.ended', (item) => item.data.sessionID === session.id)
  );
  assert.equal(run.command, 'echo bang-output');
  assert.match(run.output, /bang-output/);
  // The shell hook and this event both link `created` refs; firing both would handle a run twice.
  assert.equal(
    hooks.some((item) => item.sessionID === session.id),
    false
  );
  // The history scan finds the stored command and its output.
  const stored = storedHistory(await messages(session.id)).find((entry) => entry.type === 'shell');
  assert.equal(stored?.type === 'shell' && stored.command, 'echo bang-output');
  assert.match(stored?.type === 'shell' ? stored.output : '', /bang-output/);
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

// The list's order, day groups and ages, and the cleanup inactivity rule, read `activityTime`.
// A metadata write moves `time.updated`; it must not read as the user working in the session.
test('a plugin metadata write leaves activityTime alone, and a prompt moves it', {
  timeout: 60_000
}, async () => {
  // The run starts a Location, whose setup sets the probe.
  const ranID = await agentRun('activity-ran', 'some work');
  assert.ok(probe);
  const context = probe;
  const queue = createWriteQueue();
  const read = (sessionID: string) => context.session.get({ sessionID });
  /** Writes the history scan marker through the plugin's queue and returns the session before and after. */
  const scan = async (sessionID: string) => {
    const before = await read(sessionID);
    await queue.update(context.session, sessionID, (refs) =>
      markScanned(refs, Date.now(), undefined)
    );
    return { before, after: await read(sessionID) };
  };
  /** Prompts and waits until the run moved the activity time past `since`. */
  const prompt = async (sessionID: string, since: number) => {
    await host.sessions.prompt({ sessionID, text: 'more work' });
    await until(
      async () => activityTime(await read(sessionID)),
      (at) => at > since
    );
  };

  // A session that ran: busy and idle record activity.
  const ran = await scan(ranID);
  assert.ok(
    ran.after.time.updated > ran.before.time.updated,
    'the write did not move time.updated'
  );
  assert.equal(activityTime(ran.after), activityTime(ran.before));
  await prompt(ranID, activityTime(ran.after));

  // A session without run times, like one that last ran on a host before them: the queue stamps
  // the activity time the write is about to overwrite.
  const fresh = await host.sessions.create({
    location: { directory: directory('activity-fresh') }
  });
  const stamped = await scan(fresh.id);
  assert.equal(stamped.before.time.idle, undefined);
  assert.ok(
    stamped.after.time.updated > stamped.before.time.updated,
    'the write did not move time.updated'
  );
  assert.equal(activityTime(stamped.after), stamped.before.time.updated);
  await prompt(fresh.id, activityTime(stamped.after));
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

  // The SDK host is the same HTTP client the TUI's `context.client` is.
  await setArchived(host, session.id, true);
  assert.equal(typeof (await host.sessions.get({ sessionID: session.id })).time.archived, 'number');
  assert.deepEqual(await listed(true), [session.id]);
  assert.deepEqual(await listed(false), []);
  await setArchived(host, session.id, false);
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
  await regenerateTitle(host, sessionID);
  await until(
    async () => (await host.sessions.get({ sessionID })).title,
    (title) => title === GENERATED_TITLE
  );
});

test('a fork before a prompt leaves it and later messages out, and a full fork copies them all', {
  timeout: 60_000
}, async () => {
  const sessionID = await agentRun('fork', 'first prompt');
  await host.sessions.prompt({ sessionID, text: 'second\nprompt' });
  await until(
    () => messages(sessionID),
    (all) => all.filter((message) => message.type === 'idle').length === 2
  );
  const prompts = await sessionPrompts(host, sessionID);
  assert.deepEqual(
    prompts.map((prompt) => prompt.text),
    ['second\nprompt', 'first prompt']
  );
  const userTexts = async (id: string) =>
    (await messages(id)).flatMap((message) => (message.type === 'user' ? [message.text] : []));

  const before = await forkSession(host, sessionID, prompts[0]?.id);
  assert.notEqual(before.id, sessionID);
  // The browser reloads its lists on this event; a fork publishes no `session.created`.
  await event('session.forked', (item) => item.data.sessionID === before.id);
  assert.deepEqual(await userTexts(before.id), ['first prompt']);
  assert.ok(
    (await messages(before.id)).some((message) => message.type === 'assistant'),
    'the answer to the first prompt was not copied'
  );
  const full = await forkSession(host, sessionID);
  assert.deepEqual(await userTexts(full.id), ['first prompt', 'second\nprompt']);

  // sessionPrompts asks for `type` again on every page, since the cursor does not carry it.
  const page = { sessionID, type: 'user', limit: 1 } as const;
  const first = await host.message.list({ ...page, order: 'desc' });
  const cursor = first.cursor.next;
  assert.ok(cursor);
  const second = await host.message.list({ ...page, cursor });
  assert.deepEqual(
    [...first.data, ...second.data].map((message: SessionMessageInfo) => message.id),
    prompts.map((prompt) => prompt.id)
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

  // "This project" in the browser lists exactly the sessions of that directory.
  const scope = async (target: string) =>
    listFilters(projectScope(await host.location.get({ location: { directory: target } })));
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

// After a restart, the browser can open over a session in a worktree the cleanup removed: its
// directory no longer resolves, so "this project" comes from the session itself.
test('a session scopes the list like its directory: root, subdirectory, worktree, no git', async () => {
  const repo = directory('scope-repo');
  git(repo, 'init', '-q');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'scope init');
  const { project } = await host.location.get({ location: { directory: repo } });
  const worktree = await host.worktree.create({ projectID: project.id, name: 'scope' });
  for (const target of [
    repo,
    directory('scope-repo', 'pkg'),
    worktree.directory,
    directory('scope-loose')
  ]) {
    const session = await host.sessions.create({ location: { directory: target } });
    assert.deepEqual(
      sessionScope(session),
      projectScope(await host.location.get({ location: { directory: target } })),
      target
    );
  }
});

test('worktree list marks the main checkout, and remove without force keeps a dirty worktree', async () => {
  assert.ok(probe);
  const repo = directory('cleanup-repo');
  git(repo, 'init', '-q');
  // The project id is the root commit, so the message keeps it apart from the other test repo.
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'cleanup init');
  const { project } = await host.location.get({ location: { directory: repo } });
  const created = await host.worktree.create({ projectID: project.id, name: 'contract' });
  // Compared resolved, the way cleanup's assignSessions compares them: a path can reach the host
  // through a symlink (macOS /var) or an 8.3 short name (Windows).
  const listed = async () =>
    (await projectWorktrees(probe as Plugin.Context, project.id)).map((entry) => ({
      directory: realpathSync.native(entry.directory),
      main: entry.main
    }));
  const worktree = realpathSync.native(created.directory);
  assert.deepEqual(
    (await listed()).sort((a, b) => Number(b.main) - Number(a.main)),
    [
      { directory: realpathSync.native(repo), main: true },
      { directory: worktree, main: false }
    ]
  );

  // Cleanup removes without force and counts on git refusing a worktree with local files.
  writeFileSync(path.join(worktree, 'notes.txt'), 'keep me');
  await assert.rejects(removeWorktree(probe, project.id, created.directory));
  assert.ok(existsSync(path.join(worktree, 'notes.txt')));
  rmSync(path.join(worktree, 'notes.txt'));
  await removeWorktree(probe, project.id, created.directory);
  assert.deepEqual(
    (await listed()).map((entry) => entry.directory),
    [realpathSync.native(repo)]
  );
  assert.equal(existsSync(worktree), false);
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
