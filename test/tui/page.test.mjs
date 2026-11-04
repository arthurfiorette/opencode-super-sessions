import { afterEach, test } from 'bun:test';
import assert from 'node:assert/strict';
import { migrateV1, resolveThemeDocument } from '@opencode/theme/tui';
import { testRender } from '@opentui/solid';
import { jsx } from '@opentui/solid/jsx-runtime';
import { onCleanup } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import plugin from '../../dist/tui.js';
import themeSource from '../fixtures/theme-opencode.json';

const NOW = Date.now();
const MINUTE = 60_000;
const DAY = 86_400_000;
const theme = resolveThemeDocument(migrateV1(themeSource), 'dark');
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
  assistant: [
    {
      type: 'assistant',
      id: 'm2',
      agent: 'build',
      model: { id: 'opus', providerID: 'anthropic' },
      time: { created: NOW - MINUTE },
      content: [{ type: 'text', text: 'Removed 6 worktrees; 2 have unpushed commits\nmore' }]
    }
  ],
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

/** A host stand-in: the real plugin entry against fake client, data, keymap, storage and router. */
async function host() {
  let renderer;
  const sessions = fixtures();
  const layers = [];
  const pages = [];
  const navigations = [];
  const updates = [];
  const toasts = [];
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
          data: sessions.filter((item) => (item.time.archived !== undefined) === input.archived),
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
          data:
            input.type === 'user'
              ? messages.user
              : input.type === 'assistant'
                ? messages.assistant
                : messages.transcript,
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
        search: async () => {
          throw new Error('not registered');
        }
      })
    },
    data: {
      on: () => () => {},
      session: {
        list: () => sessions,
        get: () => undefined,
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
        model: { list: () => [] }
      }
    },
    keymap: {
      layer(factory) {
        const layer = factory();
        layers.push(layer);
        // Page layers belong to the page component and leave with it, like the host's.
        try {
          onCleanup(() => layers.splice(layers.indexOf(layer), 1));
        } catch {}
      },
      dispatch() {},
      shortcuts: (id) => (BINDINGS[id] ? [BINDINGS[id]] : [])
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
          name === 'pins' ? { imported: true, ids: ['pinned'] } : structuredClone(options.initial);
        const [store, set] = createStore(initial);
        return [store, async (mutation) => set(produce(mutation))];
      }
    },
    ui: {
      slot: () => () => {},
      router: {
        register(page) {
          pages.push(page);
          return () => {};
        },
        navigate: (route) => navigations.push(route),
        current: () => ({ type: 'home' })
      },
      toast: { show: (value) => toasts.push(value) },
      dialog: { clear() {} },
      tabs: { enabled: () => false, close: () => true },
      format: { path: (value) => value }
    }
  };
  await plugin.setup(context);
  const page = pages.find((item) => item.name === 'sessions');
  assert.ok(page, 'The page registers under the sessions route.');
  return {
    context,
    page,
    layers,
    navigations,
    updates,
    toasts,
    attach(value) {
      renderer = value;
    }
  };
}

/** Routes key presses through the page layer the way the host keymap does. */
function keymap(terminal, renderer) {
  renderer.keyInput.on('keypress', (event) => {
    const name = event.name === ' ' ? 'space' : event.name;
    const bind = `${event.ctrl ? 'ctrl+' : ''}${event.shift ? 'shift+' : ''}${name}`;
    for (const layer of [...terminal.layers].reverse()) {
      if (layer.mode === 'global') continue;
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

/** Bounded polling for work behind real timers, such as the preview's 150 ms follow delay. */
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

async function mount(width, height = 30) {
  const terminal = await host();
  const rendered = await testRender(
    () =>
      jsx('box', {
        width: '100%',
        height: '100%',
        get children() {
          return terminal.page.render({ data: { returnRoute: { type: 'home' } } });
        }
      }),
    { width, height }
  );
  active = rendered;
  terminal.attach(rendered.renderer);
  keymap(terminal, rendered.renderer);
  // Mount cold first, then wait for the lazy module; renderer idle does not mean it loaded.
  await import('../../dist/page/view.js');
  await rendered.waitForFrame((frame) => frame.includes('Mastra build') && frame.includes('#4930'));
  return { terminal, rendered, lines: () => rendered.captureCharFrame().split('\n') };
}

test('rows use two lines, full-width titles and a fixed title column', async () => {
  const { rendered, lines } = await mount(100);
  await rendered.waitForFrame((frame) => frame.includes('last: Removed 6 worktrees'));
  const frame = lines();
  const row = (text) => frame.findIndex((line) => line.includes(text));

  const running = row('Mastra build: Rollup to Rspack');
  assert.match(frame[running + 1], /rspack-build .*#4930 Migrate build to Rspack/);
  assert.match(
    frame[row('can you find all merged') + 1],
    /last: Removed 6 worktrees; 2 have unpushed commits\s*$/
  );

  const long = frame[row('Investigate why the deployer')];
  const title = long.slice(long.indexOf('Investigate'), long.indexOf('…') + 1);
  assert.ok(title.endsWith('…'), 'A title that does not fit ends with an ellipsis.');
  assert.ok(title.length > 70, `The title uses the row width, got ${title.length} cells.`);
  assert.ok(!long.includes('END'));

  // Pin slot, spinner, unread dot and no marker must all leave the title in the same column.
  const columns = ['Homelab Mastra', 'Mastra build', 'can you find', 'Investigate why'].map(
    (text) => frame[row(text)].indexOf(text)
  );
  assert.deepEqual(new Set(columns).size, 1, `title columns: ${columns}`);
  assert.equal(frame[row('Homelab Mastra')].trimStart()[0], '1');
  assert.ok(
    !frame.some((line) => line.includes('Ship the release notes')),
    'Done sessions leave Active.'
  );
});

test('tab cycles views and ctrl+s archives the selected row', async () => {
  const { terminal, rendered } = await mount(100);
  rendered.mockInput.pressTab();
  await rendered.waitForFrame(
    (frame) => frame.includes('Ship the release notes') && !frame.includes('Homelab Mastra')
  );
  rendered.mockInput.pressTab();
  await rendered.waitForFrame(
    (frame) =>
      frame.includes('Old spike on Rollup plugins') && /archived 1d · updated 5d/.test(frame)
  );
  rendered.mockInput.pressTab();
  await rendered.waitForFrame((frame) => frame.includes('Homelab Mastra'));

  // The first row is the pinned session; move to the running one and archive it.
  rendered.mockInput.pressArrow('down');
  rendered.mockInput.pressKey('s', { ctrl: true });
  await rendered.waitForFrame((frame) => !frame.includes('Mastra build: Rollup to Rspack'));
  assert.deepEqual(terminal.updates, [{ sessionID: 'running', archived: true }]);
  assert.match(rendered.captureCharFrame(), /Archived 2/);
});

test('the preview pane shows only on wide terminals', async () => {
  const narrow = await mount(100);
  assert.ok(!narrow.rendered.captureCharFrame().includes('tokens'));
  narrow.rendered.renderer.destroy();
  active = undefined;

  const wide = await mount(140, 40);
  await eventually(
    wide.rendered,
    (frame) => frame.includes('tokens') && frame.includes('can we keep rollup as a fallback?')
  );
  const frame = wide.rendered.captureCharFrame();
  assert.match(frame, /▸ shell\s+pnpm test --filter deployer/);
  assert.match(frame, /Rollup stays as a fallback\./, 'Markdown renders without its markup.');
});

test('space types into a non-empty search instead of peeking', async () => {
  const { terminal, rendered } = await mount(100);
  await rendered.mockInput.typeText('rollup to');
  await rendered.waitForFrame((frame) => frame.includes('> rollup to'));
  assert.deepEqual(terminal.navigations, []);
});
