import { afterEach, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createSignal } from 'solid-js';
import { createClient, createData, createServer, startGui, until } from './harness.mjs';

const { sessionRefViewSchema } = await import('../../dist/rpc.js');

// The Super Sessions side tab in the built bundle: what the app lists, and that its session list
// reads the browser's model instead of loading its own.

const NOW = Date.now();
const HOUR = 3_600_000;
const SIDE = 'opencode-super-sessions:sessions';

const session = (id, title, hoursAgo) => ({
  id,
  title,
  projectID: 'proj',
  location: { directory: '/work/widgets' },
  time: { created: NOW - (hoursAgo + 1) * HOUR, updated: NOW - hoursAgo * HOUR }
});
const SESSIONS = [session('ses_a', 'Split the build', 1), session('ses_b', 'Read the logs', 2)];
const pr = { provider: 'github', host: 'github.com', repo: 'acme/widgets', kind: 'pr', number: 7 };
const tracking = sessionRefViewSchema.parse({
  links: [{ ref: pr, source: 'agent', linkedAt: 1 }],
  branchRefs: [],
  states: {
    'github:github.com/acme/widgets/pr/7': {
      status: 'open',
      title: 'Split the build',
      url: 'https://github.com/acme/widgets/pull/7'
    }
  }
});
const plain = sessionRefViewSchema.parse({ links: [], branchRefs: [], states: {} });
const viewsOf = (ids) =>
  Object.fromEntries(ids.map((id) => [id, id === 'ses_a' ? tracking : plain]));

let gui;
afterEach(() => gui?.dispose());

/** Starts the GUI on a fake server with `ses_a` routed; `routed` is a getter for later routes. */
async function start() {
  const client = createClient({
    'session.get': ({ sessionID }) => SESSIONS.find((item) => item.id === sessionID),
    'session.list': ({ archived }) => ({ data: archived ? [] : SESSIONS }),
    'message.list': () => ({ data: [], cursor: {} }),
    'rpc.refs': ({ sessionIDs }) => viewsOf(sessionIDs),
    'rpc.refresh': ({ sessionIDs }) => viewsOf(sessionIDs),
    'rpc.done.facts': ({ sessionIDs }) =>
      Object.fromEntries(sessionIDs.map((id) => [id, { pending: false }])),
    'rpc.search': () => []
  });
  const server = createServer({ client, data: createData() });
  const refOf = (id) => ({ server, id, key: `${server.id}\n${id}`, directory: '/work/widgets' });
  const [routed, route] = createSignal(refOf('ses_a'));
  gui = await startGui({ session: routed(), servers: [server] });
  return { client, routed, route: (id) => route(refOf(id)) };
}

const lists = (client) => client.calls.filter((call) => call.name === 'session.list').length;
const sideRow = (id) => document.querySelector(`.ss-side [data-session="${id}"]`);

test('one pinned tab in every strip, and no Work tab, menu item or command', async () => {
  const { routed } = await start();
  const panels = gui.items('panel');
  assert.deepEqual(
    panels.map((panel) => [panel.id, panel.region]),
    [['sessions', 'side']]
  );
  // Listed without being opened, in any session, as the same object.
  const [panel] = panels;
  const first = panel.list({ session: routed(), screen: {}, open: [] });
  const other = panel.list({ session: { ...routed(), id: 'ses_b' }, screen: {}, open: [] });
  assert.equal(first.length, 1);
  assert.equal(first[0].pinned, true);
  assert.equal(other[0], first[0]);
  assert.deepEqual(
    gui.items('command').map((command) => command.id),
    ['browse']
  );
  assert.deepEqual(
    gui.items('menu-item').map((item) => [item.menu, item.id]),
    [['session.panel', 'sessions']]
  );
});

test('the tab lists what the browser loaded, and a route change asks nothing again', async () => {
  const { client, routed, route } = await start();
  await gui.command('browse').run();
  await until(() => document.querySelector('[role="dialog"] [data-session="ses_b"]'), 'the dialog');
  for (const dialog of gui.dialogs) dialog.dispose();
  const loaded = lists(client);

  gui.ctx.layout.open(SIDE, routed());
  gui.panel('sessions', routed);
  await until(() => sideRow('ses_b'), 'the side rows');
  assert.ok(sideRow('ses_a').classList.contains('ss-row-current'));
  assert.equal(lists(client), loaded);

  // Another session of the project: the same lists, the current mark moves.
  route('ses_b');
  gui.ctx.layout.open(SIDE, routed());
  await until(() => sideRow('ses_b').classList.contains('ss-row-current'), 'the new current row');
  assert.equal(sideRow('ses_a').classList.contains('ss-row-current'), false);
  assert.equal(lists(client), loaded);
});

test('a click on a row opens its session in a focused tab', async () => {
  const { routed } = await start();
  gui.ctx.layout.open(SIDE, routed());
  gui.panel('sessions', routed);
  const row = await until(() => sideRow('ses_b'), 'the side rows');

  row.click();
  assert.deepEqual(gui.tabs, [{ server: 'sidecar', id: 'ses_b', focus: true }]);
});

test("the Work section shows the routed session's pull request, and a plain session one line", async () => {
  const { routed, route } = await start();
  const panel = gui.panel('sessions', routed);
  await until(
    () =>
      panel.container.querySelector(
        '.ss-side-work [data-ref="github:github.com/acme/widgets/pr/7"]'
      ),
    'the pull request'
  );

  route('ses_b');
  const none = await until(
    () => panel.container.querySelector('.ss-side-work-none'),
    'the nothing linked line'
  );
  assert.ok(none.querySelector('button'));
  assert.equal(panel.container.querySelector('.ss-side-work [data-ref]'), null);
});
