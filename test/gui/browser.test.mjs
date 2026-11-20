import { afterEach, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createClient, createServer, rpcUnavailable, startGui, until } from './harness.mjs';

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
const VIEWS = { ses_busy: busy, ses_merged: merged };

/** The fixture views of the given sessions, as the `refs` and `refresh` RPCs answer. */
const viewsOf = (ids) =>
  Object.fromEntries(ids.flatMap((id) => (VIEWS[id] ? [[id, VIEWS[id]]] : [])));

/** A server with the fixtures and the server plugin, unless `handlers` replace its RPCs. */
function fixtureServer(handlers = {}) {
  const client = createClient({
    'session.get': ({ sessionID }) =>
      [...SESSIONS, ...ARCHIVED].find((item) => item.id === sessionID),
    'session.list': ({ archived }) => ({ data: archived ? ARCHIVED : SESSIONS }),
    'session.update': () => undefined,
    // The user last wrote before the pull request merged.
    'message.list': () => ({ data: [{ time: { created: NOW - 2 * HOUR } }] }),
    'rpc.refs': ({ sessionIDs }) => viewsOf(sessionIDs),
    'rpc.refresh': ({ sessionIDs }) => viewsOf(sessionIDs),
    'rpc.search': () => [],
    ...handlers
  });
  return createServer({ client });
}

let gui;
afterEach(() => gui?.dispose());

/** Starts the GUI with `ses_busy` routed, opens the browser and waits for its first row. */
async function openBrowser(handlers) {
  const server = fixtureServer(handlers);
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

test('rows show their pull requests with the stack place, issues and +N, per view', async () => {
  await openBrowser();

  const lines = [...row('ses_busy').querySelectorAll('.ss-row-line')];
  assert.deepEqual(
    lines.map((line) => line.querySelector('.ss-ref-number')?.textContent),
    ['#4930', '#4931', '#4932', '#77']
  );
  assert.equal(lines[0].querySelector('.ss-ref-stack').textContent, '2/4');
  assert.equal(lines[0].querySelector('.ss-row-extra').textContent, '+1');
  assert.equal(lines[3].querySelector('.ss-row-extra'), null);

  // The merged session waits in Done, not in Active; the archived one in Archived. Every
  // tracked pull request counts in Pull requests, the merged one too.
  await until(() => count('done') === '1', 'the Done count');
  assert.deepEqual(listed(), ['ses_busy', 'ses_plain']);
  assert.deepEqual(['active', 'done', 'archived', 'pulls'].map(count), ['2', '1', '1', '5']);
  tab('done').click();
  await until(() => listed().join() === 'ses_merged', 'the Done view');
  press({ key: 'Tab' });
  await until(() => listed().join() === 'ses_old', 'the Archived view');
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
  const groups = [...document.querySelectorAll('[role="listbox"] .ss-group-title')];
  assert.equal(groups.at(-1).textContent, 'In messages');
  assert.ok(groups.at(-1).parentElement.contains(row('ses_merged')));
});

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
  press({ key: 'Enter' });
  assert.deepEqual(gui.tabs, [{ server: 'sidecar', id: 'ses_busy', focus: true }]);
  assert.equal(document.querySelector('[role="dialog"]'), null);
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
});

test('this project lists the routed session project, all projects lists every one', async () => {
  const client = await openBrowser();
  const filters = () =>
    client.calls
      .filter((call) => call.name === 'session.list')
      .map((call) => [call.input.archived, call.input.project, call.input.subpath]);

  assert.deepEqual(filters(), [
    [false, 'proj', ''],
    [true, 'proj', '']
  ]);
  document.querySelector('.ss-scope').click();
  await until(() => filters().length === 4, 'the reload');
  assert.deepEqual(filters().slice(2), [
    [false, undefined, undefined],
    [true, undefined, undefined]
  ]);
});
