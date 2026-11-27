import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSnapshotCache } from '../../src/cache.js';
import { github } from '../../src/providers/github/definition.js';
import type { ForgeProvider } from '../../src/providers/provider.js';
import { type Ref, type RefLink, readSessionRefs, refKey } from '../../src/refs/ref.js';
import { createBranchCache } from '../../src/server/branches.js';
import { createForgeHosts } from '../../src/server/hosts.js';
import { createWriteQueue, type SessionAccess } from '../../src/server/queue.js';
import type { Runtime } from '../../src/server/runtime.js';
import { buildViews, collectViews } from '../../src/server/views.js';

// Which branch pull request belongs to a session decides what its rows, sidebar, Done and
// auto-archive see, while worktree cleanup must keep seeing every pull request of the checkout.
// These run the server's real view, cache and write path against a fake forge, the external
// boundary.

const MINUTE = 60_000;
const CREATED = Date.UTC(2026, 10, 4, 12);
const repo = { provider: 'github', host: 'github.com', repo: 'acme/app' } as const;
const pr: Ref = { ...repo, kind: 'pr', number: 7 };
const issue: Ref = { ...repo, kind: 'issue', number: 3 };

/** A link stored before the view ran. */
const stored = (ref: Ref, source: RefLink['source'], via?: string): RefLink =>
  via === undefined ? { ref, source, linkedAt: 1 } : { ref, source, linkedAt: 1, via };

/**
 * A session created at {@link CREATED} in a checkout on the pushed branch `feature`, whose pull
 * request #7 was opened at `opened`, is merged and closes issue #3.
 */
function setup(opened: number, refs: { links?: RefLink[]; pushed?: string[] }) {
  let metadata: Record<string, unknown> = {
    'super-sessions': { v: 1, links: refs.links ?? [], dismissed: [], pushed: refs.pushed }
  };
  let writes = 0;
  const session = {
    get: async () => ({ metadata, location: { directory: '/work' }, time: { created: CREATED } }),
    update: async (input: { metadata?: Record<string, unknown> }) => {
      writes++;
      metadata = input.metadata ?? {};
    }
  } as unknown as SessionAccess;
  const provider: ForgeProvider = {
    definition: github,
    available: async () => 'ok',
    details: async () => ({ reason: 'failed' }),
    branchPullRequests: async () => [{ ref: pr, createdAt: opened }],
    snapshot: async (candidates) =>
      candidates.map((candidate) =>
        candidate.number === pr.number
          ? { ref: pr, state: { status: 'merged', title: 'Fix', url: '', closes: [issue] } }
          : { ref: issue, state: { status: 'completed', title: 'Bug', url: '' } }
      )
  };
  const runtime = {
    definitions: [github],
    providers: new Map([['github', provider]]),
    repos: {
      resolve: async () => ({
        repo,
        remote: 'origin',
        defaultBranch: 'main',
        branch: 'feature',
        upstream: true
      })
    },
    branches: createBranchCache({ isOpen: () => false }),
    cache: createSnapshotCache(),
    writes: createWriteQueue(),
    hosts: createForgeHosts({ gitlab: { hosts: [] } }),
    refreshing: new Set<string>()
  } as unknown as Runtime;
  return { runtime, session, metadata: () => metadata, writes: () => writes };
}

// Every metadata write moves the session's `time.updated`, and the browser reads `refs` for every
// listed session on each open: a write there reordered and re-dated sessions nobody touched.
test('refs shows the issues a merged pull request closes without writing, and refresh stores them', async () => {
  const { runtime, session, metadata, writes } = setup(CREATED + MINUTE, {});
  const read = () => buildViews(runtime, session, ['ses_1'], { wait: false });
  await read();
  // The first read finds nothing cached and starts the background refresh that fills the caches.
  for (let turn = 0; runtime.refreshing.size > 0 && turn < 1000; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(runtime.refreshing.size, 0);
  const view = (await read()).ses_1;
  assert.deepEqual(named(view?.links ?? []), ['issue 3 closes']);
  assert.equal(writes(), 0);
  assert.deepEqual(readSessionRefs(metadata()).links, []);

  await buildViews(runtime, session, ['ses_1'], { wait: true });
  assert.deepEqual(named(readSessionRefs(metadata()).links), ['issue 3 closes']);
});

/** Links as `kind number source`. */
const named = (links: RefLink[]) =>
  links.map((link) => `${link.ref.kind} ${link.ref.number} ${link.source}`);

test('a branch pull request counts for a session only when it was opened in it or the session pushed', async () => {
  const via = refKey(pr);
  const cases: Array<{
    name: string;
    opened: number;
    links?: RefLink[];
    pushed?: string[];
    branch: number[];
    shown: string[];
    kept: string[];
  }> = [
    {
      name: 'opened a day before the session, which never pushed',
      opened: CREATED - 24 * 60 * MINUTE,
      branch: [],
      shown: [],
      kept: []
    },
    {
      name: 'opened just past the clock slack',
      opened: CREATED - 3 * MINUTE,
      branch: [],
      shown: [],
      kept: []
    },
    {
      name: 'opened within the clock slack',
      opened: CREATED - MINUTE,
      branch: [7],
      shown: ['issue 3 closes'],
      kept: ['issue 3 closes']
    },
    {
      name: 'opened after the session',
      opened: CREATED + 60 * MINUTE,
      branch: [7],
      shown: ['issue 3 closes'],
      kept: ['issue 3 closes']
    },
    {
      name: 'opened before, on a branch the session pushed',
      opened: CREATED - 24 * 60 * MINUTE,
      pushed: ['feature'],
      branch: [7],
      shown: ['issue 3 closes'],
      kept: ['issue 3 closes']
    },
    {
      name: 'opened before, and the session pushed another branch',
      opened: CREATED - 24 * 60 * MINUTE,
      pushed: ['other'],
      branch: [],
      shown: [],
      kept: []
    },
    {
      name: 'a closes link stored through it before the rule stays stored but hidden',
      opened: CREATED - 24 * 60 * MINUTE,
      links: [stored(issue, 'closes', via)],
      branch: [],
      shown: [],
      kept: ['issue 3 closes']
    },
    {
      name: 'the user named the pull request in a prompt',
      opened: CREATED - 24 * 60 * MINUTE,
      links: [stored(pr, 'prompt')],
      branch: [],
      shown: ['pr 7 prompt', 'issue 3 closes'],
      kept: ['pr 7 prompt', 'issue 3 closes']
    },
    {
      name: 'the user linked the issue it closes',
      opened: CREATED - 24 * 60 * MINUTE,
      links: [stored(issue, 'manual')],
      branch: [],
      shown: ['issue 3 manual'],
      kept: ['issue 3 manual']
    }
  ];

  for (const { name, opened, links, pushed, branch, shown, kept } of cases) {
    const { runtime, session, metadata } = setup(opened, {
      ...(links === undefined ? {} : { links }),
      ...(pushed === undefined ? {} : { pushed })
    });
    const built = (await collectViews(runtime, session, ['ses_1'], { wait: true }))['ses_1'];
    assert.ok(built, name);
    assert.deepEqual(
      built.view.branchRefs.map((ref) => ref.number),
      branch,
      name
    );
    assert.deepEqual(named(built.view.links), shown, name);
    assert.deepEqual(named(readSessionRefs(metadata()).links), kept, name);
    // Cleanup decides per checkout: the merged pull request is there whoever opened it.
    assert.deepEqual(
      built.checkout.branchRefs.map((ref) => ref.number),
      [7],
      name
    );
    assert.equal(built.checkout.states[via]?.status, 'merged', name);
  }
});
