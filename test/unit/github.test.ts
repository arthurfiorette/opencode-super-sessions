import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunResult } from '../../src/process.js';
import { parseGraphQLOutput } from '../../src/providers/github/output.js';
import {
  buildSnapshotQuery,
  parseBranchResponse,
  parseSnapshotResponse
} from '../../src/providers/github/queries.js';
import type { RefCandidate, RepoRef } from '../../src/providers/provider.js';
import { refKey } from '../../src/refs/ref.js';
import { asRun, type CapturedOutput, fixture as forgeFixture } from '../fixtures/captured.js';

/** Loads a JSON fixture from test/fixtures/github. */
function fixture<T>(name: string): T {
  return forgeFixture('github', name);
}

const NOW = Date.UTC(2026, 10, 4);

/** Candidate on github.com, optionally with a kind guess. */
function candidate(repo: string, number: number, kind?: 'pr' | 'issue'): RefCandidate {
  return { provider: 'github', host: 'github.com', repo, number, ...(kind ? { kind } : {}) };
}

test('a batch with a missing number and a missing repository still resolves every other ref', () => {
  // Same candidates, in the same order, as the live capture in snapshot.json.
  const candidates = [
    candidate('cli/cli', 14815, 'pr'),
    candidate('cli/cli', 14814),
    candidate('cli/cli', 14927),
    candidate('cli/cli', 14914),
    candidate('cli/cli', 14904),
    candidate('cli/cli', 14930),
    candidate('cli/cli', 10000),
    candidate('cli/cli', 999999),
    candidate('arthurfiorette/does-not-exist-zz', 1),
    candidate('CLI/CLI', 14815),
    // Open draft with nine unresolved review threads and a failing head commit.
    candidate('cli/cli', 14921, 'pr')
  ];
  const response = parseGraphQLOutput(asRun(fixture('snapshot.json')), NOW);
  assert.ok('data' in response, 'a non-zero exit with data must not fail the whole document');

  const entries = parseSnapshotResponse(buildSnapshotQuery(candidates), candidates, response);

  assert.deepEqual(
    entries.map((entry) =>
      'ref' in entry ? `${entry.ref.kind} ${entry.ref.number} ${entry.state.status}` : entry.reason
    ),
    [
      'pr 14815 merged',
      'issue 14814 completed',
      'pr 14927 draft',
      'pr 14914 open',
      'pr 14904 closed',
      'issue 14930 open',
      'issue 10000 not_planned',
      'not-found',
      'not-found',
      'pr 14815 merged',
      'pr 14921 draft'
    ]
  );

  const [merged, issue] = entries;
  const reviewed = entries.at(-1);
  assert.ok(merged && 'ref' in merged && issue && 'ref' in issue);
  assert.ok(reviewed && 'ref' in reviewed);
  assert.deepEqual(reviewed.state.review, {
    decision: 'review_required',
    threads: 9,
    unresolved: 9,
    checks: 'failing'
  });
  // Merged snapshots are never refetched, so they must not carry a review that would go stale.
  assert.equal(merged.state.review, undefined);
  assert.equal(merged.state.mergedAt, Date.UTC(2026, 9, 26, 18, 2, 47));
  assert.deepEqual(merged.state.closes?.map(refKey), [refKey(issue.ref)]);
  assert.deepEqual(issue.state.closedBy?.map(refKey), [refKey(merged.ref)]);
  assert.equal(issue.state.closedAt, Date.UTC(2026, 9, 26, 18, 2, 49));
});

test('branch lookups pick the repository own pull request and ignore fork PRs with the same head', () => {
  const cases: Array<[string, number[] | string, string?]> = [
    // Newer fork PRs and deleted forks (null head repository) come first in the response.
    ['axios/axios@dev', [4225]],
    // Every `patch-1` PR comes from a fork, including the open one.
    ['cli/cli@patch-1', []],
    // The same response seen from a fork checkout whose branch was pushed to acoulton/cli: the
    // newer closed PRs from other forks are skipped and the PR is numbered in cli/cli.
    ['cli/cli@patch-1', [14373], 'acoulton/cli'],
    ['cli/cli@babakks/auth-status-expired-hint', [14815]],
    ['arthurfiorette/does-not-exist-zz@x', 'not-found']
  ];
  const outputs = fixture<Record<string, CapturedOutput>>('branches.json');

  for (const [name, expected, head] of cases) {
    const [repoName = ''] = name.split('@');
    const repo: RepoRef = { provider: 'github', host: 'github.com', repo: repoName };
    const headRepo = head === undefined ? undefined : { ...repo, repo: head };
    const output = outputs[name];
    assert.ok(output, name);
    const response = parseGraphQLOutput(asRun(output), NOW);
    assert.ok('data' in response, name);

    const result = parseBranchResponse(repo, response, headRepo);
    assert.deepEqual(
      Array.isArray(result) ? result.map((ref) => `${ref.repo}#${ref.number}`) : result.reason,
      Array.isArray(expected) ? expected.map((number) => `${repoName}#${number}`) : expected,
      name
    );
  }
});

test('whole-document gh failures map to the forge error the status page and backoff rely on', () => {
  const outputs = fixture<Record<string, CapturedOutput>>('failures.json');
  /** Rebuilds the gh run for one named failure fixture. */
  const captured = (name: string): RunResult => {
    const output = outputs[name];
    assert.ok(output, name);
    return asRun(output);
  };
  const cases: Array<[string, RunResult, object]> = [
    ['bad-credentials', captured('bad-credentials'), { reason: 'unauthenticated' }],
    ['logged-out', captured('logged-out'), { reason: 'unauthenticated' }],
    [
      'graphql-rate-limit',
      captured('graphql-rate-limit'),
      { reason: 'rate-limited', retryAt: 1793753928_000 }
    ],
    [
      'secondary-rate-limit',
      captured('secondary-rate-limit'),
      { reason: 'rate-limited', retryAt: NOW + 90_000 }
    ],
    ['saml-forbidden', captured('saml-forbidden'), { reason: 'forbidden' }],
    [
      'gh not installed',
      { code: null, stdout: '', stderr: '', failure: 'missing' },
      { reason: 'missing-tool' }
    ]
  ];

  for (const [name, result, expected] of cases) {
    assert.deepEqual(parseGraphQLOutput(result, NOW), expected, name);
  }
});
