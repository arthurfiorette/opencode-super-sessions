import { afterEach, test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  createClient,
  createData,
  createServer,
  rpcUnavailable,
  startGui,
  until
} from './harness.mjs';

const { sessionRefViewSchema } = await import('../../dist/rpc.js');

// The session browser dialog in the built bundle, against a fake server: what the user sees in
// the list, and what the keys and buttons ask of the server and the app.

const NOW = Date.now();
const HOUR = 3_600_000;
const pr = (number) => ({
  provider: 'github',
  host: 'github.com',
  repo: 'acme/widgets',
  kind: 'pr',
  number
});
const issue = (number) => ({ ...pr(number), kind: 'issue' });
const key = (ref) => `${ref.provider}:${ref.host}/${ref.repo}/${ref.kind}/${ref.number}`;
const state = (ref, extra = {}) => ({
  status: 'open',
  title: `Title of ${ref.number}`,
  url: `https://github.com/acme/widgets/${ref.kind === 'pr' ? 'pull' : 'issues'}/${ref.number}`,
  ...extra
});

const session = (id, title, time = {}) => ({
  id,
  title,
  projectID: 'proj',
  location: { directory: '/work/widgets' },
  time: { created: NOW - 2 * HOUR, updated: NOW - HOUR, ...time }
});

// Four open pull requests, one a stack's second layer, and an issue: the row shows three pull
// requests, folds the fourth into `+1`, and lists the issue under them.
const stackPrs = [pr(4930), pr(4931), pr(4932), pr(4933)];
const busy = sessionRefViewSchema.parse({
  links: [
    ...stackPrs.map((ref, index) => ({ ref, source: 'agent', linkedAt: 10 - index })),
    { ref: issue(77), source: 'prompt', linkedAt: 1 }
  ],
  branchRefs: [],
  states: {
    ...Object.fromEntries(stackPrs.map((ref) => [key(ref), state(ref)])),
    [key(pr(4930))]: state(pr(4930), { stack: { number: 9, position: 2, size: 4 } }),
    [key(issue(77))]: state(issue(77))
  }
});
// Its only pull request merged after the user's last message: Done.
const merged = sessionRefViewSchema.parse({
  links: [{ ref: pr(4800), source: 'agent', linkedAt: 1 }],
  branchRefs: [],
  states: { [key(pr(4800))]: state(pr(4800), { status: 'merged', mergedAt: NOW - HOUR }) }
});

const SESSIONS = [
  session('ses_busy', 'Split the build'),
  session('ses_merged', 'Rollup plugin order', { created: NOW - 5 * HOUR }),
  session('ses_plain', 'Read the logs', { created: NOW - 3 * HOUR })
];
const ARCHIVED = [session('ses_old', 'Old spike', { archived: NOW - HOUR })];
// A session of another project, older than every session of the routed one.
const OTHER = {
  ...session('ses_other', 'Other repo work', { created: NOW - 10 * HOUR, updated: NOW - 9 * HOUR }),
  projectID: 'other',
  location: { directory: '/work/other' }
};
// It tracks nothing: the server answers an empty view.
const plain = sessionRefViewSchema.parse({ links: [], branchRefs: [], states: {} });
const VIEWS = { ses_busy: busy, ses_merged: merged, ses_plain: plain };

/** The fixture views of the given sessions, as the `refs` and `refresh` RPCs answer. */
const viewsOf = (ids) =>
  Object.fromEntries(ids.flatMap((id) => (VIEWS[id] ? [[id, VIEWS[id]]] : [])));

/** A server with the fixtures and the server plugin, unless `handlers` replace its RPCs. */
function fixtureServer(handlers = {}, data = {}) {
  const client = createClient({
    'session.get': ({ sessionID }) =>
      [...SESSIONS, ...ARCHIVED, OTHER].find((item) => item.id === sessionID),
    // The host's project filter; a list without one has every project's sessions.
    'session.list': ({ archived, project }) => ({
      data: (archived ? ARCHIVED : [...SESSIONS, OTHER]).filter(
        (item) => project === undefined || item.projectID === project
      )
    }),
    'session.update': () => undefined,
    // The preview's page: nothing to draw.
    'message.list': () => ({ data: [], cursor: {} }),
    // Nothing waits on the user, who last wrote before the pull request merged.
    'rpc.done.facts': ({ sessionIDs }) =>
      Object.fromEntries(
        sessionIDs.map((id) => [id, { pending: false, lastUserMessageAt: NOW - 2 * HOUR }])
      ),
    'rpc.refs': ({ sessionIDs }) => viewsOf(sessionIDs),
    'rpc.refresh': ({ sessionIDs }) => viewsOf(sessionIDs),
    'rpc.search': () => [],
    ...handlers
  });
  return createServer({ client, data: createData(data) });
}

let gui;
afterEach(() => gui?.dispose());

/** Starts the GUI with `ses_busy` routed, opens the browser and waits for its first row. */
async function openBrowser(handlers, data) {
  const server = fixtureServer(handlers, data);
  gui = await startGui({
    session: { server, id: 'ses_busy', key: `${server.id}\nses_busy`, directory: '/work/widgets' },
    servers: [server]
  });
  await gui.command('browse').run();
  await until(() => row('ses_busy'), 'the first row');
  return server.client;
}

const row = (id) => document.querySelector(`[data-session="${id}"]`);
const listed = () =>
  [...document.querySelectorAll('[role="listbox"] [data-session]')].map(
    (node) => node.dataset.session
  );
const tab = (view) => document.querySelector(`[data-view="${view}"]`);
const count = (view) => tab(view).querySelector('.ss-tab-count').textContent;
const search = () => document.querySelector('[role="dialog"] input');
const press = (init) =>
  search().dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  );

// OpenCode Desktop 2.4 binds the same keys to "Archive session", and its keymap runs first in the
// capture phase on the document root. A user pressing the browser's keys archived the session on
// screen instead, once per press.
test('the browser keys open one browser and never reach the app command under them', async () => {
  const server = fixtureServer();
  gui = await startGui({
    session: { server, id: 'ses_busy', key: `${server.id}\nses_busy`, directory: '/work/widgets' },
    servers: [server]
  });
  const app = [];
  const archive = (event) => app.push(event.key);
  document.documentElement.addEventListener('keydown', archive, { capture: true });
  try {
    const keys = { key: 's', metaKey: true, shiftKey: true, bubbles: true, cancelable: true };
    document.body.dispatchEvent(new KeyboardEvent('keydown', keys));
    await until(() => row('ses_busy'), 'the first row');
    // Pressed again over the open browser, from its search field.
    search().dispatchEvent(new KeyboardEvent('keydown', keys));
    assert.deepEqual(app, []);
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
    assert.equal(gui.dialogs.length, 1);
    assert.equal(server.client.calls.filter((call) => call.name === 'session.update').length, 0);
  } finally {
    document.documentElement.removeEventListener('keydown', archive, { capture: true });
  }
});

test('sessions sort into the views by their refs, and tab moves between the views', async () => {
  const client = await openBrowser();

  // The merged session waits in Done, not in Active; the archived one in Archived. Every
  // tracked pull request counts in Pull requests, the merged one too.
  await until(() => count('done') === '1', 'the Done count');
  assert.deepEqual(listed(), ['ses_busy', 'ses_plain']);
  // A session without refs is its title line alone, with no empty block under it.
  assert.ok(row('ses_busy').querySelector('.ss-row-lines .ss-ref'));
  assert.equal(row('ses_plain').querySelector('.ss-row-lines'), null);
  assert.deepEqual(['active', 'done', 'archived', 'pulls'].map(count), ['2', '1', '1', '5']);
  // Done came from the server's facts in one call: asking the host per session booted every
  // evicted Location on the way, for up to 1.4 s each.
  assert.deepEqual(
    client.calls.filter((call) => call.name === 'rpc.done.facts').map((call) => call.input),
    [{ sessionIDs: ['ses_merged'] }]
  );
  assert.deepEqual(gui.ctx.servers.get('sidecar').data.synced, []);
  assert.equal(
    client.calls.some((call) => call.name === 'message.list' && call.input.type === 'user'),
    false
  );
  tab('done').click();
  await until(() => listed().join() === 'ses_merged', 'the Done view');
  press({ key: 'Tab' });
  await until(() => listed().join() === 'ses_old', 'the Archived view');

  // The routed session's own Location answers for its project, for the list and the preview.
  const locations = client.calls
    .filter((call) => call.name === 'rpc.refs')
    .map((call) => call.options.location);
  assert.ok(locations.length > 0);
  for (const location of locations) {
    assert.deepEqual(location, { directory: '/work/widgets' });
  }
});

/** Closes the open browser with its `esc` button. */
const closeBrowser = () => document.querySelector('[role="dialog"] .ss-esc').click();
/** The model's loads of the routed project; the rail lists every project on its own. */
const listLoads = (client) =>
  client.calls.filter((call) => call.name === 'session.list' && call.input.project === 'proj')
    .length;

// Each open loaded the lists afresh, so cmd+shift+s showed a spinner for 0.65 s to 2 s.
test('a reopen draws the cached rows at once, before asking the server again', async () => {
  const client = await openBrowser();
  await until(() => count('done') === '1', 'the first open to settle');
  closeBrowser();
  const loads = listLoads(client);

  await gui.command('browse').run();
  // Synchronously, in the render the command started: no list load came before the rows.
  assert.deepEqual(listed(), ['ses_busy', 'ses_plain']);
  assert.ok(row('ses_busy').querySelector('.ss-ref'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(listLoads(client), loads);
});

test('a cold open draws the titles before the refs answer', async () => {
  let listsAsked = () => {};
  const asked = new Promise((resolve) => {
    listsAsked = resolve;
  });
  let answerLists = () => {};
  const lists = new Promise((resolve) => {
    answerLists = resolve;
  });
  let answer = () => {};
  const refs = new Promise((resolve) => {
    answer = resolve;
  });
  const server = fixtureServer({
    'session.list': (input) => {
      if (input.project === undefined) return { data: [...SESSIONS, OTHER] };
      listsAsked();
      return lists.then(() => ({ data: input.archived ? ARCHIVED : SESSIONS }));
    },
    'rpc.refs': ({ sessionIDs }) => refs.then(() => viewsOf(sessionIDs))
  });
  gui = await startGui({
    session: { server, id: 'ses_busy', key: `${server.id}\nses_busy`, directory: '/work/widgets' },
    servers: [server]
  });
  await gui.command('browse').run();
  await asked;
  answerLists();
  // One timer turn: the rows are on screen without waiting for the refs or for a hold timer.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(listed(), ['ses_busy', 'ses_merged', 'ses_plain']);
  assert.equal(row('ses_busy').querySelector('.ss-ref'), null);
  answer();
  await until(() => row('ses_busy').querySelector('.ss-ref'), 'the ref lines');
  await until(() => count('done') === '1', 'the merged session to move to Done');
});

// A forge refresh can take seconds, and the app runs four requests per server at once: one left
// running after the dialog closed held a slot every other read of the window waited for.
test('closing the browser aborts its forge refreshes', async () => {
  // The rows' refresh; the routed session's own, for its header and pill, outlives the browser.
  let signal;
  await openBrowser({
    'rpc.refresh': ({ sessionIDs }, options) => {
      if (sessionIDs.includes('ses_plain')) signal = options.signal;
      return new Promise(() => {});
    }
  });
  await until(() => signal, 'the rows to be refreshed');
  assert.equal(signal.aborted, false);
  closeBrowser();
  assert.equal(signal.aborted, true);
});

test('search narrows the list and adds message hits under In messages', async () => {
  await openBrowser({
    'rpc.search': ({ query }) =>
      query === 'logs' ? [{ sessionID: 'ses_merged', match: 'body', score: 1 }] : []
  });

  const input = search();
  input.value = 'logs';
  input.dispatchEvent(new Event('input', { bubbles: true }));

  await until(() => listed().join() === 'ses_plain,ses_merged', 'the search results');
  assert.equal(groupOf('ses_merged'), 'In messages');
  assert.notEqual(groupOf('ses_plain'), 'In messages');
});

/** The title of the group a row is listed under: the nearest header before it. */
function groupOf(id) {
  let node = row(id)?.previousElementSibling;
  while (node && !node.classList.contains('ss-group-title')) node = node.previousElementSibling;
  return node?.textContent;
}

test('the keys archive the selected session and open one in a focused tab', async () => {
  const client = await openBrowser();

  press({ key: 'ArrowDown' });
  await until(() => row('ses_plain')?.getAttribute('aria-selected') === 'true', 'the selection');
  // alt+s types `ß` on macOS, so the browser matches the key by its code.
  press({ key: 'ß', code: 'KeyS', altKey: true });
  await until(() => !listed().includes('ses_plain'), 'the archived row to leave');
  assert.deepEqual(
    client.calls.filter((call) => call.name === 'session.update').map((call) => call.input),
    [{ sessionID: 'ses_plain', archived: true }]
  );

  press({ key: 'ArrowUp' });
  await until(() => row('ses_busy')?.getAttribute('aria-selected') === 'true', 'the selection');
  // mod+enter opens in the background and keeps the browser open for the next one.
  press({ key: 'Enter', ctrlKey: true });
  assert.deepEqual(gui.tabs, [{ server: 'sidecar', id: 'ses_busy', focus: false }]);
  assert.ok(document.querySelector('[role="dialog"]'));
  press({ key: 'Enter' });
  assert.deepEqual(gui.tabs.at(-1), { server: 'sidecar', id: 'ses_busy', focus: true });
  assert.equal(document.querySelector('[role="dialog"]'), null);
});

test('restoring a session also keeps auto-archive from taking it again', async () => {
  const client = await openBrowser({ 'rpc.archive.exclude': () => ({}) });

  tab('archived').click();
  await until(() => row('ses_old')?.getAttribute('aria-selected') === 'true', 'the Archived view');
  press({ key: 'å', code: 'KeyS', altKey: true });

  await until(() => !listed().includes('ses_old'), 'the restored row to leave');
  assert.deepEqual(
    client.calls.filter((call) => call.name === 'session.update').map((call) => call.input),
    [{ sessionID: 'ses_old', archived: false }]
  );
  await until(
    () => client.calls.some((call) => call.name === 'rpc.archive.exclude'),
    'the exclusion'
  );
  assert.deepEqual(
    client.calls.filter((call) => call.name === 'rpc.archive.exclude').map((call) => call.input),
    [{ sessionIDs: ['ses_old'] }]
  );
});

test('without the server plugin, sessions still list, with a note', async () => {
  await openBrowser({
    'rpc.refs': () => Promise.reject(rpcUnavailable()),
    'rpc.refresh': () => Promise.reject(rpcUnavailable())
  });

  await until(
    () =>
      [...document.querySelectorAll('.ss-note')].some((note) =>
        note.textContent.includes('server plugin is not installed')
      ),
    'the note'
  );
  assert.deepEqual(listed(), ['ses_busy', 'ses_merged', 'ses_plain']);
  assert.equal(row('ses_busy').querySelector('.ss-ref'), null);
  // Archiving needs no server plugin; Done is its mark, so there is no Done button to fail.
  assert.ok(row('ses_busy').querySelector('[aria-label="Archive"]'));
  assert.equal(row('ses_busy').querySelector('[aria-label="Mark Done"]'), null);
});

const tile = (key) => document.querySelector(`[data-tile="${key}"]`);
const runningBadge = (key) => tile(key)?.querySelector('.ss-rail-running')?.textContent;

test('the rail lists the picked project whole, and All lists every project', async () => {
  const client = await openBrowser(undefined, { running: ['ses_other'] });
  const filters = () =>
    client.calls
      .filter((call) => call.name === 'session.list')
      .map((call) => [call.input.archived, call.input.project, call.input.subpath]);

  // The routed session's project, with every worktree and subfolder: no subpath.
  await until(() => tile('project:other'), 'the other project tile');
  assert.deepEqual(listed(), ['ses_busy', 'ses_plain']);
  assert.equal(tile('project:proj').getAttribute('aria-pressed'), 'true');
  assert.ok(filters().some((item) => item.join() === [false, 'proj', undefined].join()));

  const before = filters().length;
  tile('project:other').click();
  await until(() => listed().join() === 'ses_other', 'the other project');
  assert.deepEqual(filters().slice(before), [
    [false, 'other', undefined],
    [true, 'other', undefined]
  ]);

  tile('all').click();
  await until(() => listed().length === 3, 'every project');
  assert.deepEqual(listed().sort(), ['ses_busy', 'ses_other', 'ses_plain']);
  assert.deepEqual(filters().slice(-2), [
    [false, undefined, undefined],
    [true, undefined, undefined]
  ]);
});

test('a project tile counts its running sessions, and All counts them all', async () => {
  await openBrowser(undefined, { running: ['ses_other', 'ses_plain', 'ses_busy'] });

  await until(() => runningBadge('project:other'), 'the badges');
  assert.equal(runningBadge('project:other'), '1');
  assert.equal(runningBadge('project:proj'), '2');
  assert.equal(runningBadge('all'), '3');
});

test('alt+down picks the next project on the rail, alt+up the one before', async () => {
  await openBrowser();
  await until(() => tile('project:other'), 'the rail');
  // Newest activity first: the routed project, then the other one.
  assert.deepEqual(
    [...document.querySelectorAll('[data-tile]')].map((node) => node.dataset.tile),
    ['all', 'project:proj', 'project:other']
  );

  press({ key: 'ArrowDown', altKey: true });
  await until(() => listed().join() === 'ses_other', 'the next project');
  assert.equal(tile('project:other').getAttribute('aria-pressed'), 'true');
  // The rows move with plain arrows only, so the selection starts over on the first row.
  assert.equal(row('ses_other').getAttribute('aria-selected'), 'true');
  press({ key: 'ArrowUp', altKey: true });
  await until(() => listed().join() === 'ses_busy,ses_plain', 'the project before');
});

const MODEL = { providerID: 'acme', id: 'large' };
/** A session's exchange, oldest first: a prompt, then a reply that read a file and ran a test. */
const exchange = (id, prompt) => [
  { id: `${id}_u`, type: 'user', text: prompt, time: { created: NOW - HOUR } },
  {
    id: `${id}_a`,
    type: 'assistant',
    model: MODEL,
    time: { created: NOW - HOUR, completed: NOW - HOUR },
    tokens: { input: 12_000, output: 345, reasoning: 0, cache: { read: 0, write: 0 } },
    content: [
      { type: 'text', text: `Answer to ${prompt}` },
      {
        type: 'tool',
        id: 't1',
        name: 'read',
        time: { created: NOW - HOUR },
        state: { status: 'completed', input: { path: '/work/widgets/src/build.ts' } }
      },
      {
        type: 'tool',
        id: 't2',
        name: 'bash',
        time: { created: NOW - HOUR },
        state: { status: 'completed', input: { command: 'pnpm test\npnpm lint' } }
      }
    ]
  }
];
/**
 * `message.list` with the browser's Done lookup (`type: 'user'`) and the preview's page, which the
 * server answers newest first.
 */
const messages = (pages) => (input) =>
  input.type === 'user'
    ? { data: [{ time: { created: NOW - 2 * HOUR } }], cursor: {} }
    : Promise.resolve(pages(input.sessionID)).then((page) => ({
        data: [...page].reverse(),
        cursor: {}
      }));
const chat = () =>
  [...document.querySelectorAll('.ss-preview [data-chat]')].map((node) => [
    node.dataset.chat,
    node.textContent
  ]);

test('the preview shows the context usage and the latest messages, tools in one line', async () => {
  await openBrowser(
    { 'message.list': messages((id) => exchange(id, 'Split the build')) },
    { models: [{ ...MODEL, limit: { context: 100_000 } }] }
  );

  await until(() => chat().length > 0, 'the transcript');
  assert.deepEqual(chat(), [
    ['user', 'Split the build'],
    ['text', 'Answer to Split the build'],
    ['tool', 'Read src/build.ts'],
    ['tool', '$ pnpm test…']
  ]);
  // 12,000 input and 345 output tokens of a 100,000 token window.
  const context = [...document.querySelectorAll('.ss-context-item')].map(
    (node) => node.textContent
  );
  assert.deepEqual(context, ['12,345 tokens', '12% used', 'idle']);
});

test('moving the selection on never shows a slower answer for the row passed', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let answered = false;
  await openBrowser({
    'message.list': messages((id) =>
      id === 'ses_busy'
        ? gate.then(() => {
            answered = true;
            return exchange(id, 'Busy prompt');
          })
        : exchange(id, 'Plain prompt')
    )
  });

  press({ key: 'ArrowDown' });
  await until(() => chat()[0]?.[1] === 'Plain prompt', 'the second session in the preview');
  release();
  await until(() => answered, 'the first answer');
  // Its reply settles in the tasks queued before this one.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(chat()[0]?.[1], 'Plain prompt');
  assert.ok(!document.querySelector('.ss-preview').textContent.includes('Busy prompt'));
});

test('a running session sits under Running with the app spinner, a plain one has no mark', async () => {
  await openBrowser(undefined, { running: ['ses_plain'] });

  const mark = await until(
    () => row('ses_plain')?.querySelector('[data-marker="running"]'),
    'the mark'
  );
  assert.equal(groupOf('ses_plain'), 'Running');
  // The sidebar's dot grid, which the app's stylesheet paints, not the loading ring.
  assert.ok(mark.querySelector('[data-slot="spinner-dots"]'));
  assert.equal(mark.querySelector('[role="progressbar"]'), null);
  // An idle, read session's title line is its title and age, with no glyph before or after.
  const head = row('ses_busy').querySelector('.ss-row-head');
  const age = head.querySelector('.ss-row-age').textContent;
  assert.equal(head.textContent, `Split the build${age}`);
});
