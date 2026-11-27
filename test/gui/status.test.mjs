import { afterEach, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createSignal } from 'solid-js';
import {
  createClient,
  createData,
  createServer,
  rpcUnavailable,
  startGui,
  until
} from './harness.mjs';

// The session's pull request status around its timeline, from the built bundle: the header slot,
// the side tab's Work section and its actions, and the composer pill.

const { sessionRefViewSchema } = await import('../../dist/rpc.js');

const github = { provider: 'github', host: 'github.com', repo: 'acme/widgets' };
const pr = (number) => ({ ...github, kind: 'pr', number });
const issue = (number) => ({ ...github, kind: 'issue', number });
const key = (ref) => `${ref.provider}:${ref.host}/${ref.repo}/${ref.kind}/${ref.number}`;
const pageOf = (ref) =>
  `https://github.com/acme/widgets/${ref.kind === 'pr' ? 'pull' : 'issues'}/${ref.number}`;

// Two layers of one stack, open; a merged and a closed pull request; a linked issue; a mention.
const top = pr(101);
const bottom = pr(100);
const merged = pr(90);
const closed = pr(80);
const bug = issue(55);
const mentioned = issue(999);
const failing = {
  decision: 'changes_requested',
  checks: 'failing',
  checksPassed: 1,
  checksSkipped: 0,
  checksFailed: 2,
  checksTotal: 3
};

/** A view the server could send, parsed so the fixture stays valid. */
function viewOf({ links, states, urls }) {
  return sessionRefViewSchema.parse({ links, branchRefs: [], states, ...(urls ? { urls } : {}) });
}

const state = (ref, fields) => ({ title: `Title ${ref.number}`, url: pageOf(ref), ...fields });

const full = viewOf({
  links: [
    { ref: top, source: 'agent', linkedAt: 6 },
    { ref: bottom, source: 'agent', linkedAt: 5 },
    { ref: merged, source: 'manual', linkedAt: 4 },
    { ref: closed, source: 'manual', linkedAt: 3 },
    { ref: bug, source: 'manual', linkedAt: 2 },
    { ref: mentioned, source: 'mention', linkedAt: 1 }
  ],
  states: {
    [key(top)]: state(top, {
      status: 'open',
      stack: { number: 7, position: 2, size: 3 },
      review: failing
    }),
    [key(bottom)]: state(bottom, {
      status: 'open',
      stack: { number: 7, position: 1, size: 3 },
      review: { decision: 'approved', checks: 'passing' }
    }),
    [key(merged)]: state(merged, { status: 'merged' }),
    [key(closed)]: state(closed, { status: 'closed' }),
    [key(bug)]: state(bug, { status: 'open' })
  },
  urls: [{ url: 'https://linear.app/acme/issue/COR-1466/fix-login', source: 'manual', linkedAt: 7 }]
});

const checks = [
  { name: 'build', status: 'success', url: 'https://ci.example/build' },
  { name: 'lint', status: 'failure', url: 'https://ci.example/lint' },
  { name: 'e2e', status: 'pending', url: 'https://ci.example/e2e' },
  { name: 'deploy', status: 'action_required', url: 'https://ci.example/deploy' }
];

/**
 * Starts the GUI on a session whose server answers `refs` and `refresh` with `view()` and
 * `pull.details` with `checks`; `handlers` adds or replaces RPC answers, and `options` goes to
 * `startGui`.
 */
async function start(view, handlers = {}, options = {}) {
  const answer = ({ sessionIDs }) => ({ [sessionIDs[0]]: view() });
  const client = createClient({
    'rpc.refs': answer,
    'rpc.refresh': answer,
    'rpc.pull.details': () => ({ body: '', checks }),
    ...handlers
  });
  const server = createServer({ client });
  const session = { server, id: 'ses_1', key: `${server.id}\nses_1`, directory: '/work/widgets' };
  gui = await startGui({ session, servers: [server], ...options });
  return { client, session };
}

/** The ref numbers a container draws, in order. */
const numbers = (container) =>
  [...container.querySelectorAll('.ss-ref-mark')].map((mark) => mark.textContent);

let gui;
afterEach(() => gui?.dispose());

test('the header folds to its first pull request and +N when it needs the room', async () => {
  const { session } = await start(() => full);
  const [compact, setCompact] = createSignal(false);
  const [header] = gui.slot('session.header', {
    session,
    screen: {},
    active: true,
    get compact() {
      return compact();
    }
  });

  await until(() => numbers(header.container).length > 1, 'the header refs');
  assert.ok(header.container.querySelector('.ss-ref-stack'));

  setCompact(true);
  assert.deepEqual(numbers(header.container), ['#100']);
  assert.equal(header.container.querySelector('.ss-ref-stack'), null);
  assert.equal(header.container.querySelector('.ss-badge'), null);
  assert.equal(header.container.querySelector('.ss-header-more').textContent, '+5');
});

test('a header pull request opens where the app link setting says, for its session', async () => {
  // Whether the app's Browser plugin takes the link: its "Open links in OpenCode" setting.
  let inApp = false;
  const { session } = await start(() => full, {}, { links: () => inApp });
  const [header] = gui.slot('session.header', {
    session,
    screen: {},
    active: true,
    compact: false
  });
  const link = await until(
    () => header.container.querySelector(`[data-ref="${key(top)}"]`)?.closest('a'),
    'the pull request'
  );

  link.click();
  assert.deepEqual(
    gui.linked.map((item) => [item.href, item.session]),
    [[pageOf(top), session]]
  );
  assert.deepEqual(gui.opened, [pageOf(top)]);

  inApp = true;
  link.click();
  assert.equal(gui.linked.length, 2);
  assert.deepEqual(gui.opened, [pageOf(top)]);

  // Shift and click is the app's way to the default browser, whatever the setting.
  link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
  assert.equal(gui.linked.length, 2);
  assert.deepEqual(gui.opened, [pageOf(top), pageOf(top)]);
});

test('+N in the header shows the side tab with its Work unfolded, and hides it again', async () => {
  const side = 'opencode-super-sessions:sessions';
  // The Work section is folded, as it starts.
  const { session } = await start(() => full);
  const [header] = gui.slot('session.header', {
    session,
    screen: {},
    active: true,
    compact: true
  });
  const panel = gui.panel('sessions', session);
  const more = await until(() => header.container.querySelector('.ss-header-more'), '+N');
  await until(() => panel.container.querySelector('.ss-side-fold'), 'the Work header');
  assert.equal(panel.container.querySelector(`.ss-side-work [data-ref="${key(merged)}"]`), null);

  more.click();
  // A pinned tab is opened in place, not stored again: no `select` placement.
  assert.deepEqual(gui.layout, [{ key: side, session: 'ses_1' }]);
  assert.equal(gui.ctx.layout.state(side, session), 'visible');
  assert.equal(more.getAttribute('aria-pressed'), 'true');
  // The Work section unfolded with the session's pull requests.
  await until(
    () => panel.container.querySelector(`.ss-side-work [data-ref="${key(merged)}"]`),
    'the unfolded Work list'
  );

  more.click();
  assert.deepEqual(gui.hides, [{ key: side, session: 'ses_1' }]);
  // The tab stays selected in the hidden region, as in the app.
  assert.equal(gui.ctx.layout.state(side, session), 'active');
  assert.equal(more.getAttribute('aria-pressed'), 'false');
  // A third click shows it again, from its hidden region.
  more.click();
  assert.equal(gui.ctx.layout.state(side, session), 'visible');
  assert.equal(more.getAttribute('aria-pressed'), 'true');
});

test('surfaces of one session share one fetch, which stops once none shows it', async () => {
  const answer = ({ sessionIDs }) => ({ [sessionIDs[0]]: full });
  const data = createData();
  const client = createClient({
    'rpc.refs': answer,
    'rpc.refresh': answer,
    'rpc.pull.details': () => ({ body: '', checks })
  });
  const server = createServer({ client, data });
  // No routed session, so the composer pill reads nothing and only the two surfaces below do.
  gui = await startGui({ servers: [server] });
  const session = { server, id: 'ses_1', key: `${server.id}\nses_1`, directory: '/work/widgets' };
  const intervals = new Set();
  const { setInterval: set, clearInterval: clear } = globalThis;
  globalThis.setInterval = (...args) => {
    const id = set(...args);
    intervals.add(id);
    return id;
  };
  globalThis.clearInterval = (id) => {
    intervals.delete(id);
    clear(id);
  };
  try {
    const [header] = gui.slot('session.header', {
      session,
      screen: {},
      active: true,
      compact: false
    });
    // The same session's header in another tab group, which mounts its own slot.
    const [panel] = gui.slot('session.header', {
      session,
      screen: {},
      active: true,
      compact: true
    });
    await until(() => numbers(header.container).length > 0, 'the header refs');
    await until(() => numbers(panel.container).length > 0, 'the other header refs');
    await until(() => client.calls.some((call) => call.name === 'rpc.refresh'), 'the refresh');

    assert.equal(client.calls.filter((call) => call.name === 'rpc.refs').length, 1);
    assert.equal(intervals.size, 1);
    assert.equal(data.listeners('session.metadata.updated'), 1);

    header.dispose();
    panel.dispose();
    await until(() => data.listeners('session.metadata.updated') === 0, 'the listeners to go');
    assert.equal(data.listeners('session.execution.succeeded'), 0);
    assert.equal(intervals.size, 0);
  } finally {
    globalThis.setInterval = set;
    globalThis.clearInterval = clear;
  }
});

/** The side tab with its Work section unfolded, as the user left it. */
const unfolded = { stores: { side: { workFolded: false } } };

test('the Work section lists the work and the checks that failed, each opening its page', async () => {
  const { session } = await start(() => full, {}, unfolded);
  const panel = gui.panel('sessions', session);

  const failed = await until(() => {
    const names = panel.container.querySelectorAll('.ss-work-checks .ss-check-name');
    return names.length > 0 && [...names];
  }, 'the failed checks');
  // Failures, then checks that wait for an action; passed and pending ones are not listed.
  assert.deepEqual(
    failed.map((name) => name.textContent),
    ['lint', 'deploy']
  );
  for (const ref of [top, bottom, merged, closed, bug, mentioned]) {
    assert.ok(panel.container.querySelector(`[data-ref="${key(ref)}"]`), key(ref));
  }
  assert.ok(panel.container.textContent.includes('COR-1466'));

  failed[0].closest('a').click();
  assert.deepEqual(gui.opened, ['https://ci.example/lint']);
});

test('unlinking asks first, then unlinks on the server and the item leaves the list', async () => {
  let view = full;
  const unlinked = [];
  const { session } = await start(
    () => view,
    {
      'rpc.unlink': (input) => {
        unlinked.push(input);
        view = viewOf({
          links: full.links.filter((link) => key(link.ref) !== input.key),
          states: full.states,
          urls: full.urls
        });
        return {};
      }
    },
    unfolded
  );
  const panel = gui.panel('sessions', session);
  const row = await until(
    () => panel.container.querySelector(`[data-ref="${key(merged)}"]`)?.closest('li'),
    'the merged pull request'
  );

  gui.replies.push(true);
  row.querySelector('button[aria-label="Unlink"]').click();

  await until(() => !panel.container.querySelector(`[data-ref="${key(merged)}"]`), 'the unlink');
  assert.equal(gui.asked[0].options.title, 'Unlink PR #90?');
  assert.deepEqual(unlinked, [{ sessionID: 'ses_1', key: key(merged) }]);
  assert.ok(panel.container.querySelector(`[data-ref="${key(bug)}"]`));
});

test('a link the server refuses becomes an error toast that says why', async () => {
  const refusals = [
    [{ type: 'invalid_reference', data: {} }, 'Not a URL or a pull request or issue reference.'],
    [{ type: 'not_found', data: {} }, 'Pull request or issue not found.'],
    [
      { type: 'unavailable', data: { reason: 'disabled', provider: 'gitlab' } },
      'GitLab is not enabled. Add it to the plugin\'s "providers" option, or turn it on with /super-sessions settings in the terminal.'
    ],
    [
      { type: 'unavailable', data: { reason: 'unauthenticated', provider: 'github' } },
      'GitHub is unavailable. Check that its CLI is installed and signed in.'
    ],
    [
      { type: 'rpc.unavailable' },
      'Could not link. The opencode-super-sessions server plugin is not installed on this server.'
    ],
    // Only a missing server plugin is blamed on the server plugin.
    [{}, 'Could not link.']
  ];
  let refusal;
  const { session } = await start(
    () => full,
    {
      'rpc.link': () => {
        throw Object.assign(new Error('refused'), refusal);
      }
    },
    unfolded
  );
  const panel = gui.panel('sessions', session);
  const button = await until(
    () => [...panel.container.querySelectorAll('button')].find((b) => b.textContent === 'Link'),
    'the Link button'
  );

  for (const [error, message] of refusals) {
    refusal = error;
    const before = gui.toasts.length;
    gui.replies.push(' #5 ');
    button.click();
    const toast = await until(() => gui.toasts[before], message);
    assert.deepEqual(toast, { title: message, variant: 'error' });
  }
});

// The tone rule itself is a unit table (test/unit/look.test.ts); this proves the pill wiring.
test('the composer pill shows the main pull request in its tone, failed checks first', async () => {
  const { session } = await start(() => full);
  // The stack's bottom layer is the session's main pull request: approved and passing.
  const pill = await until(() => {
    const shown = gui.pill('pull', session);
    return shown?.rows.length > 1 && shown;
  }, 'the check rows');
  assert.equal(pill.label, '#100');
  assert.equal(pill.tone, 'success');
  // An icon name the bundle does not declare draws nothing in the app.
  const declared = Object.entries(gui.ctx.icons).find(([, id]) => id === pill.icon)?.[0];
  assert.match(gui.plugin.icons[declared] ?? '', /^<svg [^>]*viewBox="0 0 16 16"/);
  assert.deepEqual(
    pill.rows.map((row) => row.label),
    ['Open pull request', 'lint', 'deploy', 'e2e', 'build']
  );
  pill.rows[1].run();
  assert.deepEqual(gui.opened, ['https://ci.example/lint']);
});

test('the composer pill hides when the session has no open pull request', async () => {
  const view = viewOf({
    links: [
      { ref: merged, source: 'agent', linkedAt: 2 },
      { ref: bug, source: 'manual', linkedAt: 1 }
    ],
    states: {
      [key(merged)]: state(merged, { status: 'merged' }),
      [key(bug)]: state(bug, { status: 'open' })
    }
  });
  const { session } = await start(() => view);
  const [header] = gui.slot('session.header', {
    session,
    screen: {},
    active: true,
    compact: false
  });

  await until(() => numbers(header.container).length > 0, 'the header refs');
  assert.equal(gui.pill('pull', session), undefined);
});

test('without the server plugin the panel says so and the header and pill show nothing', async () => {
  const { session } = await start(
    () => full,
    {
      'rpc.refs': () => {
        throw rpcUnavailable();
      },
      'rpc.refresh': () => {
        throw rpcUnavailable();
      }
    },
    unfolded
  );
  const [header] = gui.slot('session.header', {
    session,
    screen: {},
    active: true,
    compact: false
  });
  const panel = gui.panel('sessions', session);

  await until(
    () => panel.container.textContent.includes('server plugin is not installed'),
    'the unavailable note'
  );
  assert.equal(header.container.textContent, '');
  assert.equal(gui.pill('pull', session), undefined);
  // Nothing to link or refresh on a server that cannot answer.
  assert.equal(panel.container.querySelector('.ss-work-toolbar'), null);
  assert.equal(panel.container.querySelector('.ss-side-link'), null);
});
