// Stands in for `gh` in the configured host fixture and the manual live checks. Answers
// `auth status`, `pr create` and the GraphQL documents the GitHub provider builds from a fixed
// set of acme/widgets refs; anything else fails. The protocol is in gh-protocol.mjs.

import { checkRun, counts, serveGh } from './gh-protocol.mjs';

/** A check run of acme/widgets' workflow `workflow`. */
const run = (workflow, name, conclusion) => checkRun('acme/widgets', workflow, name, conclusion);

const refs = {
  'acme/widgets#12': {
    __typename: 'Issue',
    state: 'OPEN',
    stateReason: null,
    title: 'Login fails on Safari',
    url: 'https://github.com/acme/widgets/issues/12',
    closedAt: null,
    closedByPullRequestsReferences: { nodes: [] }
  },
  'acme/widgets#56': {
    __typename: 'Issue',
    state: 'OPEN',
    stateReason: null,
    title: 'Session list cuts titles off',
    url: 'https://github.com/acme/widgets/issues/56',
    closedAt: null,
    closedByPullRequestsReferences: {
      nodes: [{ number: 34, repository: { nameWithOwner: 'acme/widgets' } }]
    }
  },
  // Merged, for worktree cleanup.
  'acme/widgets#78': {
    __typename: 'PullRequest',
    state: 'MERGED',
    isDraft: false,
    title: 'Speed up the widget list',
    url: 'https://github.com/acme/widgets/pull/78',
    mergedAt: '2026-11-01T10:00:00Z',
    closedAt: '2026-11-01T10:00:00Z',
    updatedAt: '2026-11-01T10:00:00Z',
    closingIssuesReferences: { nodes: [] }
  },
  // Open with review trouble: changes requested, three of four threads open, a failing head.
  'acme/widgets#90': {
    __typename: 'PullRequest',
    state: 'OPEN',
    isDraft: false,
    title: 'Group search results by day',
    url: 'https://github.com/acme/widgets/pull/90',
    mergedAt: null,
    closedAt: null,
    reviewDecision: 'CHANGES_REQUESTED',
    headRefOid: '9a0c2f3e4b5d6a7c8e9f0a1b2c3d4e5f6a7b8c9d',
    closingIssuesReferences: {
      nodes: [{ number: 61, repository: { nameWithOwner: 'acme/widgets' } }]
    },
    latestReviews: { nodes: [{ state: 'CHANGES_REQUESTED' }] },
    reviewThreads: {
      totalCount: 4,
      nodes: [
        { isResolved: false },
        { isResolved: true },
        { isResolved: false },
        { isResolved: false }
      ]
    },
    updatedAt: '2026-11-03T16:20:00Z',
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              state: 'FAILURE',
              contexts: counts(
                { SUCCESS: 84, SKIPPED: 3, FAILURE: 5, TIMED_OUT: 1 },
                { SUCCESS: 1 }
              )
            }
          }
        }
      ]
    }
  },
  // Issues for a session that tracks three at once.
  ...Object.fromEntries(
    [
      [61, 'OPEN', 'Search results come back out of date order'],
      [62, 'CLOSED', 'Server hits land after older local ones'],
      [63, 'OPEN', 'Keep the selection when hits arrive']
    ].map(([number, state, title]) => [
      `acme/widgets#${number}`,
      {
        __typename: 'Issue',
        state,
        stateReason: state === 'CLOSED' ? 'COMPLETED' : null,
        title,
        url: `https://github.com/acme/widgets/issues/${number}`,
        closedAt: state === 'CLOSED' ? '2026-11-02T10:00:00Z' : null,
        closedByPullRequestsReferences: { nodes: [] }
      }
    ])
  ),
  // Opened before any session a fixture creates, so its branch lookup counts it only for a
  // session that pushed fix-titles.
  'acme/widgets#34': {
    __typename: 'PullRequest',
    state: 'OPEN',
    isDraft: false,
    createdAt: '2026-11-01T09:00:00Z',
    title: 'Show full session titles',
    url: 'https://github.com/acme/widgets/pull/34',
    mergedAt: null,
    closedAt: null,
    updatedAt: '2026-11-04T09:10:00Z',
    reviewDecision: 'APPROVED',
    closingIssuesReferences: {
      nodes: [{ number: 56, repository: { nameWithOwner: 'acme/widgets' } }]
    },
    latestReviews: { nodes: [{ state: 'APPROVED' }] },
    reviewThreads: { totalCount: 0, nodes: [] },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              state: 'PENDING',
              contexts: counts({ SUCCESS: 12, IN_PROGRESS: 2 }, {})
            }
          }
        }
      ]
    }
  }
};

// What the Pull requests view's preview asks for one pull request.
const details = {
  'acme/widgets#90': {
    author: { login: 'octo-dev' },
    headRefName: 'group-search',
    baseRefName: 'main',
    body: '## Summary\n\nGroups search results by **day**, like the session list.\n\n- Running first\n- Then `Today` and dated groups\n\nFixes #61.',
    checks: [
      run('CI', 'Lint', 'FAILURE'),
      run('CI', 'Unit tests (node 24)', 'SUCCESS'),
      run('CI', 'Unit tests (node 22)', 'SUCCESS'),
      // A re-run of the same check: the preview keeps the newest.
      { ...run('CI', 'E2E', 'FAILURE'), completedAt: '2026-11-03T16:05:00Z' },
      run('CI', 'E2E', 'FAILURE'),
      run('CI', 'Typecheck', 'FAILURE'),
      run('Integration', 'Integration (linux)', 'FAILURE'),
      run('Integration', 'Integration (macos)', 'TIMED_OUT'),
      // An app without a details page: the link falls back to the run on github.com.
      { ...run('Integration', 'Integration (windows)', 'FAILURE'), detailsUrl: null },
      run('Docs', 'Build docs', 'SKIPPED'),
      {
        __typename: 'StatusContext',
        context: 'Vercel – widgets-preview',
        state: 'SUCCESS',
        targetUrl: 'https://vercel.com/acme/widgets',
        createdAt: '2026-11-03T16:02:00Z'
      }
    ]
  },
  'acme/widgets#34': {
    author: { login: 'octo-dev' },
    headRefName: 'fix-titles',
    baseRefName: 'main',
    body: 'Shows the **full** session title in the list instead of cutting it at 40 cells.\n\nCloses #56.',
    checks: [run('CI', 'Lint', 'SUCCESS'), run('CI', 'Unit tests', null), run('CI', 'Build', null)]
  }
};

// Head branch of each pull request above, for `pullRequests(headRefName:)` lookups.
const branches = { 'acme/widgets@fix-titles': [34], 'acme/widgets@group-search': [90] };

serveGh({
  refs,
  details,
  branches,
  // Run from a user `!` command through the `gh` shim on PATH. Real gh prints the new PR's URL
  // last.
  created: [
    'Creating pull request for fix-titles into main in acme/widgets\n',
    'https://github.com/acme/widgets/pull/34'
  ]
});
