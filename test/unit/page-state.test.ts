import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionInfo } from '@opencode/client';
import { createPageController, type PageData, type PageDeps } from '../../src/page/state.js';

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
