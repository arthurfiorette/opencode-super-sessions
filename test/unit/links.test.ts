import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSnapshotCache } from '../../src/cache.js';
import { createGitLabDefinition } from '../../src/providers/gitlab/definition.js';
import type { ForgeProvider, RefCandidate } from '../../src/providers/provider.js';
import { readSessionRefs } from '../../src/refs/ref.js';
import { linkPrompt } from '../../src/server/detection.js';
import { createWriteQueue, type SessionAccess } from '../../src/server/queue.js';
import type { Runtime } from '../../src/server/runtime.js';

// Detection links refs into session metadata without asking the user. These run the server's
// real resolution and write path against a fake forge, the external boundary.

const gitlab = createGitLabDefinition();
const base = { provider: 'gitlab', host: 'gitlab.com', repo: 'acme/app' } as const;

/** A GitLab provider that only knows issue 5 and fails every other lookup as `failure` would. */
function fakeGitLab(failure: 'missing-tool' | 'failed'): ForgeProvider {
  return {
    definition: gitlab,
    available: async () => 'ok',
    branchPullRequests: async () => [],
    snapshot: async (candidates: RefCandidate[]) =>
      candidates.map((candidate) =>
        candidate.number === 5
          ? {
              ref: { ...candidate, kind: 'issue' as const },
              state: { status: 'open' as const, title: 'Five', url: '' }
            }
          : { reason: failure }
      )
  };
}

/** One in-memory session and the server pieces detection writes through. */
function setup(provider: ForgeProvider) {
  let metadata: Record<string, unknown> = {};
  const session = {
    get: async () => ({ metadata }),
    update: async (input: { metadata?: Record<string, unknown> }) => {
      metadata = input.metadata ?? {};
    }
  } as unknown as SessionAccess;
  const runtime = {
    definitions: [gitlab],
    providers: new Map([['gitlab', provider]]),
    cache: createSnapshotCache(),
    writes: createWriteQueue()
  } as unknown as Runtime;
  const linked = () =>
    readSessionRefs(metadata)
      .links.map((link) => `${link.ref.kind} ${link.ref.number}`)
      .sort();
  return { runtime, session, linked };
}

test('a bare GitLab number from a prompt is linked only after the forge confirms it', async () => {
  for (const failure of ['missing-tool', 'failed'] as const) {
    const { runtime, session, linked } = setup(fakeGitLab(failure));
    await linkPrompt(
      runtime,
      session,
      'ses_1',
      'Fix #5, then !7, and see https://gitlab.com/acme/app/-/issues/9',
      base
    );
    // #5 is confirmed; !7 could not be checked, and a bare number may name anything; the URL
    // names its project and kind, so it is kept while glab is down.
    assert.deepEqual(linked(), ['issue 5', 'issue 9'], failure);
  }
});
