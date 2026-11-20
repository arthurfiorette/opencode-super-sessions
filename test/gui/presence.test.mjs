import { afterEach, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createClient, createServer, startGui, until } from './harness.mjs';

// Cleanup keeps the worktrees of open sessions and removal has no undo, so a session open in a
// Desktop tab must reach the server as open, like a TUI's.

let gui;
afterEach(() => gui?.dispose());

test('the window reports its open session tabs, and again when they change', async () => {
  const reports = [];
  const client = createClient({
    'rpc.presence': (input) => {
      reports.push(input);
      return {};
    }
  });
  const server = createServer({ client });
  const tab = (key, id) => ({ key, session: id && { server, id, key: `${server.id}\n${id}` } });
  gui = await startGui({ servers: [server], tabs: [tab('a', 'ses_a'), tab('draft')] });

  await until(() => reports.length > 0, 'the first report');
  assert.deepEqual(reports.at(-1).open, ['ses_a']);
  assert.deepEqual(reports.at(-1).pinned, []);

  gui.setTabs([tab('a', 'ses_a'), tab('b', 'ses_b')]);
  await until(() => reports.at(-1).open.length === 2, 'the report after the change');
  assert.deepEqual(reports.at(-1).open, ['ses_a', 'ses_b']);
  // One window, one client id, across its reports.
  assert.equal(new Set(reports.map((report) => report.clientID)).size, 1);
});
