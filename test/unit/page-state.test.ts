import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionInfo } from '@opencode/client';
import {
  createPageController,
  groupSessions,
  type PageData,
  type PageDeps
} from '../../src/page/state.js';
import type { SessionRefView } from '../../src/rpc.js';

const session = (id: string): SessionInfo => ({
  id,
  title: id,
  projectID: 'p',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
  location: { directory: '/repo' }
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

/** What a publish shows: the status and the ids in each part. */
const shape = (data: PageData) => ({
  status: data.status,
  active: data.active.map((item) => item.id),
  refs: Object.keys(data.refs),
  extra: Object.keys(data.extra)
});

// Rows used to draw bare, grow their PR lines and then leave for Done within a second of opening.
test('a cold load publishes the lists with their refs and Done lookups at once', async () => {
  const published: PageData[] = [];
  const controller = createPageController(
    deps({
      list: async (input) => (input.archived ? [] : [session('done'), session('open')]),
      refs: async () => ({ done: { links: [], branchRefs: [], states: {}, done: true } })
    }),
    (data) => published.push(data)
  );
  await controller.load('project');
  assert.deepEqual(published.map(shape), [
    { status: 'ready', active: ['done', 'open'], refs: ['done'], extra: ['done'] }
  ]);
});

test('a cold load whose refs miss the deadline shows the lists, then the refs as they arrive', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const published: PageData[] = [];
  let asked = () => {};
  const refsAsked = new Promise<void>((resolve) => {
    asked = resolve;
  });
  let shown = () => {};
  const listsShown = new Promise<void>((resolve) => {
    shown = resolve;
  });
  let answer: (refs: Record<string, SessionRefView>) => void = () => {};
  const controller = createPageController(
    deps({
      list: async (input) => (input.archived ? [] : [session('slow')]),
      refs: () => {
        asked();
        return new Promise((resolve) => {
          answer = resolve;
        });
      }
    }),
    (data) => {
      published.push(data);
      shown();
    }
  );
  const loaded = controller.load('project');
  await refsAsked;
  assert.deepEqual(published, [], 'The lists wait for their refs.');
  t.mock.timers.runAll();
  await listsShown;
  answer({ slow: { links: [], branchRefs: [], states: {} } });
  await loaded;
  assert.deepEqual(published.map(shape), [
    { status: 'ready', active: ['slow'], refs: [], extra: [] },
    { status: 'ready', active: ['slow'], refs: ['slow'], extra: [] }
  ]);
});

// A metadata write of the plugin (the history scan marker on select) moved `time.updated` of a
// session the user had left, and the list showed it as just used, at the top of Today.
test('the Active list orders and groups by the last run, not by the last metadata write', () => {
  const at = (hours: number, minutes = 0) => new Date(2026, 10, 4, hours, minutes).getTime();
  const ran = (id: string, idle: number, updated: number): SessionInfo => ({
    ...session(id),
    time: { created: at(-24), updated, busy: idle - 60_000, idle }
  });
  const groups = groupSessions({
    view: 'active',
    sessions: [
      ran('scanned-today', at(20, 35), at(21, 4)),
      ran('ran-later', at(20, 50), at(20, 50)),
      ran('ran-yesterday', at(-4), at(21, 3))
    ],
    refs: {},
    extra: {},
    running: () => false,
    pins: [],
    now: at(21, 5)
  });
  assert.deepEqual(
    groups.map((group) => [group.title, group.sessions.map((item) => item.id)]),
    [
      ['Today', ['ran-later', 'scanned-today']],
      [new Date(at(-4)).toDateString(), ['ran-yesterday']]
    ]
  );
});

test('grouping by group lists the groups in option order between Running and the day groups', () => {
  const at = (hours: number) => new Date(2026, 10, 4, hours).getTime();
  const ran = (id: string, idle: number): SessionInfo => ({
    ...session(id),
    time: { created: at(-48), updated: idle, busy: idle - 60_000, idle }
  });
  const view = (group?: string): SessionRefView => ({
    links: [],
    branchRefs: [],
    states: {},
    ...(group === undefined ? {} : { group })
  });
  const input = {
    view: 'active' as const,
    sessions: [
      ran('coding-old', at(-30)),
      ran('testing', at(19)),
      ran('pinned-testing', at(18)),
      ran('running-coding', at(17)),
      ran('coding-new', at(20)),
      ran('dropped-group', at(16)),
      ran('no-group', at(15)),
      ran('no-group-yesterday', at(-20))
    ],
    refs: {
      'coding-old': view('Coding'),
      testing: view('Testing'),
      'pinned-testing': view('Testing'),
      'running-coding': view('Coding'),
      'coding-new': view('Coding'),
      // A group the options no longer list.
      'dropped-group': view('Investigating')
    },
    extra: {},
    running: (id: string) => id === 'running-coding',
    pins: ['pinned-testing'],
    now: at(21),
    groups: ['Testing', 'Review', 'Coding']
  };
  const titles = (groups: ReturnType<typeof groupSessions>) =>
    groups.map((group) => [group.title, group.sessions.map((item) => item.id)]);

  assert.deepEqual(titles(groupSessions({ ...input, groupBy: 'group' })), [
    ['Pinned', ['pinned-testing']],
    ['Running', ['running-coding']],
    ['Testing', ['testing']],
    // Review has no session, so it has no header.
    ['Coding', ['coding-new', 'coding-old']],
    ['Today', ['dropped-group', 'no-group']],
    [new Date(at(-20)).toDateString(), ['no-group-yesterday']]
  ]);
  // By day, the default, groups change nothing.
  assert.deepEqual(titles(groupSessions(input)), [
    ['Pinned', ['pinned-testing']],
    ['Running', ['running-coding']],
    ['Today', ['coding-new', 'testing', 'dropped-group', 'no-group']],
    [new Date(at(-20)).toDateString(), ['no-group-yesterday']],
    [new Date(at(-30)).toDateString(), ['coding-old']]
  ]);
  // Archived keeps its day groups.
  assert.deepEqual(
    groupSessions({ ...input, view: 'archived', groupBy: 'group' }).map((group) => group.title),
    ['Today', new Date(at(-20)).toDateString(), new Date(at(-30)).toDateString()]
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
