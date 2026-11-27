import { afterEach, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createSignal } from 'solid-js';
import { createClient, createData, createServer, startGui, until } from './harness.mjs';

const { sessionRefViewSchema } = await import('../../dist/rpc.js');

// The Super Sessions side tab in the built bundle: the routed session's Work, and the Working
// section of the sessions that need the user on every machine, which a session switch leaves alone.

const NOW = Date.now();
const HOUR = 3_600_000;
const SIDE = 'opencode-super-sessions:sessions';

/**
 * A root session. `ran` is how many hours ago its latest run started, `idle` and `viewed` how
 * many hours ago that run ended and the user last looked; undefined leaves the time out.
 */
const session = (id, title, { project = 'proj', ran = 3, idle, viewed } = {}) => ({
  id,
  title,
  projectID: project,
  location: { directory: project === 'proj' ? '/work/widgets' : '/work/other' },
  time: {
    created: NOW - 72 * HOUR,
    updated: NOW,
    busy: NOW - ran * HOUR,
    ...(idle === undefined ? {} : { idle: NOW - idle * HOUR }),
    ...(viewed === undefined ? {} : { viewed: NOW - viewed * HOUR })
  }
});
const SESSIONS = [
  // Idle and read: never in Working.
  session('ses_a', 'Split the build', { ran: 5, idle: 4, viewed: 3 }),
  session('ses_b', 'Read the logs', { ran: 5, idle: 4, viewed: 3 }),
  session('ses_read', 'Tidy the docs', { ran: 2, idle: 1, viewed: 0.5 }),
  // Waits on a permission while it runs.
  session('ses_wait', 'Ask to deploy', { ran: 0.1 }),
  // Runs, in another project.
  session('ses_run', 'Port the parser', { project: 'other', ran: 0.5 }),
  // Finished an hour ago, unread; and two days ago, unread.
  session('ses_unread', 'Fix the flaky test', { ran: 2, idle: 1 }),
  session('ses_old', 'Old report', { ran: 49, idle: 48 })
];
const PERMISSION = { id: 'per_1', sessionID: 'ses_wait', action: 'bash', resources: ['deploy'] };
const pr = (number) => ({
  provider: 'github',
  host: 'github.com',
  repo: 'acme/widgets',
  kind: 'pr',
  number
});
const tracking = (number) =>
  sessionRefViewSchema.parse({
    links: [{ ref: pr(number), source: 'agent', linkedAt: 1 }],
    branchRefs: [],
    states: {
      [`github:github.com/acme/widgets/pr/${number}`]: {
        status: 'open',
        title: `Pull ${number}`,
        url: `https://github.com/acme/widgets/pull/${number}`
      }
    }
  });
const plain = sessionRefViewSchema.parse({ links: [], branchRefs: [], states: {} });
const VIEWS = { ses_a: tracking(7), ses_b: tracking(8) };
const viewsOf = (ids) => Object.fromEntries(ids.map((id) => [id, VIEWS[id] ?? plain]));
const rpcs = {
  'rpc.refresh': ({ sessionIDs }) => viewsOf(sessionIDs),
  'rpc.done.facts': ({ sessionIDs }) =>
    Object.fromEntries(sessionIDs.map((id) => [id, { pending: false }])),
  'rpc.search': () => []
};

let gui;
afterEach(() => gui?.dispose());

/**
 * Starts the GUI on a fake server with `ses_a` routed and another machine whose one session
 * runs. `refs` answers the `refs` RPC, by default at once. Returns both clients, this machine's
 * data, the routed session's getter, a route to another session, and the project list reads.
 */
async function start(refs = ({ sessionIDs }) => viewsOf(sessionIDs)) {
  const client = createClient({
    'session.get': ({ sessionID }) => SESSIONS.find((item) => item.id === sessionID),
    'session.list': ({ archived, project }) => ({
      data: archived
        ? []
        : SESSIONS.filter((item) => project === undefined || item.projectID === project)
    }),
    'message.list': () => ({ data: [], cursor: {} }),
    'rpc.refs': refs,
    ...rpcs
  });
  const data = createData({
    running: ['ses_wait', 'ses_run'],
    permissions: { ses_wait: [PERMISSION] }
  });
  // The synced projects, counted: rows must not look a project up each.
  let projectReads = 0;
  data.project = {
    list: () => {
      projectReads++;
      return [
        { id: 'proj', name: 'widgets', canonical: '/work/widgets' },
        { id: 'other', name: 'other', canonical: '/work/other' }
      ];
    }
  };
  const server = createServer({ client, data });
  const remoteClient = createClient({
    'session.list': ({ archived }) => ({
      data: archived
        ? []
        : [
            {
              ...session('ses_remote', 'Remote work', { project: 'far', ran: 0.2 }),
              location: { directory: '/srv/far' }
            }
          ]
    }),
    'rpc.refs': ({ sessionIDs }) => viewsOf(sessionIDs),
    ...rpcs
  });
  // Another machine: neither the app's own server nor a loopback connection.
  const remote = {
    ...createServer({
      id: 'remote',
      client: remoteClient,
      data: createData({ running: ['ses_remote'] }),
      builtin: false
    }),
    local: false
  };
  const refOf = (id) => ({ server, id, key: `${server.id}\n${id}`, directory: '/work/widgets' });
  const [routed, route] = createSignal(refOf('ses_a'));
  gui = await startGui({
    session: routed(),
    servers: [server, remote],
    // Another session tab, whose side region the row click keeps open.
    openSessions: [refOf('ses_unread')]
  });
  return {
    client,
    remoteClient,
    data,
    routed,
    // The tab shows in the next session already, as it does once it was open there.
    route(id) {
      gui.ctx.layout.open(SIDE, refOf(id));
      route(refOf(id));
      gui.setSession(routed());
    },
    projectReads: () => projectReads
  };
}

/** Shows the side tab in the routed session and waits for the Working rows. */
async function showTab(routed) {
  gui.ctx.layout.open(SIDE, routed());
  const panel = gui.panel('sessions', routed);
  await until(() => row('ses_unread') && row('ses_remote'), 'the Working rows');
  return panel;
}

const lists = (client) => client.calls.filter((call) => call.name === 'session.list').length;
const row = (id) => document.querySelector(`.ss-working [data-session="${id}"]`);
const rows = () =>
  [...document.querySelectorAll('.ss-working [data-session]')].map((node) => node.dataset.session);
const current = (id) => row(id).getAttribute('aria-current') === 'page';

test('Working lists waiting, then running, then unread from the last day, and no session list', async () => {
  const { routed } = await start();
  await showTab(routed);

  assert.deepEqual(rows(), ['ses_wait', 'ses_remote', 'ses_run', 'ses_unread']);
  assert.ok(row('ses_wait').querySelector('[data-marker="waiting"]'));
  assert.ok(row('ses_run').querySelector('[data-marker="running"]'));
  assert.ok(row('ses_unread').querySelector('[data-marker="unread"]'));
  // The project's list and its scope switch are gone: idle read sessions show nowhere.
  assert.equal(document.querySelector('.ss-side-scope'), null);
  assert.equal(document.querySelector('.ss-side [data-session="ses_a"]'), null);
  assert.equal(document.querySelector('.ss-side [data-session="ses_read"]'), null);
});

test('Working spans projects and machines, with one list per machine and the server icon only on the remote row', async () => {
  const { client, remoteClient, routed } = await start();
  await showTab(routed);

  const place = (id) => row(id).querySelector('.ss-working-project').textContent;
  assert.equal(place('ses_run'), 'other');
  assert.equal(place('ses_wait'), 'widgets');
  assert.equal(place('ses_remote'), 'far');
  assert.ok(row('ses_remote').querySelector('[data-icon="server"]'));
  for (const id of ['ses_wait', 'ses_run', 'ses_unread']) {
    assert.equal(row(id).querySelector('[data-icon="server"]'), null, id);
  }
  assert.equal(lists(client), 1);
  assert.equal(lists(remoteClient), 1);
});

test('a click on a row opens its session focused and keeps the side tab there', async () => {
  const { routed } = await start();
  await showTab(routed);

  row('ses_unread').click();
  assert.deepEqual(gui.tabs, [{ server: 'sidecar', id: 'ses_unread', focus: true }]);
  assert.deepEqual(gui.layout.at(-1), { key: SIDE, session: 'ses_unread', background: true });
});

test('answering the permission moves the session from waiting to running, in the same row', async () => {
  const { data, routed } = await start();
  await showTab(routed);
  const node = row('ses_wait');
  assert.equal(node.dataset.attention, 'waiting');

  data.emit({ type: 'permission.replied', data: { sessionID: 'ses_wait', requestID: 'per_1' } });
  await until(() => row('ses_wait')?.dataset.attention === 'running', 'the running row');
  assert.equal(row('ses_wait'), node);
  assert.equal(node.querySelector('[data-marker="waiting"]'), null);
  assert.deepEqual(rows(), ['ses_wait', 'ses_remote', 'ses_run', 'ses_unread']);
});

// A session switch re-rendered every row and looked each row's project up again: about 440 ms per
// click on a real machine.
test('a session switch keeps every Working row and looks the projects up once, not per row', async () => {
  const { routed, route, projectReads } = await start();
  await showTab(routed);
  const nodes = new Map(rows().map((id) => [id, row(id)]));
  const reads = projectReads();

  route('ses_wait');
  await until(() => current('ses_wait'), 'the current row');
  route('ses_unread');
  await until(() => current('ses_unread'), 'the new current row');
  assert.equal(current('ses_wait'), false);
  for (const [id, node] of nodes) assert.equal(row(id), node, `the row of ${id}`);
  assert.equal(projectReads(), reads);
});

test('after a switch, Work shows what the browser holds before the refs answer', async () => {
  let hold = false;
  const { routed, route } = await start(({ sessionIDs }) =>
    hold ? new Promise(() => {}) : viewsOf(sessionIDs)
  );
  // The browser loads the project's lists and refs into the shared model.
  await gui.command('browse').run();
  await until(() => document.querySelector('[role="dialog"] [data-session="ses_b"]'), 'the dialog');
  await until(
    () => document.querySelector('[role="dialog"] [data-session="ses_b"] [data-ref$="/pr/8"]'),
    'the dialog refs'
  );
  for (const dialog of gui.dialogs) dialog.dispose();
  await showTab(routed);
  await until(() => document.querySelector('.ss-side-work-head [data-ref$="/pr/7"]'), 'PR 7');

  hold = true;
  route('ses_b');
  // In the same task as the switch: no answer could have come yet.
  assert.ok(document.querySelector('.ss-side-work-head [data-ref$="/pr/8"]'));
  assert.equal(document.querySelector('.ss-side-work-head [data-ref$="/pr/7"]'), null);
  assert.equal(document.querySelector('.ss-side-work-count').textContent, ' · 1 PR');
  // Work is listed without a fold.
  assert.ok(document.querySelector('.ss-side-work-body [data-ref$="/pr/8"]'));
});

test('a session that tracks nothing reads Nothing linked with a link action', async () => {
  const { routed, route } = await start();
  await showTab(routed);
  route('ses_read');
  await until(
    () => document.querySelector('.ss-side-work-title')?.textContent === 'Nothing linked',
    'the nothing linked line'
  );
  assert.ok(document.querySelector('.ss-side-work .ss-side-link'));
  assert.equal(document.querySelector('.ss-side-work [data-ref]'), null);
});
