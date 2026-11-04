import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateKey, createSnapshotCache, type Snapshot } from '../../src/cache.js';
import type { ForgeProvider, RefCandidate } from '../../src/providers/provider.js';
import type { RefStatus } from '../../src/refs/ref.js';

const MINUTE = 60_000;

/** Candidate in one fixed repository; numbers double as test identifiers. */
function candidate(number: number, kind?: 'pr' | 'issue'): RefCandidate {
  return { provider: 'github', host: 'github.com', repo: 'o/r', number, ...(kind ? { kind } : {}) };
}

/** A resolved snapshot entry for a candidate, as the GitHub provider would return it. */
function resolved(item: RefCandidate, status: RefStatus): Snapshot {
  return {
    ref: { ...item, kind: item.kind ?? 'issue' },
    state: { status, title: `#${item.number}`, url: `https://github.com/o/r/issues/${item.number}` }
  };
}

/** Fake provider that answers through `answer` and records the numbers of every call. */
function fakeProvider(answer: (item: RefCandidate) => Snapshot | Promise<Snapshot>) {
  const calls: number[][] = [];
  const provider = {
    definition: {} as ForgeProvider['definition'],
    available: async () => 'ok' as const,
    branchPullRequests: async () => [],
    snapshot: async (items: RefCandidate[]) => {
      calls.push(items.map((item) => item.number));
      return Promise.all(items.map(answer));
    }
  } satisfies ForgeProvider;
  return { provider, calls };
}

test('open, draft and closed entries expire, resolved ones never do', async () => {
  let clock = 0;
  const cache = createSnapshotCache({ now: () => clock });
  const statuses: RefStatus[] = ['open', 'draft', 'closed', 'merged', 'completed', 'not_planned'];
  // Bare numbers: the cache must find them again after the forge resolves their kind.
  const items = statuses.map((_, index) => candidate(index + 1));
  const { provider, calls } = fakeProvider((item) =>
    resolved(item, statuses[item.number - 1] as RefStatus)
  );
  const keys = items.map(candidateKey);

  await cache.ensure(provider, items);
  assert.deepEqual(cache.stale(keys), []);

  clock = 365 * 24 * 60 * MINUTE;
  assert.deepEqual(cache.stale(keys), keys.slice(0, 3));
  await cache.ensure(provider, items);
  assert.deepEqual(calls, [
    [1, 2, 3, 4, 5, 6],
    [1, 2, 3]
  ]);
});

test('concurrent ensure calls share one provider call per ref', async () => {
  const cache = createSnapshotCache({ now: () => 0 });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { provider, calls } = fakeProvider(async (item) => {
    await gate;
    return resolved(item, 'open');
  });

  const first = cache.ensure(provider, [candidate(1, 'pr'), candidate(2, 'pr')]);
  const second = cache.ensure(provider, [candidate(2, 'pr'), candidate(3, 'pr')]);
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.deepEqual(calls, [[1, 2], [3]]);
  assert.deepEqual([...a.keys()], [candidate(1, 'pr'), candidate(2, 'pr')].map(candidateKey));
  assert.deepEqual([...b.keys()], [candidate(2, 'pr'), candidate(3, 'pr')].map(candidateKey));
});

test('a rate limit keeps the last state and blocks even forced refetches until retryAt', async () => {
  let clock = 0;
  const cache = createSnapshotCache({ now: () => clock });
  const item = candidate(7, 'pr');
  const key = candidateKey(item);
  let limited = false;
  const { provider, calls } = fakeProvider((value) =>
    limited ? { reason: 'rate-limited', retryAt: 10 * MINUTE } : resolved(value, 'open')
  );

  await cache.ensure(provider, [item]);
  limited = true;
  clock = 3 * MINUTE;
  const during = await cache.ensure(provider, [item]);
  const kept = during.get(key);
  assert.equal(calls.length, 2);
  assert.ok(kept && 'state' in kept);
  assert.equal(kept.state.status, 'open');

  // Past the 30 s error TTL but before retryAt: nothing may reach the forge.
  clock = 5 * MINUTE;
  await cache.ensure(provider, [item], { force: true });
  assert.equal(calls.length, 2);

  clock = 10 * MINUTE;
  await cache.ensure(provider, [item], { force: true });
  assert.equal(calls.length, 3);
});
