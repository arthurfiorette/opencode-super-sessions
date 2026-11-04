import { afterEach, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrateV1, resolveThemeDocument } from '@opencode/theme/tui';
import { testRender } from '@opentui/solid';
import { jsx } from '@opentui/solid/jsx-runtime';
import { createSignal, onCleanup } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import themeSource from '../fixtures/theme-opencode.json';

// The host's defaults, whatever the developer's own cli.json says.
process.env.OPENCODE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'super-sessions-cli-'));

const { default: plugin } = await import('../../dist/tui.js');

const NOW = Date.now();
const MINUTE = 60_000;
const DAY = 86_400_000;
const theme = resolveThemeDocument(migrateV1(themeSource), 'dark');
const pr4930 = {
  provider: 'github',
  host: 'github.com',
  repo: 'mastra-ai/mastra',
  kind: 'pr',
  number: 4930
};
const key = (ref) =>
  `${ref.provider}:${ref.host}/${ref.repo}/${ref.kind}/${ref.number}`.toLowerCase();

const session = (id, title, time = {}) => ({
  id,
  title,
  projectID: 'proj',
  cost: 0,
  tokens: { input: 1000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: NOW - 10 * DAY, updated: NOW - MINUTE, ...time },
  location: { directory: '/repo' }
});

const fixtures = () => [
  session('pinned', 'Homelab Mastra triage design', { updated: NOW - 3 * DAY }),
  session('running', 'Mastra build: Rollup to Rspack', { updated: NOW - 2 * MINUTE }),
  session('unread', 'can you find all merged worktrees and remove them', {
    updated: NOW - 60 * MINUTE
  }),
  session('archived', 'Old spike on Rollup plugins', {
    archived: NOW - DAY,
    updated: NOW - 5 * DAY
  })
];

const issues = [1, 2, 3, 4, 5, 6].map((number) => ({ ...pr4930, kind: 'issue', number }));
const refViews = {
  unread: {
    links: issues.map((ref, index) => ({ ref, source: 'prompt', linkedAt: 10 - index })),
    branchRefs: [],
    states: Object.fromEntries(
      issues.map((ref) => [
        key(ref),
        {
          status: 'open',
          title: `Rspack issue ${ref.number}`,
          url: `https://github.com/mastra-ai/mastra/issues/${ref.number}`
        }
      ])
    )
  },
  running: {
    links: [{ ref: pr4930, source: 'agent', linkedAt: 1 }],
    branchRefs: [],
    states: {
      [key(pr4930)]: {
        status: 'open',
        title: 'Migrate build to Rspack',
        url: 'https://github.com/mastra-ai/mastra/pull/4930',
        review: {
          checks: 'failing',
          checksPassed: 3,
          checksTotal: 6,
          checksSkipped: 1,
          checksCancelled: 1,
          checksPending: 0,
          checksFailed: 2
        }
      }
    }
  }
};

const BINDINGS = {
  'session.rename': 'ctrl+r',
  'session.delete': 'ctrl+d',
  'session.pin.toggle': 'ctrl+f',
  'app.exit': 'ctrl+c'
};

/**
 * A host stand-in: the real plugin entry against fake client, data, keymap, storage and router.
 * The server plugin is missing, so its search RPC throws unless `search` stands in for it.
 */
async function host(
  version = '2.2.5',
  search = async () => {
    throw new Error('not registered');
  }
) {
  let renderer;
  const toasts = [];
  // Commands the plugin hands to the host keymap, as `[id, input]`.
  const dispatched = [];
  const sessions = fixtures();
  const layers = [];
  const slots = [];
  const modes = [];
  const [route, setRoute] = createSignal({ type: 'session', sessionID: 'unread' });
  const memories = new Map();
  // Sessions whose transcript pages were read, and the `history.scan` calls.
  const pages = [];
  const scans = [];
  const views = async ({ sessionIDs }) =>
    Object.fromEntries(sessionIDs.filter((id) => refViews[id]).map((id) => [id, refViews[id]]));
  const context = {
    app: { name: 'opencode', version, channel: 'latest' },
    options: {},
    location: { directory: '/repo' },
    theme,
    themeMode: 'dark',
    get renderer() {
      return renderer;
    },
    client: {
      location: {
        get: async () => ({
          directory: '/repo',
          project: { id: 'proj', directory: '/repo', canonical: '/repo' }
        })
      },
      session: {
        list: async (input) => ({
          data: sessions.filter(
            (item) =>
              (item.time.archived !== undefined) === input.archived &&
              (!input.search || item.title.toLowerCase().includes(input.search.toLowerCase()))
          ),
          cursor: {}
        }),
        get: async ({ sessionID }) => sessions.find((item) => item.id === sessionID),
        update: async () => {},
        remove: async () => {}
      },
      message: {
        list: async (input) => {
          if (input.type === undefined) pages.push(input.sessionID);
          return {
            data: [{ type: 'user', id: 'm1', text: 'ok', time: { created: NOW - DAY } }],
            cursor: {}
          };
        }
      },
      rpc: () => ({
        // Settings and maintenance listen for server events from setup on.
        events: { on: () => () => {} },
        refs: views,
        refresh: views,
        'pull.details': async () => ({
          body: 'Moves the build to Rspack.',
          checks: [
            { name: 'Lint', status: 'failure', url: 'https://ci.example/lint' },
            { name: 'Unit tests', status: 'success' },
            { name: 'Approve deploy', status: 'action_required' },
            { name: 'Old e2e run', status: 'cancelled' },
            { name: 'Docs', status: 'skipped' },
            { name: 'Typecheck', status: 'success' }
          ]
        }),
        'history.scan': async (input) => {
          scans.push(input);
          return { skipped: false };
        },
        search
      })
    },
    data: {
      on: () => () => {},
      session: {
        list: () => sessions,
        get: () => undefined,
        cost: () => 0,
        status: (id) => (id === 'running' ? 'running' : 'idle'),
        family: (id) => [id],
        root: (id) => id,
        permission: { list: () => [], sync: async () => {} },
        form: { list: () => [], sync: async () => {} }
      },
      project: { get: () => ({ id: 'proj', name: 'mastra', canonical: '/repo' }) },
      location: {
        default: () => ({ directory: '/repo' }),
        vcs: {
          info: () => ({ branch: { current: 'main', default: 'main' } }),
          sync: async () => {}
        },
        model: { list: () => [] },
        agent: { list: () => [] }
      }
    },
    keymap: {
      layer(factory) {
        const layer = factory();
        layers.push(layer);
        // Layers created by a component leave with it, like the host's.
        try {
          onCleanup(() => layers.splice(layers.indexOf(layer), 1));
        } catch {}
      },
      dispatch(id, input) {
        dispatched.push([id, input]);
      },
      shortcuts: (id) => (BINDINGS[id] ? [BINDINGS[id]] : []),
      mode: {
        push(mode) {
          const entry = { mode };
          modes.push(entry);
          return () => modes.splice(modes.indexOf(entry), 1);
        },
        current: () => modes.at(-1)?.mode ?? 'base'
      }
    },
    storage: {
      memory(name, options) {
        if (!memories.has(name)) {
          const [store, set] = createStore(structuredClone(options.initial));
          memories.set(name, [store, (mutation) => set(produce(mutation))]);
        }
        return memories.get(name);
      },
      store(name, options) {
        const initial =
          name === 'pins'
            ? { imported: true, ids: ['pinned', 'unread'] }
            : structuredClone(options.initial);
        const [store, set] = createStore(initial);
        return [store, async (mutation) => set(produce(mutation))];
      }
    },
    ui: {
      slot(claim) {
        slots.push(claim);
        return () => {};
      },
      router: { navigate: setRoute, current: route },
      toast: {
        show(toast) {
          toasts.push(toast);
        }
      },
      dialog: { clear() {}, select: () => new Promise(() => {}) },
      tabs: { enabled: () => false, close: () => true, list: () => [] },
      format: { path: (value) => value }
    }
  };
  await plugin.setup(context);
  const overlay = slots.find((claim) => claim.append === 'app');
  const banner = slots.find((claim) => claim.append === 'session.composer.top');
  assert.ok(overlay && banner, 'The browser claims the app slot and the composer slot.');
  return {
    context,
    overlay,
    banner,
    layers,
    toasts,
    dispatched,
    route,
    pages,
    scans,
    /** Runs a command registered by any layer, like `keymap.dispatch`. */
    dispatch(id) {
      const command = layers
        .flatMap((layer) => layer.commands ?? [])
        .find((item) => item.id === id);
      return command.run();
    },
    attach(value) {
      renderer = value;
    }
  };
}

/** Bounded polling for work behind the lazy view import and the RPC answers. */
async function eventually(rendered, predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await rendered.renderOnce();
    if (predicate(rendered.captureCharFrame())) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out. Last frame:\n${rendered.captureCharFrame()}`);
}

let active;
afterEach(() => {
  active?.renderer.destroy();
  active = undefined;
});

test('session.list opens the browser cold and lists active sessions with their refs', async () => {
  const terminal = await host();
  // The host's main column with the route, the composer slot and the app slot.
  const rendered = await testRender(
    () =>
      jsx('box', {
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        get children() {
          return [
            jsx('text', { flexGrow: 1, children: 'session transcript' }),
            terminal.banner.render({
              get sessionID() {
                return terminal.route().sessionID;
              }
            }),
            terminal.overlay.render({})
          ];
        }
      }),
    { width: 100, height: 30 }
  );
  active = rendered;
  terminal.attach(rendered.renderer);
  terminal.dispatch('session.list');
  // Open cold first, then wait for the lazy module; renderer idle does not mean it loaded.
  await import('../../dist/page/view.js');
  await eventually(rendered, (frame) => frame.includes('Mastra build') && frame.includes('#4930'));
  assert.doesNotMatch(rendered.captureCharFrame(), /Old spike on Rollup plugins/);
  // The Running header carries the spinner's color; the running title keeps the normal one.
  const spans = rendered.captureSpans().lines.flatMap((line) => line.spans);
  const fgOf = (text) => spans.find((span) => span.text.includes(text))?.fg;
  assert.ok(fgOf('Running')?.equals(theme.text.feedback.warning.base));
  assert.ok(fgOf('Mastra build')?.equals(theme.text.base));
  // The Pull requests view, last in the tab cycle, draws its rows from the same loaded refs.
  terminal.layers
    .flatMap((layer) => layer.commands ?? [])
    .find((command) => command.bind === 'shift+tab')
    .run();
  await eventually(rendered, (frame) => /#4930 .*Migrate build to Rspack\s+1 session/.test(frame));
});

test('the Pull requests preview sums the checks up and lists only the failed and blocked ones', async () => {
  const terminal = await host();
  const rendered = await testRender(() => terminal.overlay.render({}), { width: 140, height: 40 });
  active = rendered;
  terminal.attach(rendered.renderer);
  terminal.dispatch('session.list');
  await import('../../dist/page/view.js');
  await eventually(rendered, (frame) => frame.includes('#4930'));
  terminal.layers
    .flatMap((layer) => layer.commands ?? [])
    .find((command) => command.bind === 'shift+tab')
    .run();
  // Passed, skipped, cancelled and failed counts from the snapshot, then the listed checks.
  await eventually(
    rendered,
    (frame) =>
      frame.includes('\uf42e 2  \uf517 1  \uf46e 1  \uf467 2') &&
      /\uf467 Lint\s*\n.*\uf421 Approve deploy/.test(frame) &&
      frame.includes('Moves the build to Rspack.')
  );
  const frame = rendered.captureCharFrame();
  for (const name of ['Unit tests', 'Old e2e run', 'Docs', 'Typecheck']) {
    assert.ok(!frame.includes(name), `${name} is counted, not listed`);
  }
});

test('rows list each issue on its own line up to five, and "Group issues" joins them', async () => {
  const terminal = await host();
  const rendered = await testRender(() => terminal.overlay.render({}), { width: 140, height: 40 });
  active = rendered;
  terminal.attach(rendered.renderer);
  terminal.dispatch('session.list');
  await import('../../dist/page/view.js');
  await eventually(
    rendered,
    (frame) => frame.includes('Rspack issue 1') && frame.includes('+1 more')
  );
  const frame = rendered.captureCharFrame();
  // Newest link first; the sixth issue folds into `+1 more`.
  assert.match(frame, /#1 Rspack issue 1\s*\n.*#2 Rspack issue 2/);
  assert.match(frame, /#5 Rspack issue 5\s*\n.*\+1 more/);
  assert.doesNotMatch(frame, /Rspack issue 6/);

  const { tuiSettingsFor } = await import('../../dist/settings/store.js');
  await tuiSettingsFor(terminal.context).set('groupIssues', true);
  await eventually(rendered, (next) => /#1, .*#2, .*#3/.test(next) && !next.includes('+1 more'));
  assert.doesNotMatch(rendered.captureCharFrame(), /Rspack issue/);
});

// Old sessions are read only once the user selects one: no history reads on startup, and the
// scan reuses the page the preview loaded.
test('the selected session is scanned from the preview page, and nothing is scanned before', async () => {
  const terminal = await host();
  const rendered = await testRender(() => terminal.overlay.render({}), {
    width: 140,
    height: 30
  });
  active = rendered;
  terminal.attach(rendered.renderer);
  await rendered.renderOnce();
  assert.deepEqual(terminal.pages, []);
  assert.deepEqual(terminal.scans, []);

  terminal.dispatch('session.list');
  await import('../../dist/page/view.js');
  await eventually(rendered, () => terminal.scans.length > 0);
  const [scan] = terminal.scans;
  assert.deepEqual(scan, {
    sessionID: scan.sessionID,
    items: [{ type: 'prompt', key: 'm1', text: 'ok', created: NOW - DAY }],
    done: true,
    lastMessageID: 'm1'
  });
  assert.deepEqual(terminal.pages, [scan.sessionID]);
});

// Crossing the list toward the preview used to select every row under the pointer, so the preview
// jumped to sessions the user never chose.
test('hovering another row leaves the preview on the selected session', async () => {
  const terminal = await host();
  const rendered = await testRender(() => terminal.overlay.render({}), {
    width: 140,
    height: 30
  });
  active = rendered;
  terminal.attach(rendered.renderer);
  terminal.dispatch('session.list');
  await import('../../dist/page/view.js');
  await eventually(rendered, () => terminal.pages.length > 0);
  const [shown] = terminal.pages;
  const lines = rendered.captureCharFrame().split('\n');
  const y = lines.findIndex((line) => line.includes('can you find all merged worktrees'));
  assert.ok(y > 0 && shown !== 'unread', 'Another session is selected first.');
  const x = (lines[y] ?? '').indexOf('can you find');
  await rendered.mockMouse.moveTo(x, y);
  // Longer than the preview's 150 ms follow delay.
  for (let i = 0; i < 10; i++) {
    await rendered.renderOnce();
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.deepEqual(terminal.pages, [shown]);
});

// Message hits used to land in Running and the day groups a second after the title match, which
// read as the search breaking.
test('server message hits go under "In messages" and leave the local rows in place', async () => {
  let answer;
  const answered = new Promise((resolve) => {
    answer = resolve;
  });
  const terminal = await host(undefined, () => answered);
  const rendered = await testRender(() => terminal.overlay.render({}), { width: 100, height: 30 });
  active = rendered;
  terminal.attach(rendered.renderer);
  terminal.dispatch('session.list');
  await import('../../dist/page/view.js');
  await eventually(rendered, (frame) => frame.includes('Mastra build'));
  await rendered.mockInput.typeText('worktrees');
  await eventually(rendered, (frame) => !frame.includes('Mastra build'));
  const lines = () => rendered.captureCharFrame().split('\n');
  const row = (text) => lines().findIndex((line) => line.includes(text));
  const header = (title) => lines().findIndex((line) => line.trim() === title);
  const before = row('can you find all merged worktrees');
  assert.ok(before > 0);

  answer([
    { sessionID: 'unread', match: 'title', score: 3 },
    { sessionID: 'pinned', match: 'body', score: 1 },
    { sessionID: 'running', match: 'body', score: 1 }
  ]);
  await eventually(rendered, (frame) => frame.includes('Mastra build'));
  assert.equal(row('can you find all merged worktrees'), before);
  assert.equal(header('Running'), -1, 'A running message hit stays out of Running.');
  const messages = header('In messages');
  assert.ok(before < messages, 'Message hits come after the title match.');
  assert.ok(messages < row('Mastra build') && row('Mastra build') < row('Homelab Mastra'));
  const spans = rendered.captureSpans().lines.flatMap((line) => line.spans);
  const spanOf = (text) => spans.find((span) => span.text.includes(text));
  const dialog = theme.surface('dialog');
  assert.ok(spanOf('In messages')?.fg.equals(dialog.text.muted));
  assert.ok(
    spanOf('can you find all merged')?.bg.equals(dialog.background.action.primary.focused),
    'The title match stays selected.'
  );
});

// On a release CI never ran, the host's own list must answer its keys, and the user must learn
// why the browser is gone and how to reach it.
test('an untested OpenCode keeps its session list and quick switch, and says how to open the browser', async () => {
  const terminal = await host('99.0.0');
  const ids = terminal.layers.flatMap((layer) => layer.commands ?? []).map((item) => item.id);
  assert.ok(ids.includes('super-sessions.open'));
  assert.ok(!ids.includes('session.list'));
  assert.ok(!ids.includes('session.quick_switch.1'));
  assert.deepEqual(
    terminal.toasts.map((toast) => toast.message),
    ['Super Sessions has not been tested with OpenCode 99.0.0. Open it with /super-sessions.']
  );
});

// The host's own boundary would latch the overlay blank for good, leaving the user with no list.
// Run state feeds the shared list memos; permissions only the rows the view draws.
for (const [where, breakHost] of [
  ['the list memos', (data) => Object.assign(data.session, { status: crash })],
  ['the view', (data) => Object.assign(data.session.permission, { list: crash })]
]) {
  test(`a crash in ${where} closes the browser and opens the built-in list`, async () => {
    const terminal = await host();
    breakHost(terminal.context.data);
    const rendered = await testRender(() => terminal.overlay.render({}), {
      width: 100,
      height: 30
    });
    active = rendered;
    terminal.attach(rendered.renderer);
    terminal.dispatch('session.list');
    await import('../../dist/page/view.js');
    await eventually(rendered, () => terminal.dispatched.length > 0);
    assert.deepEqual(terminal.dispatched, [['session.list', 'classic']]);
    assert.deepEqual(
      terminal.toasts.map((toast) => toast.message),
      ['Super Sessions failed; showing the built-in list']
    );
    await rendered.renderOnce();
    assert.doesNotMatch(rendered.captureCharFrame(), /Search sessions/);
  });
}

/** A host API that changed under the plugin. */
function crash() {
  throw new Error('the host changed');
}
