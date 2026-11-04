// The demo's sessions in the shape `opencode session import` reads: `{ info, messages }`, with
// links in `info.metadata['super-sessions']`. Times count back from the seed time, so the
// browser's day groups and ages read the same after every reseed. The refs match
// demo/forge/data.mjs.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The model every session ran on: the scripted one start.mjs serves. */
export const MODEL = { providerID: 'demo', id: 'assistant' };

/** The session start.mjs prompts on launch, so the browser has a Running session. */
export const RUNNING = 'ses_demo_search_suggest';

/** A GitHub link `source` added to `repo`'s `kind` number `number`. */
function gh(repo, kind, number, source, via) {
  return {
    ref: { provider: 'github', host: 'github.com', repo, kind, number },
    source,
    ...(via ? { via } : {})
  };
}

/** A GitLab link, like {@link gh}. */
function gl(repo, kind, number, source, via) {
  return {
    ref: { provider: 'gitlab', host: 'gitlab.com', repo, kind, number },
    source,
    ...(via ? { via } : {})
  };
}

/**
 * The plugin's key of a pull request, for the `via` of a `closes` link. The demo stores these
 * links up front because the plugin would otherwise write them on its first refresh, and every
 * metadata write moves a session's update time to now.
 */
const prKey = (provider, host, repo, number) => `${provider}:${host}/${repo}/pr/${number}`;

// Transcript parts. Each returns a function of the part's start time, so a turn can lay them
// out one after another.

/** A reasoning part. */
const think = (text) => (at) => ({
  type: 'reasoning',
  text,
  time: { created: at, completed: at + 4000 }
});

/** Assistant text, in markdown. */
const say = (text) => () => ({ type: 'text', text });

/** A finished tool call with text output. */
const tool = (name, input, output, metadata) => (at, index) => ({
  type: 'tool',
  id: `call_${index}`,
  name,
  state: {
    status: 'completed',
    input,
    content: [{ type: 'text', text: output }],
    ...(metadata ? { metadata } : {})
  },
  time: { created: at, ran: at + 200, completed: at + 1800 }
});

/** A read of `path` whose output is `lines`, numbered like the host's read tool. */
const read = (path, lines) =>
  tool('read', { path }, lines.map((line, index) => `${index + 1}: ${line}`).join('\n'));

/** A content search with `matches` hits. */
const grep = (pattern, path, matches, output) =>
  tool('grep', { pattern, path }, output, { matches });

/** A shell command and its output. */
const shell = (command, description, output) =>
  tool('shell', { command, description }, output, { exit: 0 });

/** An edit of `path`, given as the hunks of a unified diff. */
const edit = (path, hunks) => {
  const lines = hunks.split('\n');
  const additions = lines.filter((line) => line.startsWith('+')).length;
  const deletions = lines.filter((line) => line.startsWith('-')).length;
  const patch = `--- a/${path}\n+++ b/${path}\n${hunks}\n`;
  return tool('edit', { path }, `Edited ${path}`, {
    files: [{ type: 'update', file: path, patch, additions, deletions }]
  });
};

/**
 * Every demo session. `place` names a directory start.mjs creates: a repository, or a
 * repository and one of its worktrees. `hours` is how long ago the last turn ended.
 */
function definitions() {
  const storefront = (number) => prKey('github', 'github.com', 'acme/storefront', number);
  return [
    {
      id: RUNNING,
      title: 'Speed up search suggestions',
      place: 'storefront',
      hours: 0.8,
      links: [gh('acme/storefront', 'issue', 474, 'prompt')],
      turns: [
        {
          user: 'Search suggestions take 600 ms on a cold cache (#474). Find out where the time goes.',
          parts: [
            think('Start with the suggest handler and see what it does per keystroke.'),
            read('src/search/suggest.ts', [
              "import { catalog } from '../catalog/client';",
              '',
              'export async function suggest(query: string) {',
              '  const products = await catalog.search({ query, limit: 50 });',
              '  return products.map((product) => product.title).slice(0, 8);',
              '}'
            ]),
            shell(
              'pnpm bench search:suggest --cold',
              'Benchmark cold suggestions',
              'suggest("sho")   612 ms\nsuggest("shoe")  598 ms\nsuggest("shoes") 604 ms\n\ncatalog.search   571 ms (93%)'
            ),
            say(
              'Almost all of it is `catalog.search`: **571 of 612 ms**. Each keystroke asks the catalog for 50 full products and keeps 8 titles.\n\nTwo cheap fixes:\n\n1. Ask for `fields: ["title"]` and `limit: 8`.\n2. Cache prefixes for 60 seconds, since `sho`, `shoe` and `shoes` share most hits.'
            )
          ]
        }
      ]
    },
    {
      id: 'ses_demo_checkout_summary',
      title: 'Redesign the checkout summary step',
      place: 'storefront/checkout-redesign',
      hours: 0.4,
      links: [
        gh('acme/storefront', 'issue', 470, 'closes', storefront(482)),
        gh('acme/storefront', 'issue', 455, 'mention')
      ],
      turns: [
        {
          user: 'Rebuild the checkout summary step on the new `OrderSummary` component. The shipping estimate must stay visible on phones.',
          minutes: 9,
          parts: [
            think(
              'The old summary renders three selectors and hides the estimate behind a fold on narrow screens. Read it first.'
            ),
            read('src/checkout/SummaryStep.tsx', [
              "import { useCart, useShipping, useTotals } from '../cart';",
              '',
              'export function SummaryStep() {',
              '  const cart = useCart();',
              '  const shipping = useShipping();',
              '  const totals = useTotals();',
              '  return (',
              '    <section className="summary">',
              '      <LineItems items={cart.items} />',
              '      <details className="estimate">',
              '        <summary>Shipping</summary>',
              '        {shipping.estimate}',
              '      </details>',
              '      <Totals {...totals} />',
              '    </section>',
              '  );',
              '}'
            ]),
            grep(
              'useTotals',
              'src',
              7,
              'src/cart/index.ts:4\nsrc/checkout/SummaryStep.tsx:6\nsrc/cart/CartDrawer.tsx:12'
            ),
            edit(
              'src/checkout/SummaryStep.tsx',
              [
                '@@ -1,17 +1,14 @@',
                "-import { useCart, useShipping, useTotals } from '../cart';",
                "+import { OrderSummary } from '../components/OrderSummary';",
                "+import { useCartTotals } from '../cart';",
                ' ',
                ' export function SummaryStep() {',
                '-  const cart = useCart();',
                '-  const shipping = useShipping();',
                '-  const totals = useTotals();',
                '+  const { items, shipping, totals } = useCartTotals();',
                '   return (',
                '-    <section className="summary">',
                '-      <LineItems items={cart.items} />',
                '-      <details className="estimate">',
                '-        <summary>Shipping</summary>',
                '-        {shipping.estimate}',
                '-      </details>',
                '-      <Totals {...totals} />',
                '-    </section>',
                '+    <OrderSummary items={items} collapseAfter={5} estimate={shipping.estimate} pinEstimate>',
                '+      <OrderSummary.Totals {...totals} />',
                '+    </OrderSummary>',
                '   );',
                ' }'
              ].join('\n')
            ),
            shell(
              'pnpm test --filter checkout',
              'Run the checkout tests',
              ' ✓ SummaryStep renders the estimate above Place order (14 ms)\n ✓ SummaryStep collapses after five items (9 ms)\n ✓ OrderSummary.Totals matches the cart totals (6 ms)\n\nTest Files  3 passed (3)\n     Tests  11 passed (11)'
            ),
            say(
              'The summary step now uses `OrderSummary`:\n\n- `pinEstimate` keeps the shipping estimate above **Place order** on every width.\n- Items collapse after five, with a *Show all* toggle.\n- Totals come from `useCartTotals()`, so the three selectors are gone.\n\nThe flaky Safari run looks like https://github.com/acme/storefront/issues/455 again, not this change.'
            )
          ]
        },
        {
          user: 'CI is red on #482 and there are review comments. Fix lint and typecheck first.',
          minutes: 5,
          parts: [
            think('Pull the failing logs before touching anything.'),
            shell(
              'gh pr checks 482',
              'List the PR checks',
              'Lint                      fail   1m02s\nTypecheck                 fail   1m40s\nUnit tests (node 22)      fail   2m13s\nCheckout flow (chromium)  fail   6m51s\nCheckout flow (webkit)    fail   10m0s\nVisual regression         fail   4m12s\nUnit tests (node 24)      pass   2m09s'
            ),
            shell(
              'pnpm typecheck',
              'Typecheck the workspace',
              "src/components/OrderSummary/Totals.tsx:18:7 - error TS2322: Type 'Money | undefined' is not assignable to type 'Money'.\n\nFound 1 error in src/components/OrderSummary/Totals.tsx:18"
            ),
            say(
              'One real type error: `discount` is optional in `CartTotals` but `Totals` requires it. Lint fails on the unused `LineItems` import that the merge brought back.\n\nThe branch also **conflicts with main** since the tax line landed there, so I will rebase before pushing:\n\n```sh\ngit fetch origin\ngit rebase origin/main\n```'
            )
          ]
        }
      ]
    },
    {
      id: 'ses_demo_gift_cards',
      title: 'Show gift card balance in the cart',
      place: 'storefront/gift-cards',
      hours: 2,
      unread: true,
      links: [],
      turns: [
        {
          user: 'Read the gift card balance from the API and show it in the cart drawer. Open a draft PR when the first part works.',
          parts: [
            read('src/cart/CartDrawer.tsx', [
              "import { useCart } from './useCart';",
              '',
              'export function CartDrawer() {',
              '  const cart = useCart();',
              '  return <Drawer title="Your cart">{cart.items.map(renderItem)}</Drawer>;',
              '}'
            ]),
            shell(
              'gh pr create --draft --fill',
              'Open a draft pull request',
              'Creating draft pull request for gift-cards into main in acme/storefront\n\nhttps://github.com/acme/storefront/pull/491'
            ),
            say(
              'The balance lookup works and draft #491 is open. CI is still running; the drawer UI is next.'
            )
          ]
        }
      ]
    },
    {
      id: 'ses_demo_currency_rounding',
      title: 'Fix rounding in multi-currency totals',
      place: 'storefront',
      hours: 5,
      pinned: true,
      links: [
        gh('acme/storefront', 'issue', 468, 'prompt'),
        gh('acme/storefront', 'pr', 476, 'agent')
      ],
      turns: [
        {
          user: 'Totals are a cent off in EUR and JPY carts, see #468. Find the cause and fix it.',
          minutes: 6,
          parts: [
            think('Floating point sums rounded once at the end would explain a one cent drift.'),
            read('src/cart/totals.ts', [
              'export function cartTotal(items: CartItem[]) {',
              '  const sum = items.reduce((total, item) => total + item.price * item.quantity, 0);',
              '  return Math.round(sum * 100) / 100;',
              '}'
            ]),
            edit(
              'src/cart/totals.ts',
              [
                '@@ -1,4 +1,6 @@',
                '-export function cartTotal(items: CartItem[]) {',
                '-  const sum = items.reduce((total, item) => total + item.price * item.quantity, 0);',
                '-  return Math.round(sum * 100) / 100;',
                '+export function cartTotal(items: CartItem[], currency: Currency) {',
                '+  const minor = items.reduce(',
                '+    (total, item) => total + toMinor(item.price, currency) * item.quantity,',
                '+    0',
                '+  );',
                '+  return fromMinor(minor, currency);',
                ' }'
              ].join('\n')
            ),
            shell(
              'pnpm test src/cart',
              'Run the cart tests',
              ' ✓ cartTotal sums EUR in cents (3 ms)\n ✓ cartTotal keeps JPY whole (2 ms)\n ✓ cartTotal matches the tax service for 10,000 random carts (412 ms)\n\nTests  18 passed (18)'
            ),
            say(
              'The total was summed in floating point and rounded once, so `0.1 + 0.2` style errors leaked into EUR carts and JPY was rounded to cents it does not have.\n\nAmounts are now **integer minor units** end to end:\n\n| Currency | Minor units | Before | After |\n| -------- | ----------- | ------ | ----- |\n| EUR      | 2           | 30.01  | 30.00 |\n| JPY      | 0           | 1999.99 | 2000 |\n\nI opened #476 and linked it here.'
            )
          ]
        }
      ]
    },
    {
      id: 'ses_demo_safari_flake',
      title: 'Investigate flaky cart E2E on Safari',
      place: 'storefront',
      hours: 7,
      unread: true,
      links: [gh('acme/storefront', 'issue', 455, 'prompt')],
      turns: [
        {
          user: 'The cart E2E test flakes on Safari 18 about one run in five (#455). Why?',
          parts: [
            shell(
              'pnpm e2e cart --project webkit --repeat-each 20',
              'Repeat the cart test on WebKit',
              '20 tests: 16 passed, 4 failed\n\n  Error: locator.click: Element is not stable\n    at cart.spec.ts:41 (await page.getByRole("button", { name: "Checkout" }).click())'
            ),
            say(
              'The **Checkout** button is still animating in when the test clicks it. WebKit reports it as unstable for about 120 ms after the drawer opens.\n\nWaiting for the drawer animation instead of a fixed timeout fixes it in 200 of 200 runs:\n\n```ts\nawait expect(page.getByTestId("cart-drawer")).toHaveAttribute("data-state", "open");\n```'
            )
          ]
        }
      ]
    },
    {
      id: 'ses_demo_triage',
      title: 'Triage checkout bugs from the support queue',
      place: 'storefront',
      hours: 26,
      links: [455, 461, 463, 466, 469, 472].map((number) =>
        gh('acme/storefront', 'issue', number, 'prompt')
      ),
      turns: [
        {
          user: 'Go through #455, #461, #463, #466, #469 and #472 from the support queue and tell me which ones are real checkout bugs.',
          minutes: 7,
          parts: [
            think('Read each issue and try to reproduce the ones with clear steps.'),
            shell(
              'gh issue view 463 --comments',
              'Read issue 463',
              'Order confirmation email shows UTC times\n\nFixed by the timezone change in the mailer; closed as completed.'
            ),
            say(
              '| Issue | Verdict |\n| ----- | ------- |\n| #455 | Real: flaky test, not a product bug |\n| #461 | Real: Apple Pay is hidden when `PaymentRequest` reports no cards on iPad |\n| #463 | Already fixed in the mailer |\n| #466 | Closed as not planned: no pay-later provider this quarter |\n| #469 | Real: autocomplete drops the unit number for some addresses |\n| #472 | Real: express checkout always uses the cheapest rate |\n\nI would take **#472** first: it changes what customers pay.'
            )
          ]
        }
      ]
    },
    {
      id: 'ses_demo_lazy_images',
      title: 'Lazy-load product images below the fold',
      place: 'storefront',
      hours: 30,
      links: [gh('acme/storefront', 'pr', 479, 'created')],
      turns: [
        {
          user: 'Category pages load every product image up front. Lazy-load the ones below the first row and open a PR.',
          parts: [
            grep(
              '<img',
              'src/catalog',
              4,
              'src/catalog/ProductCard.tsx:22\nsrc/catalog/CategoryGrid.tsx:31'
            ),
            shell(
              'gh pr create --fill',
              'Open the pull request',
              'Creating pull request for lazy-images into main in acme/storefront\n\nhttps://github.com/acme/storefront/pull/479'
            ),
            say(
              'Done in #479. The E2E jobs were cancelled by the runner restart, so they need a re-run.'
            )
          ]
        }
      ]
    },
    {
      id: 'ses_demo_ssr_spike',
      title: 'Spike: server-side rendering for category pages',
      place: 'storefront',
      hours: 50,
      links: [],
      turns: [
        {
          user: 'Spike server-side rendering for category pages. Is it worth it?',
          minutes: 8,
          parts: [
            think('Compare time to first byte and LCP with the client-rendered page.'),
            shell(
              'pnpm lighthouse /c/running-shoes --runs 5',
              'Measure the category page',
              'client render   TTFB 180 ms   LCP 2.9 s\nssr (kestrel)   TTFB 320 ms   LCP 1.4 s'
            ),
            say(
              'Yes for category pages. I prototyped it on the **kestrel** renderer we already use for the blog:\n\n- LCP drops from 2.9 s to 1.4 s.\n- TTFB goes up by 140 ms, which the CDN cache hides for the top 500 categories.\n\nThe kestrel adapter needs streaming support before it can render the filters sidebar.'
            )
          ]
        }
      ]
    },
    {
      id: 'ses_demo_coupons',
      title: 'Make coupon codes case-insensitive',
      place: 'storefront',
      hours: 72,
      links: [
        gh('acme/storefront', 'issue', 458, 'prompt'),
        gh('acme/storefront', 'pr', 484, 'created')
      ],
      turns: [
        {
          user: 'Customers type save10 and get "invalid coupon" (#458). Make codes case-insensitive.',
          parts: [
            read('src/checkout/coupons.ts', [
              'export async function applyCoupon(code: string) {',
              '  const coupon = await db.coupons.find({ code });',
              "  if (!coupon) throw new CheckoutError('invalid-coupon');",
              '}'
            ]),
            shell(
              'gh pr create --fill',
              'Open the pull request',
              'Creating pull request for coupon-case into main in acme/storefront\n\nhttps://github.com/acme/storefront/pull/484'
            ),
            say(
              'Codes are upper-cased before the lookup. #484 is approved but two review threads are still open.'
            )
          ]
        }
      ]
    },
    {
      id: 'ses_demo_promo_flags',
      title: 'Clean up legacy promo banner flags',
      place: 'storefront',
      hours: 98,
      pinned: true,
      links: [
        gh('acme/storefront', 'issue', 440, 'prompt'),
        gh('acme/storefront', 'issue', 443, 'prompt')
      ],
      turns: [
        {
          user: 'Remove the 2025 holiday promo flags (#440). #443 was the product page part.',
          parts: [
            grep(
              'promo2025',
              'src',
              9,
              'src/home/Banner.tsx:3\nsrc/flags.ts:18\nsrc/product/PromoStrip.tsx:7'
            ),
            say(
              'Nine reads of `promo2025` left in three files. The product page one is gone since #443.'
            )
          ]
        }
      ]
    },
    {
      id: 'ses_demo_container_queries',
      title: 'Try container queries for the product grid',
      place: 'storefront',
      hours: 120,
      links: [gh('acme/storefront', 'pr', 460, 'created')],
      turns: [
        {
          user: 'Move the product grid to CSS container queries and open a PR.',
          parts: [
            shell(
              'gh pr create --fill',
              'Open the pull request',
              'Creating pull request for grid-container-queries into main in acme/storefront\n\nhttps://github.com/acme/storefront/pull/460'
            ),
            say('Opened #460.')
          ]
        },
        {
          // After #460 was closed (demo/forge/data.mjs), so the closed PR keeps it out of Done.
          after: 20,
          user: '#460 got closed because of Safari 15. Can we get the same layout with media queries for now?',
          parts: [
            say(
              'Yes. The grid only needs two breakpoints, so `@media (min-width: 48rem)` and `(min-width: 72rem)` reproduce it. Container queries can come back once Safari 15 drops below 2%.'
            )
          ]
        }
      ]
    },
    {
      id: 'ses_demo_script_audit',
      title: 'Audit third-party scripts on the product page',
      place: 'storefront',
      hours: 145,
      links: [],
      turns: [
        {
          user: 'List every third-party script on the product page and what it costs.',
          parts: [
            shell(
              'pnpm lighthouse /p/trail-runner-2 --only third-party',
              'Measure third-party scripts',
              'reviews-widget.js     212 KB   380 ms main thread\nchat-launcher.js      148 KB   210 ms\nanalytics.js           41 KB    60 ms'
            ),
            say(
              'The reviews widget is the expensive one. Loading it on scroll would save about 380 ms of main thread work.'
            )
          ]
        }
      ]
    },
    {
      id: 'ses_demo_perf_report',
      title: 'Write the Q4 storefront performance report',
      place: 'storefront',
      hours: 22,
      done: 20,
      links: [],
      turns: [
        {
          user: 'Write the Q4 performance report from the dashboards. Keep it to one page.',
          parts: [
            say(
              '# Storefront performance, Q4\n\n| Page | LCP p75 | Change |\n| ---- | ------- | ------ |\n| Home | 1.8 s | -0.4 s |\n| Category | 2.1 s | -0.8 s |\n| Product | 2.4 s | -0.2 s |\n\nThe category win comes from lazy images and the new image CDN.'
            )
          ]
        }
      ]
    },
    {
      id: 'ses_demo_saved_carts',
      title: 'Send a reminder email for saved carts',
      place: 'storefront',
      hours: 47,
      links: [
        gh('acme/storefront', 'pr', 451, 'created'),
        gh('acme/storefront', 'issue', 447, 'closes', storefront(451))
      ],
      turns: [
        {
          user: 'Send shoppers one reminder email 24 hours after they save a cart (#447 has the copy).',
          parts: [
            shell(
              'gh pr create --fill',
              'Open the pull request',
              'Creating pull request for saved-cart-reminder into main in acme/storefront\n\nhttps://github.com/acme/storefront/pull/451'
            ),
            say('Opened #451. It sends at most one reminder per week per shopper.')
          ]
        }
      ]
    },
    {
      id: 'ses_demo_reorder',
      title: 'Prototype one-click reorder',
      place: 'storefront',
      hours: 240,
      archived: 190,
      links: [gh('acme/storefront', 'pr', 432, 'created')],
      turns: [
        {
          user: 'Prototype one-click reorder behind a flag.',
          parts: [say('The prototype is in #432 behind the `reorder` flag.')]
        }
      ]
    },
    {
      id: 'ses_demo_holiday_copy',
      title: 'Update the holiday banner copy',
      place: 'storefront',
      hours: 290,
      archived: 260,
      links: [],
      turns: [
        {
          user: 'Change the holiday banner to "Free returns until January 31".',
          parts: [say('Updated the banner copy in `src/home/Banner.tsx`.')]
        }
      ]
    },
    {
      id: 'ses_demo_rate_limits',
      title: 'Return rate limit headers on every response',
      place: 'api/rate-limit-headers',
      hours: 6,
      links: [
        gh('acme/api', 'issue', 209, 'closes', prKey('github', 'github.com', 'acme/api', 217))
      ],
      turns: [
        {
          user: 'Clients cannot see their remaining quota. Return rate limit headers on every response.',
          parts: [
            edit(
              'src/middleware/rateLimit.ts',
              [
                '@@ -20,4 +20,7 @@',
                '   const result = await limiter.consume(key);',
                "+  response.setHeader('RateLimit-Limit', result.limit);",
                "+  response.setHeader('RateLimit-Remaining', result.remaining);",
                "+  response.setHeader('RateLimit-Reset', result.resetSeconds);",
                '   return next();'
              ].join('\n')
            ),
            say(
              'Every response now carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`.'
            )
          ]
        }
      ]
    },
    {
      id: 'ses_demo_orders_pagination',
      title: 'Paginate the orders endpoint',
      place: 'api',
      hours: 24,
      links: [gh('acme/api', 'issue', 205, 'prompt'), gh('acme/api', 'pr', 221, 'agent')],
      turns: [
        {
          user: 'GET /v2/orders times out for large merchants (#205). Add cursor pagination.',
          parts: [
            say(
              'Cursor pagination is in #221. The contract tests fail because the old fixtures expect `page`.'
            )
          ]
        }
      ]
    },
    {
      id: 'ses_demo_inventory_load',
      title: 'Find out why /v2/inventory is slow under load',
      place: 'api',
      hours: 3,
      links: [],
      turns: [
        {
          user: 'p99 of /v2/inventory goes past 2 s at 300 rps. Why?',
          parts: [
            shell(
              'k6 run load/inventory.js --vus 300',
              'Load test the inventory endpoint',
              'http_req_duration p(99)=2.31s\npg pool waiting   p(99)=1.94s'
            ),
            say(
              'Requests wait on the database pool: it has 10 connections for 300 virtual users. Raising it to 40 brings p99 to 310 ms.'
            )
          ]
        }
      ]
    },
    {
      id: 'ses_demo_webhook_docs',
      title: 'Document the webhook retry policy',
      place: 'docs',
      hours: 8,
      unread: true,
      links: [gh('acme/docs', 'pr', 88, 'created')],
      turns: [
        {
          user: 'Document how webhook retries work and open a PR on the docs repo.',
          parts: [
            shell(
              'gh pr create --fill',
              'Open the pull request',
              'Creating pull request for webhook-retries into main in acme/docs\n\nhttps://github.com/acme/docs/pull/88'
            ),
            say('Opened #88 with the backoff table and a replay example.')
          ]
        }
      ]
    },
    {
      id: 'ses_demo_broken_links',
      title: 'Fix broken links in the API reference',
      place: 'docs',
      hours: 52,
      links: [gh('acme/docs', 'issue', 81, 'prompt')],
      turns: [
        {
          user: 'The API reference sidebar has broken links (#81). Find them.',
          parts: [
            shell(
              'pnpm check-links',
              'Check every link',
              '4 broken links:\n  /reference/orders#list -> 404\n  /reference/carts -> 404'
            ),
            say(
              'Four links point at pages renamed in the v2 reference. A redirect map fixes all of them.'
            )
          ]
        }
      ]
    },
    {
      id: 'ses_demo_offline_orders',
      title: 'Add offline mode to order history',
      place: 'mobile',
      hours: 4,
      links: [gl('acme/mobile', 'issue', 31, 'prompt'), gl('acme/mobile', 'pr', 58, 'created')],
      turns: [
        {
          user: 'Order history is blank without a connection (#31). Cache the last orders and open an MR.',
          parts: [
            shell(
              'glab mr create --fill --yes',
              'Open the merge request',
              'Creating merge request for offline-orders into main in acme/mobile\n\nhttps://gitlab.com/acme/mobile/-/merge_requests/58'
            ),
            say(
              'Opened !58. The iOS and Android test jobs fail on the new SQLite migration; looking at that next.'
            )
          ]
        }
      ]
    }
  ];
}

/**
 * The sessions to import, with times counted back from `now`, and the ids to pin in pin order.
 * `directory(place)` resolves a `place` to the directory start.mjs created for it.
 */
export function demoSessions(now, directory) {
  const sessions = definitions().map((definition) => build(definition, now, directory));
  const pins = definitions()
    .filter((definition) => definition.pinned)
    .map((definition) => definition.id);
  return { sessions, pins };
}

/** Lays out one session's turns so the last one ends `hours` before `now`. */
function build(definition, now, directory) {
  const idle = now - definition.hours * HOUR;
  const durations = definition.turns.map((turn) => (turn.minutes ?? 3) * MINUTE);
  // `after` is the pause before a turn in hours, for a turn that follows up days later.
  const gaps = definition.turns.map((turn, index) =>
    index === 0 ? 0 : (turn.after ?? 0.1) * HOUR
  );
  const total = [...durations, ...gaps].reduce((sum, value) => sum + value, 0);
  let at = idle - total;
  const created = at - MINUTE;
  const messages = [];
  let usage = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  for (const [index, turn] of definition.turns.entries()) {
    const start = at;
    const end = start + (durations[index] ?? 0);
    const id = (suffix) => `msg_${definition.id.slice(4)}_${index}${suffix}`;
    messages.push({ id: id('u'), type: 'user', text: turn.user, time: { created: start } });
    // Parts are spread evenly between the prompt and the end of the turn.
    const step = (end - start - 10_000) / Math.max(1, turn.parts.length);
    const content = turn.parts.map((part, position) =>
      part(start + 5000 + position * step, `${index}_${position}`)
    );
    usage = {
      input: 14_000 + index * 9000 + content.length * 2100,
      output: 900 + content.length * 340,
      reasoning: 0,
      cache: { read: 8000 + index * 12_000, write: 1200 }
    };
    messages.push({
      id: id('a'),
      type: 'assistant',
      agent: 'build',
      model: MODEL,
      content,
      finish: 'stop',
      cost: 0.04 + content.length * 0.03,
      tokens: usage,
      time: { created: start + 4000, completed: end }
    });
    messages.push({ id: id('i'), type: 'idle', outcome: 'succeeded', time: { created: end } });
    at = end + (gaps[index + 1] ?? 0);
  }
  const last = messages.at(-1);
  const metadata = {
    'super-sessions': {
      v: 1,
      links: definition.links.map((link, index) => ({
        ...link,
        linkedAt: created + 10_000 + index
      })),
      dismissed: [],
      // The browser reads a session's history once unless this marker is there, and that read
      // writes metadata. These sessions carry their links already.
      scanned: { scannedAt: idle, lastMessageID: last.id },
      ...(definition.done === undefined ? {} : { done: true, doneAt: now - definition.done * HOUR })
    }
  };
  return {
    info: {
      id: definition.id,
      projectID: 'demo',
      agent: 'build',
      model: MODEL,
      cost: messages.reduce((sum, message) => sum + (message.cost ?? 0), 0),
      tokens: usage,
      outcome: 'succeeded',
      time: {
        created,
        updated: idle,
        idle,
        // Without `viewed` the host counts the finished run as unread.
        ...(definition.unread ? {} : { viewed: idle }),
        ...(definition.archived === undefined ? {} : { archived: now - definition.archived * HOUR })
      },
      title: definition.title,
      location: { directory: directory(definition.place) },
      metadata
    },
    messages
  };
}
