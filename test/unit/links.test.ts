import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSnapshotCache } from '../../src/cache.js';
import { github } from '../../src/providers/github/definition.js';
import { createGitLabDefinition } from '../../src/providers/gitlab/definition.js';
import type { ForgeProvider, RefCandidate } from '../../src/providers/provider.js';
import { detectInText } from '../../src/refs/detect.js';
import { readSessionRefs } from '../../src/refs/ref.js';
import { linkPrompt } from '../../src/server/detection.js';
import { createForgeHosts } from '../../src/server/hosts.js';
import { linkDetected } from '../../src/server/links.js';
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
    details: async () => ({ reason: failure }),
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
function setup(provider: ForgeProvider, hosts = createForgeHosts({ gitlab: { hosts: [] } })) {
  let metadata: Record<string, unknown> = {};
  const session = {
    get: async () => ({ metadata, time: { created: 0, updated: 0, idle: 0 } }),
    update: async (input: { metadata?: Record<string, unknown> }) => {
      metadata = input.metadata ?? {};
    }
  } as unknown as SessionAccess;
  const runtime = {
    definitions: [provider.definition],
    providers: new Map([[provider.definition.id, provider]]),
    cache: createSnapshotCache(),
    writes: createWriteQueue(),
    hosts
  } as unknown as Runtime;
  /** The stored links as `kind number`, sorted. */
  const linked = () =>
    readSessionRefs(metadata)
      .links.map((link) => `${link.ref.kind} ${link.ref.number}`)
      .sort();
  /** The stored work links' URLs. */
  const urls = () => (readSessionRefs(metadata).urls ?? []).map((link) => link.url);
  return { runtime, session, linked, urls };
}

test('a bare GitLab number from a prompt is linked only after the forge confirms it', async () => {
  for (const failure of ['missing-tool', 'failed'] as const) {
    const { runtime, session, linked, urls } = setup(fakeGitLab(failure));
    await linkPrompt(
      runtime,
      session,
      'ses_1',
      'Fix #5, then !7, and see https://gitlab.com/acme/app/-/issues/9 for ' +
        'https://linear.app/acme/issue/ENG-1 (docs: https://docs.example.com/x)',
      base
    );
    // #5 is confirmed; !7 could not be checked, and a bare number may name anything; the URL
    // names its project and kind, so it is kept while glab is down.
    assert.deepEqual(linked(), ['issue 5', 'issue 9'], failure);
    // Tracker pages need no forge; other pages in a prompt are not work.
    assert.deepEqual(urls(), ['https://linear.app/acme/issue/ENG-1'], failure);
  }
});

test('gh is asked only about hosts the user works with, and other refs are stored unchecked', async () => {
  const asked: string[] = [];
  const provider: ForgeProvider = {
    definition: github,
    available: async () => 'ok',
    branchPullRequests: async () => [],
    details: async () => ({ reason: 'failed' }),
    snapshot: async (candidates) => {
      asked.push(...candidates.map((candidate) => `${candidate.host} ${candidate.number}`));
      return candidates.map((candidate) => ({
        ref: { ...candidate, kind: 'pr' as const },
        state: { status: 'open' as const, title: '', url: '' }
      }));
    }
  };
  const hosts = createForgeHosts({ gitlab: { hosts: [] } });
  const { runtime, session, linked } = setup(provider, hosts);
  // Assistant text can name any host with a `github` label; gh would send the user's token there.
  /** Assistant text naming PR `number` by its URL on `host`. */
  const text = (host: string, number: number) => `see https://${host}/acme/app/pull/${number}`;
  /** Runs mention detection over {@link text}. */
  const mention = (host: string, number: number) =>
    linkDetected(runtime, session, 'ses_1', detectInText([github], text(host, number)), 'mention');

  await mention('github.com', 1);
  await mention('github.attacker.example', 2);
  assert.deepEqual(asked, ['github.com 1']);
  assert.deepEqual(linked(), ['pr 1', 'pr 2']);

  // The same host once a session's git remote points at it, as GitHub Enterprise Server does.
  hosts.learn({ provider: 'github', host: 'github.attacker.example', repo: 'acme/app' });
  await mention('github.attacker.example', 3);
  assert.deepEqual(asked, ['github.com 1', 'github.attacker.example 3']);
});
