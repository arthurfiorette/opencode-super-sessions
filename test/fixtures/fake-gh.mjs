// Stands in for `gh` in the configured host fixture and the manual live checks. Answers
// `auth status` and the GraphQL documents the GitHub provider builds from a fixed set of
// acme/widgets refs; anything else fails.

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
              contexts: counts({ SUCCESS: 88, SKIPPED: 3, FAILURE: 2 }, { SUCCESS: 1 })
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
  'acme/widgets#34': {
    __typename: 'PullRequest',
    state: 'OPEN',
    isDraft: false,
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

/** A rollup's `contexts` block with GitHub's per-state counts, unlisted states at zero. */
function counts(runs, statuses) {
  const list = (states, given) => states.map((state) => ({ state, count: given[state] ?? 0 }));
  return {
    checkRunCountsByState: list(
      [
        'ACTION_REQUIRED',
        'CANCELLED',
        'COMPLETED',
        'FAILURE',
        'IN_PROGRESS',
        'NEUTRAL',
        'PENDING',
        'QUEUED',
        'SKIPPED',
        'STALE',
        'STARTUP_FAILURE',
        'SUCCESS',
        'TIMED_OUT',
        'WAITING'
      ],
      runs
    ),
    statusContextCountsByState: list(
      ['EXPECTED', 'ERROR', 'FAILURE', 'PENDING', 'SUCCESS'],
      statuses
    )
  };
}

// Head branch of each pull request above, for `pullRequests(headRefName:)` lookups.
const branches = { 'acme/widgets@fix-titles': [34], 'acme/widgets@group-search': [90] };

const args = process.argv.slice(2);

/** Prints a `gh api --include` style response and exits like gh: 1 when GraphQL reported errors. */
function reply(body) {
  process.stdout.write(
    `HTTP/2.0 200 OK\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`
  );
  process.exit(body.errors?.length ? 1 : 0);
}

/** Answers one snapshot document by reading its aliases back out of the query text. */
function snapshot(query, variables) {
  const data = { rateLimit: { remaining: 4999, resetAt: '2099-01-01T00:00:00Z' } };
  const errors = [];
  const repositories = [...query.matchAll(/(r\d+): repository\(owner: \$o(\d+), name: \$n\d+\)/g)];
  for (const [position, match] of repositories.entries()) {
    const [, alias, index] = match;
    // Each repository's items run until the next repository selection.
    const body = query.slice(match.index, repositories[position + 1]?.index);
    const repo = `${variables[`o${index}`]}/${variables[`n${index}`]}`.toLowerCase();
    data[alias] = {};
    for (const [, item, number] of body.matchAll(/(i\d+): issueOrPullRequest\(number: (\d+)\)/g)) {
      const node = refs[`${repo}#${number}`];
      data[alias][item] = node ?? null;
      if (!node) {
        errors.push({
          type: 'NOT_FOUND',
          path: [alias, item],
          message: `Could not resolve to an issue or pull request with the number of ${number}.`
        });
      }
    }
  }
  reply(errors.length ? { data, errors } : { data });
}

/** Answers a branch lookup. */
function branch(variables) {
  const key = `${variables.owner}/${variables.name}@${variables.branch}`.toLowerCase();
  const nodes = (branches[key] ?? []).map((number) => ({
    number,
    state: refs[`${variables.owner}/${variables.name}#${number}`.toLowerCase()].state,
    headRepository: { nameWithOwner: `${variables.owner}/${variables.name}` }
  }));
  reply({
    data: {
      rateLimit: { remaining: 4999, resetAt: '2099-01-01T00:00:00Z' },
      repository: { pullRequests: { nodes } }
    }
  });
}

if (args[0] === 'auth' && args[1] === 'status') {
  console.log('github.com\n  ✓ Logged in to github.com account fixture');
  process.exit(0);
}

// Run from a user `!` command through the `gh` shim on PATH. Real gh prints the new PR's URL last.
if (args[0] === 'pr' && args[1] === 'create') {
  console.log('Creating pull request for fix-titles into main in acme/widgets\n');
  console.log('https://github.com/acme/widgets/pull/34');
  process.exit(0);
}

if (args[0] === 'api' && args[1] === 'graphql') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    const { query, variables } = JSON.parse(input);
    if (query.includes('pullRequests(headRefName')) branch(variables);
    else snapshot(query, variables);
  });
} else {
  console.error(`fake gh: unsupported command ${args.join(' ')}`);
  process.exit(2);
}
