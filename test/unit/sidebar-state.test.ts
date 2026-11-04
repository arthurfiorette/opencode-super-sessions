import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { SessionRefView } from '../../src/rpc.js';
import { createSidebarState, type SidebarSource } from '../../src/sidebar-state.js';

interface Call {
  method: keyof SidebarSource;
  sessionID: string;
  answer(view: SessionRefView): void;
}

/** A source whose calls stay pending until the test answers them, in any order. */
function deferredSource() {
  const calls: Call[] = [];
  const call = (method: keyof SidebarSource) => (sessionID: string) =>
    new Promise<SessionRefView | undefined>((resolve) =>
      calls.push({ method, sessionID, answer: resolve })
    );
  const source: SidebarSource = { refs: call('refs'), refresh: call('refresh') };
  return { calls, source };
}

/** A view told apart by its branch name. */
const view = (branch: string): SessionRefView => ({
  links: [],
  branch,
  branchRefs: [],
  states: {}
});

test('answers for a session the user left, or after disposal, never reach the screen', async () => {
  const { calls, source } = deferredSource();
  const shown: Array<string | undefined> = [];
  const controller = createSidebarState(source, (next) => shown.push(next?.branch));
  void controller.show('a');
  void controller.show('b');
  calls[0]?.answer(view('a refs'));
  await setImmediate();
  calls[1]?.answer(view('b refs'));
  await setImmediate();
  assert.deepEqual(shown, ['b refs']);

  const refresh = calls.find((item) => item.method === 'refresh');
  assert.equal(refresh?.sessionID, 'b');
  controller.dispose();
  refresh?.answer(view('b refreshed'));
  await setImmediate();
  assert.deepEqual(shown, ['b refs']);
});

test('a refresh asked for during a running one runs once afterwards instead of overlapping', async () => {
  const { calls, source } = deferredSource();
  const shown: Array<string | undefined> = [];
  const controller = createSidebarState(source, (next) => shown.push(next?.branch));
  void controller.show('a');
  calls[0]?.answer(view('cached'));
  await setImmediate();
  // The poll is in flight; a metadata change and the next poll both ask again.
  void controller.refresh();
  void controller.refresh();
  assert.equal(calls.filter((item) => item.method === 'refresh').length, 1);

  calls[1]?.answer(view('read before the new link'));
  await setImmediate();
  assert.equal(calls.length, 3, 'One follow-up refresh, not one per request.');
  calls[2]?.answer(view('with the new link'));
  await setImmediate();
  assert.equal(shown.at(-1), 'with the new link');
  assert.equal(calls.length, 3);
  controller.dispose();
});
