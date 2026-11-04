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
import plugin from '../../dist/tui.js';
import themeSource from '../fixtures/theme-opencode.json';

// The host's defaults, whatever the developer's own cli.json says.
process.env.OPENCODE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'super-sessions-cli-'));

const NOW = Date.now();
const MINUTE = 60_000;
const DAY = 86_400_000;
const theme = resolveThemeDocument(migrateV1(themeSource), 'dark');
const dialog = theme.surface('dialog');
const LONG_TITLE = `Investigate why the deployer rebuilds every workspace package ${'and keeps going '.repeat(8)}END`;
const pr4930 = {
  provider: 'github',
  host: 'github.com',
  repo: 'mastra-ai/mastra',
  kind: 'pr',
  number: 4930
};
const pr17 = {
  provider: 'github',
  host: 'github.com',
  repo: 'mastra-ai/mastra',
  kind: 'pr',
  number: 17
};
const key = (ref) =>
  `${ref.provider}:${ref.host}/${ref.repo}/${ref.kind}/${ref.number}`.toLowerCase();

const session = (id, title, time = {}, extra = {}) => ({
  id,
  title,
  projectID: 'proj',
  cost: 0,
  tokens: { input: 1000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: NOW - 10 * DAY, updated: NOW - MINUTE, ...time },
  location: { directory: '/repo' },
  ...extra
});

const fixtures = () => [
  session('pinned', 'Homelab Mastra triage design', { updated: NOW - 3 * DAY }, { cost: 4.1 }),
  session(
    'running',
    'Mastra build: Rollup to Rspack',
    { updated: NOW - 2 * MINUTE },
    { cost: 1.58 }
  ),
  session('unread', 'can you find all merged worktrees and remove them', {
    updated: NOW - 60 * MINUTE,
    idle: NOW - 60 * MINUTE,
    viewed: NOW - 2 * 60 * MINUTE
  }),
  session('long', LONG_TITLE, { updated: NOW - 4 * 60 * MINUTE }),
  session('done', 'Ship the release notes', { updated: NOW - 5 * 60 * MINUTE }),
  session('archived', 'Old spike on Rollup plugins', {
    archived: NOW - DAY,
    updated: NOW - 5 * DAY
  })
];

const refViews = {
  running: {
    links: [{ ref: pr4930, source: 'agent', linkedAt: 1 }],
    branch: 'rspack-build',
    defaultBranch: 'main',
    branchRefs: [],
    states: {
      [key(pr4930)]: {
        status: 'open',
        title: 'Migrate build to Rspack',
        url: 'https://github.com/mastra-ai/mastra/pull/4930'
      }
    }
  },
  done: {
    links: [{ ref: pr17, source: 'created', linkedAt: 1 }],
    branchRefs: [],
    states: {
      [key(pr17)]: {
        status: 'merged',
        title: 'Release notes',
        url: 'u',
        mergedAt: NOW - 30 * MINUTE
      }
    }
  }
};

const messages = {
  user: [{ type: 'user', id: 'm1', text: 'ok', time: { created: NOW - DAY } }],
  transcript: [
    {
      type: 'assistant',
      id: 'm4',
      agent: 'build',
      model: { id: 'opus', providerID: 'anthropic' },
      time: { created: NOW - MINUTE },
      content: [
        { type: 'text', text: 'Rollup stays as a **fallback**.' },
        {
          type: 'tool',
          id: 't',
          name: 'shell',
          state: {
            status: 'completed',
            input: { command: 'pnpm test --filter deployer' },
            content: []
          },
          time: { created: 0 }
        }
      ]
    },
    {
      type: 'user',
      id: 'm3',
      text: 'can we keep rollup as a fallback?',
      time: { created: NOW - 2 * MINUTE }
    }
  ]
};

const BINDINGS = {
  'session.rename': 'ctrl+r',
  'session.delete': 'ctrl+d',
  'session.pin.toggle': 'ctrl+f',
  'app.exit': 'ctrl+c'
};

/**
 * A host stand-in: the real plugin entry against fake client, data, keymap, storage and router.
 * `search` answers the server plugin's search RPC; by default the plugin is missing.
 */
async function host(search) {
  let renderer;
  const sessions = fixtures();
  const layers = [];
  const slots = [];
  const modes = [];
  const listeners = new Map();
  const [route, setRoute] = createSignal({ type: 'session', sessionID: 'unread' });
  const navigations = [];
  const updates = [];
  const memories = new Map();
  const context = {
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
        update: async (input) => {
          updates.push(input);
          const target = sessions.find((item) => item.id === input.sessionID);
          if (target && input.archived) target.time.archived = NOW;
        },
        remove: async () => {}
      },
      message: {
        list: async (input) => ({
          data: input.type === 'user' ? messages.user : messages.transcript,
          cursor: {}
        })
      },
      rpc: () => ({
        refs: async ({ sessionIDs }) =>
          Object.fromEntries(
            sessionIDs.filter((id) => refViews[id]).map((id) => [id, refViews[id]])
          ),
        refresh: async ({ sessionIDs }) =>
          Object.fromEntries(
            sessionIDs.filter((id) => refViews[id]).map((id) => [id, refViews[id]])
          ),
        search:
          search ??
          (async () => {
            throw new Error('not registered');
          })
      })
    },
    data: {
      on(type, handler) {
        listeners.set(type, [...(listeners.get(type) ?? []), handler]);
        return () => {};
      },
      session: {
        list: () => sessions,
        get: () => undefined,
        cost: () => 0,
        status: (id) => (id === 'running' ? 'running' : 'idle'),
        family: (id) => [id],
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
      dispatch() {},
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
      router: {
        navigate(destination) {
          navigations.push(destination);
          setRoute(destination);
        },
        current: route
      },
      toast: { show() {} },
      dialog: { clear() {} },
      tabs: { enabled: () => false, close: () => true },
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
    modes,
    navigations,
    updates,
    route,
    /** Runs a command registered by any layer, like `keymap.dispatch`. */
    dispatch(id) {
      const command = layers
        .flatMap((layer) => layer.commands ?? [])
        .find((item) => item.id === id);
      return command.run();
    },
    emit(type, event) {
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
    attach(value) {
      renderer = value;
    }
  };
}

/** Routes key presses through the layers active in the current mode, like the host keymap. */
function keymap(terminal, renderer) {
  renderer.keyInput.on('keypress', (event) => {
    const name = event.name === ' ' ? 'space' : event.name;
    const bind = `${event.ctrl ? 'ctrl+' : ''}${event.shift ? 'shift+' : ''}${name}`;
    const mode = terminal.context.keymap.mode.current();
    // Later layers first, and higher priority before that, like the host's resolution.
    const active = [...terminal.layers]
      .reverse()
      .filter((layer) => layer.mode === 'global' || (layer.mode ?? 'base') === mode)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    for (const layer of active) {
      const command = layer.commands?.find(
        (item) =>
          (item.bind ?? BINDINGS[item.id]) === bind &&
          (typeof item.enabled === 'function' ? item.enabled() : item.enabled !== false)
      );
      if (!command) continue;
      if (command.run(undefined, event) !== false) event.preventDefault();
      return;
    }
  });
}

/** Bounded polling for work behind real timers, such as the peek's 150 ms follow delay. */
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

/** Mounts the host's main column with the route, the composer slot and the app slot. */
async function mount(width, height = 30, search) {
  const terminal = await host(search);
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
    { width, height }
  );
  active = rendered;
  terminal.attach(rendered.renderer);
  keymap(terminal, rendered.renderer);
  terminal.dispatch('session.list');
  // Open cold first, then wait for the lazy module; renderer idle does not mean it loaded.
  await import('../../dist/page/view.js');
  await eventually(rendered, (frame) => frame.includes('Mastra build') && frame.includes('#4930'));
  const lines = () => rendered.captureCharFrame().split('\n');
  return {
    terminal,
    rendered,
    lines,
    row: (text) => lines().findIndex((line) => line.includes(text))
  };
}

/** Background of the cell where `text` starts on screen. */
function bgAt(rendered, text) {
  const frame = rendered.captureSpans();
  for (const line of frame.lines) {
    const span = line.spans.find((item) => item.text.includes(text));
    if (span) return span.bg.toInts();
  }
  throw new Error(`"${text}" is not on screen`);
}

test('rows take a line per detail they have, with no gap between rows and one blank line before a group', async () => {
  const { lines, row } = await mount(100);
  const frame = lines();

  // Running has a branch and a PR, so it takes three lines.
  const running = row('Mastra build: Rollup to Rspack');
  assert.match(frame[running + 1], /rspack-build\s*$/);
  assert.match(frame[running + 2], /#4930 Migrate build to Rspack/);
  // Both pins have neither: the second follows on the next line, then one blank line comes
  // before the Running header.
  const pinned = row('Homelab Mastra');
  assert.equal(row('can you find all merged'), pinned + 1);
  assert.equal(frame[pinned + 2].trim(), '');
  assert.equal(row('Running'), pinned + 3);
  assert.equal(row('Pinned'), pinned - 1, 'No blank line between a header and its first row.');

  const long = frame[row('Investigate why the deployer')];
  const title = long.slice(long.indexOf('Investigate'), long.indexOf('…') + 1);
  assert.ok(title.endsWith('…'), 'A title that does not fit ends with an ellipsis.');
  assert.ok(title.length > 60, `The title uses the row width, got ${title.length} cells.`);
  assert.ok(!long.includes('END'));

  // Pin slot, spinner and no marker must all leave the title in the same column.
  const columns = ['Homelab Mastra', 'Mastra build', 'Investigate why'].map((text) =>
    frame[row(text)].indexOf(text)
  );
  assert.deepEqual(new Set(columns).size, 1, `title columns: ${columns}`);
  assert.equal(frame[row('Homelab Mastra')].trimStart()[0], '1');
  assert.ok(row('Ship the release notes') === -1, 'Done sessions leave Active.');
});

test('esc closes the browser without touching the route and gives the keys back', async () => {
  const { terminal, rendered } = await mount(100);
  // The first row is selected and painted in the host's action token.
  assert.deepEqual(
    bgAt(rendered, 'Homelab Mastra'),
    dialog.background.action.primary.focused.toInts()
  );
  rendered.mockInput.pressEscape();
  await eventually(rendered, (frame) => !frame.includes('Homelab Mastra'));
  assert.ok(rendered.captureCharFrame().includes('session transcript'));
  assert.deepEqual(terminal.navigations, []);
  assert.deepEqual(terminal.modes, [], 'The browser keymap mode is popped.');
});

test('tab cycles views and ctrl+s archives the selected row', async () => {
  const { terminal, rendered } = await mount(100);
  rendered.mockInput.pressTab();
  await eventually(
    rendered,
    (frame) => frame.includes('Ship the release notes') && !frame.includes('Homelab Mastra')
  );
  rendered.mockInput.pressTab();
  await eventually(
    rendered,
    (frame) =>
      frame.includes('Old spike on Rollup plugins') && /archived 1d · updated 5d/.test(frame)
  );
  rendered.mockInput.pressTab();
  await eventually(rendered, (frame) => frame.includes('Homelab Mastra'));

  // The first rows are the two pins; move to the running one and archive it.
  rendered.mockInput.pressArrow('down');
  rendered.mockInput.pressArrow('down');
  rendered.mockInput.pressKey('s', { ctrl: true });
  await eventually(rendered, (frame) => !frame.includes('Mastra build: Rollup to Rspack'));
  assert.deepEqual(terminal.updates, [{ sessionID: 'running', archived: true }]);
  assert.match(rendered.captureCharFrame(), /Archived 2/);
});

test('search lists local matches before the server answers and says why each matched', async () => {
  let answer;
  const pending = new Promise((resolve) => {
    answer = resolve;
  });
  const { rendered, row, lines } = await mount(100, 30, () => pending);
  // "migrate" is only in the running session's PR title, which the browser already has.
  await rendered.mockInput.typeText('migrate');
  await eventually(
    rendered,
    (frame) => frame.includes('PR title') && !frame.includes('Homelab Mastra')
  );
  assert.ok(lines()[row('Mastra build')].includes('PR title'));
  assert.ok(!rendered.captureCharFrame().includes('Investigate why'));

  // The server adds a message match the client cannot see; local hits keep their place.
  answer([
    { sessionID: 'long', match: 'body', score: 0 },
    { sessionID: 'running', match: 'ref-title', ref: key(pr4930), score: 1 }
  ]);
  await eventually(rendered, (frame) => frame.includes('in messages'));
  assert.ok(row('Mastra build') < row('Investigate why'));
  assert.ok(lines()[row('Investigate why')].includes('in messages'));
});

test('space peeks, the arrows walk the list from the session, and esc comes back to that row', async () => {
  const { terminal, rendered } = await mount(100);
  rendered.mockInput.pressKey(' ');
  await eventually(rendered, (frame) => frame.includes('Peeking 1 of 4'));
  assert.deepEqual(terminal.navigations, [{ type: 'session', sessionID: 'pinned' }]);

  // The counter moves at once; the route follows after the pause.
  rendered.mockInput.pressArrow('down');
  await eventually(rendered, (frame) => frame.includes('Peeking 2 of 4'));
  await eventually(rendered, () => terminal.route().sessionID === 'unread');

  rendered.mockInput.pressEscape();
  await eventually(rendered, (frame) => frame.includes('Homelab Mastra'));
  assert.ok(!rendered.captureCharFrame().includes('Peeking'));
  assert.deepEqual(
    bgAt(rendered, 'can you find all merged'),
    dialog.background.action.primary.focused.toInts()
  );

  // Writing in the peeked session ends the peek, so esc belongs to the host again.
  rendered.mockInput.pressKey(' ');
  await eventually(rendered, (frame) => frame.includes('Peeking 2 of 4'));
  terminal.emit('session.inbox.enqueued', {
    data: { sessionID: 'unread', item: { type: 'user' } }
  });
  await eventually(rendered, (frame) => !frame.includes('Peeking'));
  rendered.mockInput.pressEscape();
  await rendered.renderOnce();
  assert.ok(!rendered.captureCharFrame().includes('Homelab Mastra'));
});

test('the preview pane shows only on wide terminals', async () => {
  const narrow = await mount(100);
  assert.ok(!narrow.rendered.captureCharFrame().includes('Context'));
  narrow.rendered.renderer.destroy();
  active = undefined;

  const wide = await mount(140, 40);
  await eventually(
    wide.rendered,
    (frame) => frame.includes('Context') && frame.includes('can we keep rollup as a fallback?')
  );
  const frame = wide.rendered.captureCharFrame();
  assert.match(frame, /\$ pnpm test --filter deployer/);
  assert.match(frame, /Rollup stays as a fallback\./, 'Markdown renders without its markup.');
});

test('space types into a non-empty search instead of peeking', async () => {
  const { terminal, rendered } = await mount(100);
  await rendered.mockInput.typeText('rollup to');
  await eventually(rendered, (frame) => frame.includes('rollup to'));
  assert.deepEqual(terminal.navigations, []);
});
