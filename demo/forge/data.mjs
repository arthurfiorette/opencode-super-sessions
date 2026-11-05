// The fake GitHub and GitLab the demo's sessions point at. Every time is relative to the seed
// time (`now`), so ages in the browser read the same after every reseed. Numbers and titles
// match the links in demo/sessions.mjs; README screenshots depend on both.

import { checkRun, counts } from '../../test/fixtures/gh-protocol.mjs';

const HOUR = 3_600_000;

/** Pull requests, then issues, of the GitHub repositories, in a compact form. */
function githubItems() {
  return {
    'acme/storefront': [
      {
        number: 482,
        title: 'Redesign the checkout summary step',
        state: 'open',
        updated: 0.3,
        head: 'checkout-redesign',
        author: 'ana-acme',
        review: 'CHANGES_REQUESTED',
        // Three of four threads still open.
        threads: [false, true, false, false],
        conflicts: true,
        closes: [470],
        checks: [
          ['CI', 'Lint', 'FAILURE'],
          ['CI', 'Typecheck', 'FAILURE'],
          ['CI', 'Unit tests (node 22)', 'FAILURE'],
          ['CI', 'Unit tests (node 24)', 'SUCCESS'],
          ['E2E', 'Checkout flow (chromium)', 'FAILURE'],
          ['E2E', 'Checkout flow (webkit)', 'TIMED_OUT'],
          ['E2E', 'Visual regression', 'FAILURE'],
          ['Deploy', 'Approve preview deploy', 'ACTION_REQUIRED'],
          ['CI', 'Bundle size', 'CANCELLED'],
          ['Docs', 'Build storybook', 'SKIPPED']
        ],
        passedExtra: 38,
        body: [
          '## Summary',
          '',
          'Rebuilds the checkout **summary step** on the new `OrderSummary` component.',
          '',
          '- The shipping estimate stays visible on small screens (#470)',
          '- Line items collapse after five products, with a *Show all* toggle',
          '- Totals come from `useCartTotals()` instead of three separate selectors',
          '',
          '## Testing',
          '',
          '```sh',
          'pnpm test --filter checkout',
          'pnpm e2e checkout-summary',
          '```',
          '',
          '> The visual regression baseline changes on purpose; approve it after review.',
          '',
          'Closes #470.'
        ]
      },
      {
        number: 491,
        title: 'Show gift card balance in the cart',
        state: 'draft',
        updated: 1.8,
        head: 'gift-cards',
        author: 'ben-acme',
        checks: [
          ['CI', 'Lint', 'SUCCESS'],
          ['CI', 'Unit tests (node 22)', null],
          ['CI', 'Unit tests (node 24)', null],
          ['E2E', 'Cart (chromium)', null]
        ],
        passedExtra: 11,
        body: [
          'Work in progress.',
          '',
          '- [x] Read the balance from `/v2/gift-cards/:code`',
          '- [ ] Show it in the cart drawer',
          '- [ ] Handle expired cards'
        ]
      },
      {
        number: 476,
        title: 'Fix rounding in multi-currency totals',
        state: 'open',
        updated: 4.5,
        head: 'fix-currency-rounding',
        author: 'chloe-acme',
        review: 'APPROVED',
        threads: [true, true],
        closes: [468],
        checks: [
          ['CI', 'Lint', 'SUCCESS'],
          ['CI', 'Unit tests', 'SUCCESS'],
          ['Docs', 'Build storybook', 'SKIPPED']
        ],
        passedExtra: 41,
        statuses: { SUCCESS: 1 },
        body: [
          'Totals were summed in floating point and rounded once at the end, so EUR and JPY carts',
          'could be a cent off. Amounts are now integer **minor units** end to end:',
          '',
          '```ts',
          'const total = items.reduce((sum, item) => sum + toMinor(item.price, currency), 0);',
          '```',
          '',
          'Fixes #468.'
        ]
      },
      {
        number: 479,
        title: 'Lazy-load product images below the fold',
        state: 'open',
        updated: 29,
        head: 'lazy-images',
        author: 'ana-acme',
        review: 'REVIEW_REQUIRED',
        checks: [
          ['CI', 'Lint', 'SUCCESS'],
          ['E2E', 'Product page (chromium)', 'CANCELLED'],
          ['E2E', 'Product page (webkit)', 'CANCELLED']
        ],
        passedExtra: 23,
        body: [
          'Adds `loading="lazy"` and explicit sizes to every product image after the first row.',
          '',
          'Largest Contentful Paint on the category page drops from **2.9 s to 1.7 s** on the',
          'throttled profile.'
        ]
      },
      {
        number: 484,
        title: 'Make coupon codes case-insensitive',
        state: 'open',
        updated: 70,
        head: 'coupon-case',
        author: 'ben-acme',
        review: 'APPROVED',
        threads: [false, false, true],
        checks: [
          ['CI', 'Lint', 'SUCCESS'],
          ['CI', 'Unit tests', 'SUCCESS']
        ],
        passedExtra: 30,
        body: [
          'Normalizes coupon codes with `toUpperCase()` before the lookup and stores them upper',
          'case. Existing codes are already upper case, so no migration is needed.'
        ]
      },
      {
        number: 460,
        title: 'Migrate the product grid to CSS container queries',
        state: 'closed',
        updated: 122,
        closedAt: 122,
        head: 'grid-container-queries',
        author: 'chloe-acme',
        body: ['Closed: Safari 15 is still 6% of our traffic and has no container queries.']
      },
      {
        number: 451,
        title: 'Send a reminder email for saved carts',
        state: 'merged',
        updated: 46,
        mergedAt: 46,
        head: 'saved-cart-reminder',
        author: 'ana-acme',
        closes: [447],
        body: ['Sends one reminder 24 hours after a cart is saved, never more than one per week.']
      },
      {
        number: 432,
        title: 'Prototype one-click reorder',
        state: 'merged',
        updated: 200,
        mergedAt: 200,
        head: 'one-click-reorder',
        author: 'ben-acme',
        body: [
          'Behind the `reorder` flag. Reuses the address and payment method of the last order.'
        ]
      },
      {
        number: 470,
        title: 'Checkout summary hides the shipping estimate on mobile',
        state: 'open'
      },
      { number: 468, title: 'Totals are off by one cent in EUR and JPY', state: 'open' },
      { number: 474, title: 'Search suggestions take 600 ms on a cold cache', state: 'open' },
      { number: 455, title: 'Cart E2E flakes on Safari 18', state: 'open' },
      { number: 458, title: 'Coupon SAVE10 is rejected when typed in lower case', state: 'open' },
      { number: 461, title: 'Apple Pay button missing on iPad', state: 'open' },
      {
        number: 463,
        title: 'Order confirmation email shows UTC times',
        state: 'completed',
        closedAt: 30
      },
      {
        number: 466,
        title: 'Support pay-later in the cart drawer',
        state: 'not_planned',
        closedAt: 27
      },
      { number: 469, title: 'Address autocomplete picks the wrong unit number', state: 'open' },
      {
        number: 472,
        title: 'Express checkout ignores the selected shipping method',
        state: 'open'
      },
      { number: 440, title: 'Remove the 2025 holiday promo flags', state: 'open' },
      {
        number: 443,
        title: 'Promo banner flag is still read on the product page',
        state: 'completed',
        closedAt: 98
      },
      {
        number: 447,
        title: 'Remind shoppers about carts they saved',
        state: 'completed',
        closedAt: 46
      }
    ],
    'acme/api': [
      {
        number: 217,
        title: 'Return rate limit headers on every response',
        state: 'merged',
        updated: 5,
        mergedAt: 5,
        head: 'rate-limit-headers',
        author: 'chloe-acme',
        closes: [209],
        body: [
          'Adds `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (RFC 9331 draft).'
        ]
      },
      {
        number: 221,
        title: 'Paginate GET /v2/orders',
        state: 'open',
        updated: 23,
        head: 'orders-pagination',
        author: 'ben-acme',
        review: 'REVIEW_REQUIRED',
        threads: [true],
        checks: [
          ['CI', 'Contract tests', 'FAILURE'],
          ['CI', 'Unit tests', 'SUCCESS']
        ],
        passedExtra: 17,
        body: [
          'Cursor pagination for `GET /v2/orders`:',
          '',
          '```http',
          'GET /v2/orders?limit=50&cursor=eyJpZCI6IjEyMyJ9',
          '```',
          '',
          'The old `page` parameter keeps working until v3.'
        ]
      },
      {
        number: 209,
        title: 'Clients cannot see their remaining quota',
        state: 'completed',
        closedAt: 5
      },
      { number: 205, title: 'Orders endpoint times out for large merchants', state: 'open' }
    ],
    'acme/docs': [
      {
        number: 88,
        title: 'Document the webhook retry policy',
        state: 'open',
        updated: 7.5,
        head: 'webhook-retries',
        author: 'ana-acme',
        review: 'REVIEW_REQUIRED',
        checks: [
          ['CI', 'Build site', 'SUCCESS'],
          ['CI', 'Check links', 'SUCCESS']
        ],
        passedExtra: 2,
        body: ['Explains the backoff schedule (1 min, 5 min, 30 min, 2 h, 12 h) and how to replay.']
      },
      { number: 81, title: 'Broken links in the API reference sidebar', state: 'open' }
    ]
  };
}

/** The GitHub data set `gh-protocol.mjs` answers from, with times relative to `now`. */
export function githubData(now) {
  const iso = (hoursAgo) =>
    hoursAgo === undefined ? null : new Date(now - hoursAgo * HOUR).toISOString();
  const refs = {};
  const details = {};
  const branches = {};
  for (const [repo, items] of Object.entries(githubItems())) {
    for (const item of items) {
      const key = `${repo}#${item.number}`;
      const url = `https://github.com/${repo}/${item.head === undefined ? 'issues' : 'pull'}/${item.number}`;
      if (item.head === undefined) {
        refs[key] = {
          __typename: 'Issue',
          state: item.state === 'open' ? 'OPEN' : 'CLOSED',
          stateReason:
            item.state === 'completed'
              ? 'COMPLETED'
              : item.state === 'not_planned'
                ? 'NOT_PLANNED'
                : null,
          title: item.title,
          url,
          closedAt: iso(item.closedAt),
          closedByPullRequestsReferences: { nodes: [] }
        };
        continue;
      }
      const checks = (item.checks ?? []).map(([workflow, name, conclusion]) =>
        checkRun(repo, workflow, name, conclusion)
      );
      refs[key] = {
        __typename: 'PullRequest',
        state: { open: 'OPEN', draft: 'OPEN', merged: 'MERGED', closed: 'CLOSED' }[item.state],
        isDraft: item.state === 'draft',
        title: item.title,
        url,
        mergedAt: iso(item.mergedAt),
        closedAt: iso(item.mergedAt ?? item.closedAt),
        updatedAt: iso(item.updated),
        reviewDecision: item.review ?? null,
        headRefOid: null,
        mergeable: item.conflicts ? 'CONFLICTING' : 'MERGEABLE',
        closingIssuesReferences: {
          nodes: (item.closes ?? []).map((number) => ({
            number,
            repository: { nameWithOwner: repo }
          }))
        },
        latestReviews: {
          nodes: item.review && item.review !== 'REVIEW_REQUIRED' ? [{ state: item.review }] : []
        },
        reviewThreads: {
          totalCount: item.threads?.length ?? 0,
          nodes: (item.threads ?? []).map((isResolved) => ({ isResolved }))
        },
        commits: {
          nodes: checks.length ? [{ commit: { statusCheckRollup: rollup(item) } }] : []
        }
      };
      details[key] = {
        author: { login: item.author },
        headRefName: item.head,
        baseRefName: 'main',
        body: item.body.join('\n'),
        checks
      };
      const branch = `${repo}@${item.head}`;
      branches[branch] = [...(branches[branch] ?? []), item.number];
    }
  }
  return { refs, details, branches };
}

/**
 * The head commit's rollup: the listed checks plus `passedExtra` successful runs. Like GitHub,
 * the state is FAILURE when checks were only cancelled.
 */
function rollup(item) {
  const runs = { SUCCESS: item.passedExtra ?? 0 };
  for (const [, , conclusion] of item.checks) {
    const state = conclusion ?? 'IN_PROGRESS';
    runs[state] = (runs[state] ?? 0) + 1;
  }
  const failed = ['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'CANCELLED'].some(
    (state) => runs[state]
  );
  const state = runs.IN_PROGRESS ? 'PENDING' : failed ? 'FAILURE' : 'SUCCESS';
  return { state, contexts: counts(runs, item.statuses ?? {}) };
}

/** The GitLab data set `demo/forge/glab.mjs` answers from, with times relative to `now`. */
export function gitlabData(now) {
  const iso = (hoursAgo) => new Date(now - hoursAgo * HOUR).toISOString();
  return {
    mergeRequests: {
      'acme/mobile!58': {
        state: 'opened',
        draft: false,
        title: 'Add offline mode to order history',
        webUrl: 'https://gitlab.com/acme/mobile/-/merge_requests/58',
        mergedAt: null,
        closedAt: null,
        updatedAt: iso(3.5),
        diffHeadSha: null,
        workItemRelations: {
          nodes: [{ workItem: { iid: '31', namespace: { fullPath: 'acme/mobile' } } }]
        },
        approved: true,
        approvedBy: { nodes: [{ id: 'gid://gitlab/User/1' }] },
        detailedMergeStatus: 'CI_STILL_RUNNING',
        conflicts: false,
        resolvableDiscussionsCount: 3,
        resolvedDiscussionsCount: 2,
        headPipeline: { status: 'FAILED', total: { count: 14 }, passed: { count: 12 } }
      }
    },
    issues: {
      'acme/mobile#31': {
        state: 'opened',
        title: 'Order history is blank without a connection',
        webUrl: 'https://gitlab.com/acme/mobile/-/issues/31',
        closedAt: null
      }
    },
    details: {
      'acme/mobile!58': {
        author: { username: 'ben-acme' },
        sourceBranch: 'offline-orders',
        targetBranch: 'main',
        description:
          'Caches the last 50 orders with **SQLite** so the screen works offline.\n\nCloses #31.',
        jobs: [
          ['test', 'test:android', 'FAILED'],
          ['test', 'test:ios', 'FAILED'],
          ['lint', 'lint', 'SUCCESS'],
          ['build', 'build:android', 'SUCCESS'],
          ['build', 'build:ios', 'SUCCESS'],
          ['deploy', 'deploy:testflight', 'MANUAL']
        ].map(([stage, name, status], index) => ({
          name,
          status,
          webPath: `/acme/mobile/-/jobs/${9100 + index}`,
          stage: { name: stage }
        }))
      }
    },
    branches: { 'acme/mobile@offline-orders': [58] }
  };
}
