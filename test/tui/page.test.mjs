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

// Every session's prompts, newest first, as `message.list` with `type: 'user'` returns them.
const PROMPTS = [
  { type: 'user', id: 'u2', text: 'Now port the\nconfig too', time: { created: NOW - DAY } },
  { type: 'user', id: 'u1', text: 'Move the build to Rspack', time: { created: NOW - 2 * DAY } }
];

const issues = [1, 2, 3, 4, 5, 6].map((number) => ({ ...pr4930, kind: 'issue', number }));
const pr4870 = { ...pr4930, number: 4870 };
// States the server has not fetched yet: the cached `refs` read leaves them out, and only a
// `refresh`, which waits for the forge, answers with them.
const LIVE_STATES = {
  archived: {
    [key(pr4870)]: {
      status: 'merged',
      title: 'Drop the Rollup plugins',
      url: 'https://github.com/mastra-ai/mastra/pull/4870'
    }
  }
};
const refViews = {
  archived: {
    links: [{ ref: pr4870, source: 'agent', linkedAt: 1 }],
    branchRefs: [],
    states: {}
  },
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

// Directories under GONE no longer exist, like a worktree the cleanup removed before a restart.
const GONE = '/gone/';

/** The host's answer for a Location whose directory is missing. */
const missing = (directory) =>
  Object.assign(new Error(`Location not found: ${directory}`), { _tag: 'LocationNotFoundError' });

/**
 * A host stand-in: the real plugin entry against fake client, data, keymap, storage and router.
 * The server plugin is missing, so its search RPC throws unless `search` stands in for it.
 * `extra` sessions join the fixtures.
 */
async function host(
  version = '2.2.5',
  search = async () => {
    throw new Error('not registered');
  },
  extra = []
) {
  let renderer;
  const toasts = [];
  // Commands the plugin hands to the host keymap, as `[id, input]`.
  const dispatched = [];
  const sessions = [...fixtures(), ...extra];
  const layers = [];
  const slots = [];
  const modes = [];
  const [route, setRoute] = createSignal({ type: 'session', sessionID: 'unread' });
  const memories = new Map();
  // Sessions whose transcript pages were read, and the `history.scan` calls.
  const pages = [];
  const scans = [];
  // `session.fork` calls, and the select dialogs the plugin opened, each with its `resolve`.
  const forks = [];
  const selects = [];
  // Set, `session.list` never answers, like a busy server.
  let stalled = false;
  // `unlink` calls; later views leave their keys out, as the server's dismissal does.
  const unlinks = [];
  // The session ids of each `refresh` call.
  const refreshes = [];
  /**
   * A session's view without the links unlinked from it. `live` adds the states only the forge
   * knows, as the waiting `refresh` does.
   */
  const viewOf = (id, live) => {
    const gone = new Set(unlinks.filter((item) => item.sessionID === id).map((item) => item.key));
    const view = refViews[id];
    return {
      ...view,
      links: view.links.filter((link) => !gone.has(key(link.ref))),
      states: live ? { ...view.states, ...LIVE_STATES[id] } : view.states
    };
  };
  // RPCs reach the server plugin through a Location, which a missing directory does not have.
  const views = async ({ sessionIDs }, options, live = false) => {
    const directory = options?.location?.directory ?? '/repo';
    if (directory.startsWith(GONE)) throw missing(directory);
    return Object.fromEntries(
      sessionIDs.filter((id) => refViews[id]).map((id) => [id, viewOf(id, live)])
    );
  };
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
        // Every directory is a checkout of one project: the main one or a worktree.
        get: async ({ location: { directory } }) => {
          if (directory.startsWith(GONE)) throw missing(directory);
          return { directory, project: { id: 'proj', directory, canonical: '/repo' } };
        }
      },
      session: {
        list: async (input) => {
          if (stalled) await new Promise(() => {});
          return {
            data: sessions.filter(
              (item) =>
                (item.time.archived !== undefined) === input.archived &&
                (!input.search || item.title.toLowerCase().includes(input.search.toLowerCase()))
            ),
            cursor: {}
          };
        },
        get: async ({ sessionID }) => sessions.find((item) => item.id === sessionID),
        update: async () => {},
        remove: async () => {},
        fork: async (input) => {
          forks.push(input);
          return session('forked', 'Forked session');
        }
      },
      message: {
        list: async (input) => {
          if (input.type === 'user')
            return { data: PROMPTS.slice(0, input.limit), cursor: { next: 'older' } };
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
        refresh: (input, options) => {
          refreshes.push(input.sessionIDs);
          return views(input, options, true);
        },
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
        unlink: async (input) => {
          unlinks.push(input);
          return {};
        },
        search
      })
    },
    data: {
      on: () => () => {},
      session: {
        list: () => sessions,
        get: (id) => sessions.find((item) => item.id === id),
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
      dialog: {
        clear() {},
        set() {},
        select: (options) => new Promise((resolve) => selects.push({ ...options, resolve }))
      },
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
    navigate: setRoute,
    pages,
    scans,
    forks,
    selects,
    unlinks,
    refreshes,
    stallLists() {
      stalled = true;
    },
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

// A merged branch PR used to take the row's only PR line and hide the session's open PR.
test('a row lists every pull request, the open one above the merged branch PR', async () => {
  const merged = { ...pr4930, number: 29169 };
  const open = { ...pr4930, number: 29489 };
  refViews.multi = {
    links: [{ ref: open, source: 'agent', linkedAt: 2 }],
    branchRefs: [merged],
    states: {
      [key(merged)]: { status: 'merged', title: 'Merged branch fix', url: 'u' },
      [key(open)]: {
        status: 'open',
        title: 'Open follow-up fix',
        url: 'u',
        review: { decision: 'review_required', checks: 'pending' }
      }
    }
  };
  const terminal = await host(undefined, undefined, [
    session('multi', 'Nested state merge fix', { updated: NOW - 30 * MINUTE })
  ]);
  const rendered = await testRender(() => terminal.overlay.render({}), { width: 140, height: 40 });
  active = rendered;
  terminal.attach(rendered.renderer);
  terminal.dispatch('session.list');
  await import('../../dist/page/view.js');
  await eventually(rendered, (frame) => frame.includes('Merged branch fix'));
  const lines = rendered.captureCharFrame().split('\n');
  const title = lines.findIndex((line) => line.includes('Nested state merge fix'));
  assert.match(lines[title + 1] ?? '', /#29489 .*Open follow-up fix/);
  assert.match(lines[title + 2] ?? '', /#29169 Merged branch fix/);
  delete refViews.multi;
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

test('ctrl+b forks the selected session before the picked prompt and opens the fork', async () => {
  const terminal = await host();
  const rendered = await testRender(() => terminal.overlay.render({}), { width: 140, height: 30 });
  active = rendered;
  terminal.attach(rendered.renderer);
  terminal.dispatch('session.list');
  await import('../../dist/page/view.js');
  // The preview reads the selected session's transcript.
  await eventually(rendered, () => terminal.pages.length > 0);
  const [selected] = terminal.pages;
  const command = (bind) =>
    terminal.layers.flatMap((layer) => layer.commands ?? []).find((item) => item.bind === bind);

  command('ctrl+b').run();
  await eventually(rendered, () => terminal.selects.length > 0);
  const [dialog] = terminal.selects;
  assert.equal(dialog.title, 'Fork session');
  assert.deepEqual(
    dialog.options.map((option) => [option.title, option.value]),
    [
      ['Full session', null],
      ['Now port the config too', 'u2'],
      ['Move the build to Rspack', 'u1']
    ]
  );
  dialog.resolve('u2');
  await eventually(rendered, (frame) => !frame.includes('Search sessions'));
  assert.deepEqual(terminal.forks, [{ sessionID: selected, before: 'u2' }]);
  assert.deepEqual(terminal.route(), { type: 'session', sessionID: 'forked' });

  // A Pull requests row is a pull request, not a session to fork.
  terminal.dispatch('session.list');
  await eventually(rendered, (frame) => frame.includes('Search sessions'));
  assert.equal(command('ctrl+b').enabled(), true);
  command('shift+tab').run();
  await eventually(rendered, (frame) => /#4930 .*Migrate build to Rspack/.test(frame));
  assert.equal(command('ctrl+b').enabled(), false);
});

// Unlinking asks for no confirmation, so the key must act only on the Work links; on the list `d`
// is a letter of the search.
test('d and delete in the Work links unlink the selected ref, and the next ref takes the selection', async () => {
  const terminal = await host();
  const rendered = await testRender(() => terminal.overlay.render({}), { width: 140, height: 40 });
  active = rendered;
  terminal.attach(rendered.renderer);
  terminal.dispatch('session.list');
  await import('../../dist/page/view.js');
  await eventually(rendered, (frame) => frame.includes('Rspack issue 1'));
  // Leaves the session with six issues alone in the list, selected.
  await rendered.mockInput.typeText('worktrees');
  await eventually(rendered, (frame) => !frame.includes('Mastra build'));
  /** Runs the browser's binding for `bind` like the host: a disabled one leaves the key to the search. */
  const press = (bind) => {
    const command = terminal.layers
      .filter((layer) => layer.mode === 'super-sessions')
      .flatMap((layer) => layer.commands)
      .find((item) => item.bind === bind);
    return command.enabled?.() === false ? false : command.run();
  };
  assert.equal(press('d'), false);

  press('right');
  press('d');
  await eventually(rendered, (frame) => !frame.includes('Rspack issue 1'));
  press('delete');
  await eventually(rendered, (frame) => !frame.includes('Rspack issue 2'));
  assert.deepEqual(terminal.unlinks, [
    { sessionID: 'unread', key: key(issues[0]) },
    { sessionID: 'unread', key: key(issues[1]) }
  ]);
  assert.match(rendered.captureCharFrame(), /Rspack issue 3/);
  assert.deepEqual(
    terminal.toasts.map((toast) => toast.message),
    ['Unlinked issue #1. ctrl+l links it again.', 'Unlinked issue #2. ctrl+l links it again.']
  );
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

/** Renders the overlay alone and opens the browser cold. */
async function openBrowser(terminal) {
  const rendered = await testRender(() => terminal.overlay.render({}), { width: 100, height: 30 });
  active = rendered;
  terminal.attach(rendered.renderer);
  terminal.dispatch('session.list');
  await import('../../dist/page/view.js');
  return rendered;
}

// Opening over a session in another worktree of the same project dropped the cached lists, showed
// "Loading sessions…" and drew the same rows again.
test('reopening over a session in another worktree of the project draws the cached rows at once', async () => {
  const terminal = await host(undefined, undefined, [
    {
      ...session('worktree', 'Rspack config in a worktree'),
      location: { directory: '/repo/.worktrees/rspack' }
    }
  ]);
  const rendered = await openBrowser(terminal);
  await eventually(rendered, (frame) => frame.includes('#4930'));
  terminal.dispatch('session.list');
  terminal.navigate({ type: 'session', sessionID: 'worktree' });
  // Dropping the cache would leave the list on "Loading sessions…" from here on.
  terminal.stallLists();
  terminal.dispatch('session.list');
  // The header names the project once the location lookup that decides about the cache is in.
  const frames = [];
  await eventually(rendered, (frame) => {
    frames.push(frame);
    return frame.includes('Super Sessions for mastra') && frame.includes('#4930');
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await rendered.renderOnce();
  frames.push(rendered.captureCharFrame());
  assert.match(frames.at(-1), /Mastra build[\s\S]*#4930[\s\S]*Rspack config in a worktree/);
  assert.ok(frames.every((frame) => !frame.includes('Loading sessions')));
});

// Only the rows on screen at open and the 60 s tick asked the forge, so after `tab` a row whose
// refs were never fetched showed a bare `#N` for up to a minute.
test('switching views asks for the new rows at once, and once per row across switches', async () => {
  const terminal = await host();
  const rendered = await openBrowser(terminal);
  await eventually(rendered, (frame) => frame.includes('Mastra build'));
  const asked = () => terminal.refreshes.filter((ids) => ids.includes('archived')).length;
  assert.equal(asked(), 0, 'A row in another view is not asked for at open.');
  const press = (bind) =>
    terminal.layers
      .filter((layer) => layer.mode === 'super-sessions')
      .flatMap((layer) => layer.commands)
      .find((command) => command.bind === bind)
      .run();

  press('tab');
  press('tab');
  await eventually(rendered, (frame) => /\uf419 #4870 Drop the Rollup plugins/.test(frame));
  assert.equal(asked(), 1);

  // A full cycle back to Archived draws the row from the states already in hand.
  for (let i = 0; i < 4; i++) press('tab');
  await eventually(rendered, (frame) => frame.includes('Drop the Rollup plugins'));
  assert.equal(asked(), 1);
});

// After a restart the host no longer resolves the directory of a worktree the cleanup removed,
// and the browser opened over a session there said "Could not load sessions."
test('the browser opened over a session whose directory is gone lists its project', async () => {
  const terminal = await host(undefined, undefined, [
    { ...session('gone', 'Session in a removed worktree'), location: { directory: `${GONE}wt` } }
  ]);
  terminal.navigate({ type: 'session', sessionID: 'gone' });
  const rendered = await openBrowser(terminal);
  await eventually(
    rendered,
    (frame) => frame.includes('Session in a removed worktree') && frame.includes('#4930')
  );
});

// The search survived closing, so the next open showed a list filtered by a query the user had
// left behind. Coming back from a peek keeps it: the user is walking through the results.
test('a new open starts with an empty search, and coming back from a peek keeps it', async () => {
  const terminal = await host();
  // The keys dialog peeks, since `space` types into a search that is not empty.
  terminal.context.ui.dialog.select = async ({ options }) =>
    options.findIndex((option) => option.title === 'Peek session');
  const rendered = await openBrowser(terminal);
  await eventually(rendered, (frame) => frame.includes('Mastra build'));
  // The last keystrokes match the same sessions, so the rows stay the same while every keystroke
  // clears the selection; the peek below needs the first row selected again without an arrow.
  await rendered.mockInput.typeText('worktrees');
  await eventually(rendered, (frame) => !frame.includes('Mastra build'));
  /** Runs one of the browser's own keys, past the peek keys that share them. */
  const press = (bind) =>
    terminal.layers
      .filter((layer) => layer.mode === 'super-sessions')
      .flatMap((layer) => layer.commands)
      .find((command) => command.bind === bind)
      .run();
  press('ctrl+/');
  await eventually(rendered, (frame) => !frame.includes('can you find all merged'));
  terminal.dispatch('super-sessions.peek.return');
  await eventually(
    rendered,
    (frame) =>
      frame.includes('worktrees') &&
      frame.includes('can you find all merged') &&
      !frame.includes('Mastra build')
  );

  terminal.dispatch('session.list');
  await eventually(rendered, (frame) => !frame.includes('can you find all merged'));
  terminal.dispatch('session.list');
  await eventually(
    rendered,
    (frame) => frame.includes('Search sessions, #numbers') && frame.includes('Mastra build')
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
