import { afterEach, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createSignal } from 'solid-js';
import { createClient, createData, createServer, startGui, until } from './harness.mjs';

const { sessionRefViewSchema } = await import('../../dist/rpc.js');

// The Super Sessions side tab in the built bundle: what it lists, that it reads the browser's
// model instead of loading its own, and that a session switch leaves its rows and its layout
// alone.

const NOW = Date.now();
const HOUR = 3_600_000;
const SIDE = 'opencode-super-sessions:sessions';

const session = (id, title, hoursAgo, projectID = 'proj') => ({
  id,
  title,
  projectID,
  location: { directory: projectID === 'proj' ? '/work/widgets' : '/work/other' },
  time: { created: NOW - (hoursAgo + 1) * HOUR, updated: NOW - hoursAgo * HOUR }
});
const SESSIONS = [
  session('ses_a', 'Split the build', 1),
  session('ses_b', 'Read the logs', 2),
  session('ses_c', 'Tidy the docs', 3)
];
// A session of another project, which the tab never lists.
const OTHER = session('ses_other', 'Other repo work', 0, 'other');
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

let gui;
afterEach(() => gui?.dispose());

/**
 * Starts the GUI on a fake server with `ses_a` routed. `refs` answers the `refs` RPC, by default
 * at once. `others` are more servers the app lists. Returns the client, the routed session's
 * getter and a route to another session.
 */
async function start(refs = ({ sessionIDs }) => viewsOf(sessionIDs), others = []) {
  const client = createClient({
    'session.get': ({ sessionID }) => [...SESSIONS, OTHER].find((item) => item.id === sessionID),
    'session.list': ({ archived, project }) => ({
      data: archived
        ? []
        : [...SESSIONS, OTHER].filter((item) => project === undefined || item.projectID === project)
    }),
    'message.list': () => ({ data: [], cursor: {} }),
    'rpc.refs': refs,
    'rpc.refresh': ({ sessionIDs }) => viewsOf(sessionIDs),
    'rpc.done.facts': ({ sessionIDs }) =>
      Object.fromEntries(sessionIDs.map((id) => [id, { pending: false }])),
    'rpc.search': () => []
  });
  const data = createData();
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
  const refOf = (id) => ({ server, id, key: `${server.id}\n${id}`, directory: '/work/widgets' });
  const [routed, route] = createSignal(refOf('ses_a'));
  gui = await startGui({ session: routed(), servers: [server, ...others] });
  return {
    client,
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

/** Shows the side tab in the routed session and waits for its rows. */
async function showTab(routed) {
  gui.ctx.layout.open(SIDE, routed());
  const panel = gui.panel('sessions', routed);
  await until(() => sideRow('ses_c'), 'the side rows');
  return panel;
}

const lists = (client) => client.calls.filter((call) => call.name === 'session.list').length;
const sideRow = (id) => document.querySelector(`.ss-side [data-session="${id}"]`);
const sideRows = () =>
  [...document.querySelectorAll('.ss-side [data-session]')].map((node) => node.dataset.session);
const current = (id) => sideRow(id).getAttribute('aria-current') === 'page';

test("the tab lists the routed project's sessions the browser loaded, without tabs or search", async () => {
  const { client, routed, route } = await start();
  await gui.command('browse').run();
  await until(() => document.querySelector('[role="dialog"] [data-session="ses_b"]'), 'the dialog');
  for (const dialog of gui.dialogs) dialog.dispose();
  const loaded = lists(client);

  await showTab(routed);
  assert.deepEqual(sideRows(), ['ses_a', 'ses_b', 'ses_c']);
  assert.equal(document.querySelector('.ss-side [role="tablist"]'), null);
  assert.equal(document.querySelector('.ss-side input'), null);
  assert.ok(current('ses_a'));
  assert.equal(lists(client), loaded);

  // Another session of the project: the same lists, the current mark moves.
  route('ses_b');
  await until(() => current('ses_b'), 'the new current row');
  assert.equal(current('ses_a'), false);
  assert.equal(lists(client), loaded);
});

// A session switch re-rendered every row and looked each row's project up again: about 440 ms per
// click on a real machine.
test('a session switch keeps every row, and looks the projects up once, not per row', async () => {
  const { routed, route, projectReads } = await start();
  await gui.command('browse').run();
  await until(() => document.querySelector('[role="dialog"] [data-session="ses_c"]'), 'the dialog');
  const reads = projectReads();
  // The dialog's rows draw two projects' avatars from one read of the synced projects.
  assert.ok(reads <= 1, `${reads} project list reads for one list`);
  for (const dialog of gui.dialogs) dialog.dispose();

  await showTab(routed);
  const nodes = new Map(sideRows().map((id) => [id, sideRow(id)]));
  const work = document.querySelector('.ss-side-work');
  route('ses_b');
  route('ses_c');
  await until(() => current('ses_c'), 'the new current row');
  for (const [id, node] of nodes) assert.equal(sideRow(id), node, `the row of ${id}`);
  // Work stays folded and the same element, so the list under it does not move.
  assert.equal(document.querySelector('.ss-side-work'), work);
  assert.equal(work.dataset.folded, 'true');
  assert.equal(projectReads(), reads);
});

test('after a switch, Work shows what the browser holds before the refs answer', async () => {
  let hold = false;
  const { routed, route } = await start(({ sessionIDs }) =>
    hold ? new Promise(() => {}) : viewsOf(sessionIDs)
  );
  await showTab(routed);
  await until(() => document.querySelector('.ss-side-work-head [data-ref$="/pr/7"]'), 'PR 7');
  await until(
    () => document.querySelector('.ss-side-work-count')?.textContent === ' · 1 PR',
    'the summary'
  );

  hold = true;
  route('ses_b');
  // In the same task as the switch: no answer could have come yet.
  assert.ok(document.querySelector('.ss-side-work-head [data-ref$="/pr/8"]'));
  assert.equal(document.querySelector('.ss-side-work-head [data-ref$="/pr/7"]'), null);
  assert.equal(document.querySelector('.ss-side-work-count').textContent, ' · 1 PR');
});

test("All projects lists every project's sessions on every machine, then the routed project's again", async () => {
  const remoteClient = createClient({
    'session.list': ({ archived }) => ({
      data: archived
        ? []
        : [
            {
              ...session('ses_remote', 'Remote work', 0, 'far'),
              location: { directory: '/srv/far' }
            }
          ]
    }),
    'rpc.refs': ({ sessionIDs }) => viewsOf(sessionIDs),
    'rpc.refresh': ({ sessionIDs }) => viewsOf(sessionIDs),
    'rpc.done.facts': ({ sessionIDs }) =>
      Object.fromEntries(sessionIDs.map((id) => [id, { pending: false }])),
    'rpc.search': () => []
  });
  // Another machine: neither the app's own server nor a loopback connection.
  const remote = {
    ...createServer({ id: 'remote', client: remoteClient, builtin: false }),
    local: false
  };
  const { routed } = await start(undefined, [remote]);
  await showTab(routed);
  assert.deepEqual(sideRows(), ['ses_a', 'ses_b', 'ses_c']);

  const scope = document.querySelector('.ss-side-scope');
  // Every project's list, which showing the tab asked each machine for, draws the rows in the
  // same task as the click: the list never blanks while the servers answer.
  await until(
    () => remoteClient.calls.some((call) => call.name === 'session.list'),
    "the other machine's list"
  );
  // The fake answers in microtasks; one task later the answer is in the model.
  await new Promise((resolve) => setTimeout(resolve, 0));
  scope.click();
  assert.ok(sideRow('ses_a') && sideRow('ses_remote') && sideRow('ses_other'));
  const description = (id) => sideRow(id).querySelector('.ss-side-row-description')?.textContent;
  assert.equal(description('ses_other'), 'other');
  assert.equal(description('ses_remote'), 'far · remote');
  assert.equal(scope.textContent, 'All projects');

  scope.click();
  await until(() => sideRow('ses_remote') === null, 'the routed project alone');
  assert.deepEqual(sideRows(), ['ses_a', 'ses_b', 'ses_c']);
  assert.equal(sideRow('ses_a').querySelector('.ss-side-row-description'), null);
});

test('a click on a row opens its session in a focused tab', async () => {
  const { routed } = await start();
  await showTab(routed);

  sideRow('ses_b').click();
  assert.deepEqual(gui.tabs, [{ server: 'sidecar', id: 'ses_b', focus: true }]);
});

test('a session that tracks nothing reads Nothing linked with a link action', async () => {
  const { routed, route } = await start();
  await showTab(routed);
  route('ses_c');
  const title = await until(
    () =>
      [...document.querySelectorAll('.ss-side-work-title')].find(
        (node) => node.textContent === 'Nothing linked'
      ),
    'the nothing linked line'
  );
  assert.ok(title);
  assert.ok(document.querySelector('.ss-side-work .ss-side-link'));
  assert.equal(document.querySelector('.ss-side-work [data-ref]'), null);
});
