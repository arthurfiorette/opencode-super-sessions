import { mock, test } from 'bun:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrateV1, resolveThemeDocument } from '@opencode/theme/tui';
import { RGBA } from '@opentui/core';
import { testRender } from '@opentui/solid';
import { jsx } from '@opentui/solid/jsx-runtime';
import { createSignal } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import themeSource from '../fixtures/theme-opencode.json';

// The host's defaults, whatever the developer's own cli.json says.
process.env.OPENCODE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'super-sessions-cli-'));

// The OS opener is the external boundary; record what it would open instead of launching a browser.
const opened = [];
mock.module('node:child_process', () => ({
  ...childProcess,
  spawn: (_command, args) => {
    opened.push(args[0]);
    return { on() {}, unref() {} };
  }
}));
const { installSidebar } = await import('../../dist/sidebar.js');
const { createTuiSettings } = await import('../../dist/settings/store.js');
const { parseOptions } = await import('../../dist/config.js');

/** A mastra-ai/mastra pull request or issue. */
const ref = (kind, number) => ({
  provider: 'github',
  host: 'github.com',
  repo: 'mastra-ai/mastra',
  kind,
  number
});
/** The `refKey` format the server uses for `states`. */
const key = (value) =>
  `${value.provider}:${value.host}/${value.repo}/${value.kind}/${value.number}`.toLowerCase();
/** A forge snapshot with the ref's real GitHub URL. */
const state = (value, status, title) => ({
  status,
  title,
  url: `https://github.com/mastra-ai/mastra/${value.kind === 'pr' ? 'pull' : 'issues'}/${value.number}`
});

const branchPr = ref('pr', 4930);
const linkedPr = ref('pr', 4871);
const issue = ref('issue', 28957);
const views = {
  work: {
    links: [
      // Newest link, but issues still list after pull requests.
      { ref: issue, source: 'prompt', linkedAt: 5 },
      { ref: linkedPr, source: 'manual', linkedAt: 3 },
      { ref: branchPr, source: 'mention', linkedAt: 4 },
      { ref: ref('pr', 9), source: 'mention', linkedAt: 4 },
      { ref: ref('issue', 10), source: 'mention', linkedAt: 4 }
    ],
    branchRefs: [branchPr],
    states: {
      [key(branchPr)]: {
        ...state(branchPr, 'open', 'Migrate build to Rspack'),
        review: { decision: 'approved', threads: 3, unresolved: 1, checks: 'passing' }
      },
      [key(linkedPr)]: state(linkedPr, 'merged', 'Rollup plugin order'),
      [key(issue)]: state(issue, 'open', 'Windows 8.3 short path bug in the deployer')
    }
  },
  idle: { links: [], branchRefs: [], states: {} }
};

test('the Work rows list tracked refs at the top of the sidebar, open refs and hide without refs', async () => {
  let claim;
  const theme = resolveThemeDocument(migrateV1(themeSource), 'dark');
  const answer = async ({ sessionIDs }) =>
    Object.fromEntries(sessionIDs.map((id) => [id, views[id]]));
  const context = {
    location: { directory: '/repo' },
    theme,
    themeMode: 'dark',
    client: { rpc: () => ({ refs: answer, refresh: answer }) },
    data: {
      on: () => () => {},
      session: { get: () => undefined },
      location: { default: () => ({ directory: '/repo' }) }
    },
    keymap: { layer() {} },
    storage: {
      store(_name, options) {
        const [store, set] = createStore(structuredClone(options.initial));
        return [store, async (mutation) => set(produce(mutation))];
      }
    },
    ui: {
      slot(value) {
        claim = value;
        return () => {};
      },
      toast: { show() {} }
    }
  };
  const openColor = '#00ff00';
  const options = parseOptions({ colors: { open: openColor } });
  // The plugin entry creates these before the sidebar; the view reads them for title scrolling.
  createTuiSettings(context, options);
  const unregister = installSidebar(context, options);
  assert.equal(claim.prepend, 'sidebar.content');
  const [sessionID, setSessionID] = createSignal('work');
  const rendered = await testRender(
    () =>
      jsx('box', {
        width: '100%',
        height: '100%',
        get children() {
          return claim.render({
            get sessionID() {
              return sessionID();
            }
          });
        }
      }),
    { width: 50, height: 20 }
  );
  try {
    // Mount cold first, then wait for the lazy module; renderer idle does not mean it loaded.
    await import('../../dist/sidebar-view.js');
    await rendered.waitForFrame((frame) => frame.includes('Windows'));
    const lines = () => rendered.captureCharFrame().split('\n');
    const row = (text) => lines().findIndex((line) => line.includes(text));
    const order = [
      '#4930 Migrate build',
      'approved · 2/3 threads resolved · checks passing',
      '#4871 Rollup',
      '#28957 Windows',
      '+2 mentioned'
    ].map(row);
    assert.ok(
      order.every((index, position) => index > (order[position - 1] ?? -1)),
      `rows: ${order}\n${rendered.captureCharFrame()}`
    );
    assert.equal(order[0], 0, 'No heading above the rows.');
    assert.ok(lines()[order[0]].trimEnd().endsWith('branch'), 'The branch PR is marked.');
    // Ref rows start in the column of the section headings, like the native MCP dots under theirs.
    for (const index of [order[0], order[2], order[3], order[4]]) {
      assert.equal(lines()[index].search(/\S/), 0, lines()[index]);
    }
    const branchRow = (part) =>
      rendered.renderer.root.findDescendantById(`super-sessions-sidebar-ref-0-${part}`);
    assert.ok(branchRow('icon').fg.equals(RGBA.fromHex(openColor)), 'The icon shows the state.');
    assert.ok(branchRow('number').fg.equals(theme.text.base), 'The number reads as plain text.');

    const linked = rendered.renderer.root.findDescendantById('super-sessions-sidebar-ref-1');
    await rendered.mockMouse.click(linked.x + 4, linked.y);
    assert.deepEqual(opened, ['https://github.com/mastra-ai/mastra/pull/4871']);

    rendered.resize(24, 20);
    await rendered.waitForFrame((frame) => frame.includes('Windows') && !frame.includes('path'));
    for (const number of ['#4930', '#4871', '#28957']) {
      const matching = lines().filter((line) => line.includes(number));
      assert.equal(matching.length, 1, `${number} stays on one line`);
      assert.ok(matching[0].trimEnd().length <= 24);
    }
    assert.ok(!rendered.captureCharFrame().includes('deployer'));

    setSessionID('idle');
    await rendered.waitForFrame((frame) => !frame.includes('#'));
    assert.equal(rendered.captureCharFrame().trim(), '', 'A session without refs shows nothing.');
  } finally {
    unregister();
    rendered.renderer.destroy();
  }
});
