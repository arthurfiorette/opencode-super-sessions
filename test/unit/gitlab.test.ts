import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunResult } from '../../src/process.js';
import { parseDetailsResponse } from '../../src/providers/gitlab/details.js';
import { parseGraphQLOutput } from '../../src/providers/gitlab/output.js';
import {
  buildSnapshotQuery,
  parseBranchResponse,
  parseSnapshotResponse,
  type SnapshotEntry,
  snapshotBatches
} from '../../src/providers/gitlab/queries.js';
import type { RefCandidate, RepoRef } from '../../src/providers/provider.js';
import { refKey } from '../../src/refs/ref.js';
import { asRun, type CapturedOutput, fixture as forgeFixture } from '../fixtures/captured.js';

// Fixture files carry a `source` note saying which shapes are live gitlab.com reads and which
// come from GitLab's docs or glab's source.

/** Loads a JSON fixture from test/fixtures/gitlab. */
function fixture<T>(name: string): T {
  return forgeFixture('gitlab', name);
}

const NOW = Date.UTC(2026, 10, 4);

/** Candidate on gitlab.com, optionally with a kind. */
function candidate(repo: string, number: number, kind?: 'pr' | 'issue'): RefCandidate {
  return { provider: 'gitlab', host: 'gitlab.com', repo, number, ...(kind ? { kind } : {}) };
}

test('details link each job to its page on the host', () => {
  const response = parseGraphQLOutput(asRun(fixture('details.json')), NOW);
  assert.ok('data' in response);
  const details = parseDetailsResponse(response, 'gitlab.com');
  assert.ok('checks' in details);
  assert.deepEqual(
    details.checks.map((check) => [check.name, check.url]),
    [
      ['lint_commit', 'https://gitlab.com/gitlab-org/cli/-/jobs/17737982341'],
      ['tests:unit', 'https://gitlab.com/gitlab-org/cli/-/jobs/17737982349'],
      ['govulncheck', 'https://gitlab.com/gitlab-org/cli/-/jobs/17737982338']
    ]
  );
});

test('a batch resolves states, kinds and closed issues, and isolates missing refs', () => {
  // Same candidates, in the same order, as the live capture in snapshot.json.
  const candidates = [
    candidate('gitlab-org/cli', 4275, 'pr'),
    candidate('gitlab-org/cli', 8701, 'issue'),
    candidate('gitlab-org/cli', 4310, 'pr'),
    candidate('gitlab-org/cli', 4308, 'pr'),
    // No kind: only an issue has this number.
    candidate('gitlab-org/cli', 8713),
    // No kind: only a merge request has this number.
    candidate('gitlab-org/cli', 4300),
    // No kind: both exist, and the merge request wins.
    candidate('gitlab-org/gitlab', 1),
    candidate('gitlab-org/cli', 999999, 'issue'),
    candidate('gitlab-org/api/client-go', 1, 'pr'),
    candidate('arthurfiorette/does-not-exist-zz', 1, 'issue'),
    candidate('GitLab-Org/CLI', 4275, 'pr'),
    // Open, five unresolved discussions and a failed head pipeline.
    candidate('gitlab-org/cli', 4268, 'pr'),
    // Open, changes requested, and a passing head pipeline with a manual job.
    candidate('gitlab-org/cli', 4156, 'pr')
  ];
  // One capture per batch: a batch over the anonymous complexity limit could not be captured.
  const { batches: outputs } = fixture<{ batches: CapturedOutput[] }>('snapshot.json');
  const batches = snapshotBatches(candidates);
  assert.equal(batches.length, outputs.length);
  const entries: Array<SnapshotEntry | undefined> = [];
  for (const [index, positions] of batches.entries()) {
    const batch = positions.map((position) => candidates[position] as RefCandidate);
    const response = parseGraphQLOutput(asRun(outputs[index] as CapturedOutput), NOW);
    assert.ok('data' in response);
    const parsed = parseSnapshotResponse(buildSnapshotQuery(batch), batch, response);
    for (const [offset, position] of positions.entries()) entries[position] = parsed[offset];
  }

  assert.deepEqual(
    entries.map((entry) =>
      entry === undefined
        ? 'missing'
        : 'ref' in entry
          ? `${entry.ref.kind} ${entry.ref.number} ${entry.state.status}`
          : entry.reason
    ),
    [
      'pr 4275 merged',
      'issue 8701 completed',
      'pr 4310 draft',
      'pr 4308 closed',
      'issue 8713 open',
      'pr 4300 merged',
      'pr 1 merged',
      'not-found',
      'pr 1 merged',
      'not-found',
      'pr 4275 merged',
      'pr 4268 open',
      'pr 4156 open'
    ]
  );

  const [merged, issue] = entries;
  const failing = entries.at(-2);
  const reviewed = entries.at(-1);
  assert.ok(merged && 'ref' in merged && issue && 'ref' in issue);
  assert.ok(failing && 'ref' in failing && reviewed && 'ref' in reviewed);
  assert.deepEqual(failing.state.review, {
    threads: 5,
    unresolved: 5,
    checks: 'failing',
    checksPassed: 14,
    checksTotal: 15
  });
  // The manual job waits for a person, so it counts neither way: 16 of 16, not 16 of 17.
  assert.deepEqual(reviewed.state.review, {
    decision: 'changes_requested',
    threads: 2,
    unresolved: 2,
    checks: 'passing',
    checksPassed: 16,
    checksTotal: 16
  });
  // The Pull requests view groups by this.
  assert.equal(reviewed.state.updatedAt, Date.UTC(2026, 10, 4, 13, 40, 17));
  // Merged snapshots are never refetched, so they must not carry a review that would go stale.
  assert.equal(merged.state.review, undefined);
  // Worktree cleanup compares local branches with this commit after squash merges.
  assert.equal(merged.state.headSha, '9ec13dc75a12438c938dda136485254b379f0c61');
  assert.equal(merged.state.mergedAt, Date.UTC(2026, 10, 2, 5, 41, 35));
  assert.deepEqual(merged.state.closes?.map(refKey), [refKey(issue.ref)]);
  assert.equal(issue.state.url, 'https://gitlab.com/gitlab-org/cli/-/work_items/8701');
});

test('branch lookups keep only merge requests from the checkout own project', () => {
  const cases: Array<[string, number[] | string, string?]> = [
    // The branch lives in a community fork, so the upstream checkout has no merge request...
    ['gitlab-org/cli@8703-preserve-release-notes-on-update', []],
    // ...while the fork checkout gets it, numbered in the upstream project.
    [
      'gitlab-org/cli@8703-preserve-release-notes-on-update',
      [4270],
      'gitlab-community/gitlab-org/cli'
    ],
    ['gitlab-org/cli@claude-transcript-incomplete-line', [4300]],
    // Newest open one among many merged ones from the same fork.
    [
      'gitlab-org/cli@renovate/gitlab.com-gitlab-org-api-client-go-v3-3.x',
      [4312],
      'gitlab-renovate-forks/cli'
    ],
    ['arthurfiorette/does-not-exist-zz@x', 'not-found']
  ];
  const outputs = fixture<Record<string, CapturedOutput>>('branches.json');

  for (const [name, expected, head] of cases) {
    const [repoName = ''] = name.split('@');
    const repo: RepoRef = { provider: 'gitlab', host: 'gitlab.com', repo: repoName };
    const headRepo = head === undefined ? undefined : { ...repo, repo: head };
    const output = outputs[name];
    assert.ok(output, name);
    const response = parseGraphQLOutput(asRun(output), NOW);
    assert.ok('data' in response, name);

    const result = parseBranchResponse(repo, response, headRepo);
    assert.deepEqual(
      Array.isArray(result) ? result.map((ref) => `${ref.repo}!${ref.number}`) : result.reason,
      Array.isArray(expected) ? expected.map((number) => `${repoName}!${number}`) : expected,
      `${name} ${head ?? ''}`
    );
  }
});

test('whole-document glab failures map to the error the status page, backoff and retry use', () => {
  const outputs = fixture<Record<string, CapturedOutput>>('failures.json');
  /** Rebuilds the glab run for one named failure fixture. */
  const captured = (name: string): RunResult => {
    const output = outputs[name];
    assert.ok(output, name);
    return asRun(output);
  };
  const cases: Array<[string, RunResult, object]> = [
    ['invalid-token', captured('invalid-token'), { reason: 'unauthenticated' }],
    ['keyring-token-missing', captured('keyring-token-missing'), { reason: 'unauthenticated' }],
    ['throttled', captured('throttled'), { reason: 'rate-limited', retryAt: NOW + 30_000 }],
    [
      'quota-spent',
      captured('quota-spent'),
      { data: { project: null }, errors: [], exhaustedUntil: 1793753280_000 }
    ],
    [
      'older-gitlab-without-closes',
      captured('older-gitlab-without-closes'),
      { reason: 'failed', missingFields: ['workItemRelations'] }
    ],
    [
      'glab not installed',
      { code: null, stdout: '', stderr: '', failure: 'missing' },
      { reason: 'missing-tool' }
    ]
  ];

  for (const [name, result, expected] of cases) {
    assert.deepEqual(parseGraphQLOutput(result, NOW), expected, name);
  }
});
