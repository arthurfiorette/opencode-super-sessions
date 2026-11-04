// The part of the `gh` command line the GitHub provider calls: `auth status`, `pr create` and the
// GraphQL documents it builds (snapshots with aliases, pull request details, branch lookups).
// `test/fixtures/fake-gh.mjs` and the demo's fake gh (`demo/forge/gh.mjs`) answer it from their
// own data sets, so the protocol lives here once.

/** A rollup's `contexts` block with GitHub's per-state counts, unlisted states at zero. */
export function counts(runs, statuses) {
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

/** A check run of the GitHub Actions workflow `workflow` in `repo`; no conclusion means running. */
export function checkRun(repo, workflow, name, conclusion) {
  return {
    __typename: 'CheckRun',
    name,
    status: conclusion ? 'COMPLETED' : 'IN_PROGRESS',
    conclusion,
    detailsUrl: `https://github.com/${repo}/actions/runs/1/job/${encodeURIComponent(name)}`,
    url: `https://github.com/${repo}/runs/${encodeURIComponent(name)}`,
    startedAt: '2026-11-03T16:00:00Z',
    completedAt: conclusion ? '2026-11-03T16:10:00Z' : null,
    checkSuite: { workflowRun: { workflow: { name: workflow } } }
  };
}

const rateLimit = { remaining: 4999, resetAt: '2099-01-01T00:00:00Z' };

/** Prints a `gh api --include` style response and exits like gh: 1 when GraphQL reported errors. */
function reply(body) {
  process.stdout.write(
    `HTTP/2.0 200 OK\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`
  );
  process.exit(body.errors?.length ? 1 : 0);
}

/** Answers one snapshot document by reading its aliases back out of the query text. */
function snapshot(refs, query, variables) {
  const data = { rateLimit };
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

/** Answers the details lookup of one pull request. */
function pullDetails(details, variables) {
  const found = details[`${variables.owner}/${variables.name}#${variables.number}`.toLowerCase()];
  if (!found) {
    reply({
      data: { rateLimit, repository: { pullRequest: null } },
      errors: [{ type: 'NOT_FOUND', path: ['repository', 'pullRequest'], message: 'Not found' }]
    });
    return;
  }
  const { checks, ...rest } = found;
  const contexts = { pageInfo: { hasNextPage: false }, nodes: checks };
  reply({
    data: {
      rateLimit,
      repository: {
        pullRequest: {
          ...rest,
          commits: { nodes: [{ commit: { statusCheckRollup: { contexts } } }] }
        }
      }
    }
  });
}

/** Answers a branch lookup. A pull request without `createdAt` in the data set gets null. */
function branch(refs, branches, variables) {
  const key = `${variables.owner}/${variables.name}@${variables.branch}`.toLowerCase();
  const nodes = (branches[key] ?? []).map((number) => {
    const node = refs[`${variables.owner}/${variables.name}#${number}`.toLowerCase()];
    return {
      number,
      state: node.state,
      createdAt: node.createdAt ?? null,
      headRepository: { nameWithOwner: `${variables.owner}/${variables.name}` }
    };
  });
  reply({ data: { rateLimit, repository: { pullRequests: { nodes } } } });
}

/**
 * Answers the gh command in `process.argv` from a data set and exits; anything else fails with
 * exit code 2.
 * - `refs`: snapshot nodes keyed `owner/name#number`, lower case. Branch lookups also read a
 *   pull request's `createdAt` from here.
 * - `details`: pull request details keyed the same way, with their check runs in `checks`.
 * - `branches`: pull request numbers keyed `owner/name@branch`, for head branch lookups.
 * - `created`: the lines `gh pr create` prints, the new pull request's URL last.
 */
export function serveGh({ refs, details, branches, created }) {
  const args = process.argv.slice(2);

  if (args[0] === 'auth' && args[1] === 'status') {
    console.log('github.com\n  ✓ Logged in to github.com account fixture');
    process.exit(0);
  }

  if (args[0] === 'pr' && args[1] === 'create' && created) {
    for (const line of created) console.log(line);
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
      if (query.includes('pullRequests(headRefName')) branch(refs, branches, variables);
      else if (query.includes('pullRequest(number: $number)')) pullDetails(details, variables);
      else snapshot(refs, query, variables);
    });
    return;
  }

  console.error(`fake gh: unsupported command ${args.join(' ')}`);
  process.exit(2);
}
