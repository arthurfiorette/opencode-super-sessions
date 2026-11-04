import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionInfo } from '@opencode/client';
import {
  createPageController,
  groupSessions,
  keepSelection,
  type PageData,
  type PageDeps
} from '../../src/page/state.js';
import { refKey } from '../../src/refs/ref.js';
import type { SessionRefView } from '../../src/rpc.js';

const DAY = 86_400_000;
// Noon, so "yesterday" never crosses a daylight saving boundary into the same date.
const NOW = new Date(2026, 10, 4, 12).getTime();

const session = (id: string, time: Partial<SessionInfo['time']> = {}): SessionInfo => ({
  id,
  title: id,
  projectID: 'p',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: NOW, ...time },
  location: { directory: '/repo' }
});

const merged = (mergedAt: number): SessionRefView => {
  const ref = {
    provider: 'github',
    host: 'github.com',
    repo: 'acme/app',
    kind: 'pr',
    number: 1
  } as const;
  return {
    links: [{ ref, source: 'agent', linkedAt: 1 }],
    branchRefs: [],
    states: { [refKey(ref)]: { status: 'merged', title: 'Ship it', url: 'u', mergedAt } }
  };
};

const titles = (groups: ReturnType<typeof groupSessions>) =>
  groups.map((group) => [group.title, group.sessions.map((item) => item.id)]);

test('Active puts pins first in pin order, running next, and leaves confirmed Done sessions out', () => {
  const yesterday = new Date(NOW - DAY).toDateString();
  const sessions = [
    session('today', { updated: NOW - 1000 }),
    session('running-old', { updated: NOW - 3 * DAY }),
    session('pin-a'),
    session('pin-b', { updated: NOW - 5 * DAY }),
    session('done', { updated: NOW - 2000 }),
    session('unchecked', { updated: NOW - 3000 }),
    session('older', { updated: NOW - DAY }),
    { ...session('child'), parentID: 'today' }
  ];
  const refs = { done: merged(NOW - 500), unchecked: merged(NOW - 500) };
  const input = {
    sessions,
    refs,
    // `unchecked` could be Done, but its pending and last-message lookups have not returned.
    extra: { done: { pending: false } },
    running: (id: string) => id === 'running-old' || id === 'pin-a',
    pins: ['pin-b', 'gone', 'pin-a'],
    now: NOW
  };
  assert.deepEqual(titles(groupSessions({ ...input, view: 'active' })), [
    ['Pinned', ['pin-b', 'pin-a']],
    ['Running', ['running-old']],
    ['Today', ['today', 'unchecked']],
    [yesterday, ['older']]
  ]);
  assert.deepEqual(titles(groupSessions({ ...input, view: 'done' })), [['Today', ['done']]]);
});

test('Archived groups by archive day, newest update first within a day', () => {
  const sessions = [
    session('old-update', { archived: NOW - 100, updated: NOW - 5 * DAY }),
    session('archived-yesterday', { archived: NOW - DAY, updated: NOW }),
    session('new-update', { archived: NOW - 200, updated: NOW - DAY })
  ];
  const groups = groupSessions({
    view: 'archived',
    sessions,
    refs: {},
    extra: {},
    running: () => false,
    pins: [],
    now: NOW
  });
  assert.deepEqual(titles(groups), [
    ['Today', ['new-update', 'old-update']],
    [new Date(NOW - DAY).toDateString(), ['archived-yesterday']]
  ]);
});

test('archiving the selected row selects the row that takes its place', () => {
  const [a, b, c] = [session('a'), session('b'), session('c')];
  assert.equal(keepSelection([a, b, c], [a, c], 'b'), 'c');
  assert.equal(keepSelection([a, b, c], [a, b], 'c'), 'b');
  assert.equal(keepSelection([a, b, c], [c, a, b], 'a'), 'a');
  assert.equal(keepSelection([a], [], 'a'), undefined);
});

/** Controller deps where only the session lists and search are wired. */
function deps(overrides: Partial<PageDeps>): PageDeps {
  return {
    list: async () => [],
    get: async (id) => session(id),
    search: async () => [],
    refs: async () => ({}),
    refresh: async () => ({}),
    running: () => false,
    pending: async () => false,
    lastUserMessageAt: async () => undefined,
    ...overrides
  };
}

/** Runs a search to completion and returns the settled search state. */
async function search(page: PageDeps, query: string) {
  let settle: (data: PageData) => void = () => {};
  const settled = new Promise<PageData>((resolve) => {
    settle = resolve;
  });
  const controller = createPageController(page, (data) => {
    if (data.search && data.search.status !== 'searching') settle(data);
  });
  await controller.load('project');
  controller.search(query, false, 'project');
  const data = await settled;
  controller.dispose();
  return data.search;
}

test('search keeps the RPC ranking and fetches hits outside the loaded list', async () => {
  const result = await search(
    deps({
      list: async ({ archived }) => (archived ? [] : [session('loaded-a'), session('loaded-b')]),
      search: async () => [
        { sessionID: 'loaded-b', match: 'ref-number', score: 2 },
        { sessionID: 'not-loaded', match: 'ref-title', score: 1 },
        { sessionID: 'loaded-a', match: 'ref-title', score: 1 }
      ]
    }),
    '#4930'
  );
  assert.equal(result?.status, 'done');
  assert.deepEqual(
    result?.sessions.map((item) => item.id),
    ['loaded-b', 'not-loaded', 'loaded-a']
  );
});

test('search falls back to the title search when the server plugin does not answer', async () => {
  const calls: unknown[] = [];
  const result = await search(
    deps({
      list: async (input) => {
        calls.push(input);
        return input.search ? [session('title-hit')] : [];
      },
      search: async () => {
        throw new Error('rpc not registered');
      }
    }),
    ' rollup '
  );
  assert.deepEqual(calls.at(-1), { archived: false, scope: 'project', search: 'rollup' });
  assert.deepEqual(
    result?.sessions.map((item) => item.id),
    ['title-hit']
  );
});

test('refs of a superseded load never overwrite the newer load', async () => {
  // Toggling the scope twice: the first load's refs answer last, as a cold server would.
  let answerFirst: (refs: Record<string, SessionRefView>) => void = () => {};
  const first = new Promise<Record<string, SessionRefView>>((resolve) => {
    answerFirst = resolve;
  });
  const answers = [first, Promise.resolve({ a: merged(NOW) })];
  const controller = createPageController(
    deps({
      list: async ({ archived }) => (archived ? [] : [session('a')]),
      refs: () => answers.shift() ?? Promise.resolve({})
    }),
    () => {}
  );
  const older = controller.load('project');
  // Lets the first load's lists arrive so its refs call is in flight.
  await new Promise((resolve) => setImmediate(resolve));
  await controller.load('all');
  answerFirst({ a: { links: [], branchRefs: [], states: {} } });
  await older;
  assert.deepEqual(controller.snapshot().refs, { a: merged(NOW) });
  controller.dispose();
});
