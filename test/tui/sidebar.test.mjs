import { mock, test } from 'bun:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrateV1, resolveThemeDocument } from '@opencode/theme/tui';
import { testRender } from '@opentui/solid';
import { jsx } from '@opentui/solid/jsx-runtime';
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

const pr = { provider: 'github', host: 'github.com', repo: 'mastra-ai/mastra', kind: 'pr' };
const view = {
  links: [
    { ref: { ...pr, number: 4930 }, source: 'agent', linkedAt: 2 },
    { ref: { ...pr, number: 4871 }, source: 'manual', linkedAt: 1 }
  ],
  branchRefs: [],
  states: Object.fromEntries(
    [
      [4930, 'Migrate build to Rspack'],
      [4871, 'Rollup plugin order']
    ].map(([number, title]) => [
      `github:github.com/mastra-ai/mastra/pr/${number}`,
      {
        status: 'open',
        title,
        url: `https://github.com/mastra-ai/mastra/pull/${number}`,
        ...(number === 4930
          ? {
              review: {
                decision: 'changes_requested',
                checks: 'failing',
                checksPassed: 1,
                checksTotal: 2
              }
            }
          : // Conflicts alone still earn the status line.
            { review: { conflicts: true } })
      }
    ])
  )
};

test('the Work rows load cold, put status icons and failed checks under the PR line, and a click on a row opens its own URL', async () => {
  let claim;
  const answer = async ({ sessionIDs }) => Object.fromEntries(sessionIDs.map((id) => [id, view]));
  const details = async ({ ref }) => ({
    body: '',
    checks:
      ref.number === 4930
        ? [
            { name: 'Lint', status: 'failure', url: 'https://ci.example/lint' },
            { name: 'Build', status: 'success' }
          ]
        : []
  });
  const context = {
    location: { directory: '/repo' },
    theme: resolveThemeDocument(migrateV1(themeSource), 'dark'),
    themeMode: 'dark',
    client: { rpc: () => ({ refs: answer, refresh: answer, 'pull.details': details }) },
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
  const options = parseOptions({});
  // The plugin entry creates these before the sidebar; the view reads them for title scrolling.
  createTuiSettings(context, options);
  const unregister = installSidebar(context, options);
  const rendered = await testRender(
    () =>
      jsx('box', { width: '100%', height: '100%', children: claim.render({ sessionID: 'work' }) }),
    { width: 50, height: 20 }
  );
  try {
    // Mount cold first, then wait for the lazy module; renderer idle does not mean it loaded.
    await import('../../dist/sidebar-view.js');
    await rendered.waitForFrame(
      (frame) =>
        // The PR line holds only the number and title; the icons and counts go on the next line.
        frame.includes('#4930 Migrate build to Rspack') &&
        frame.includes('#4871') &&
        frame.includes(' 1/2') &&
        !frame.includes('changes requested') &&
        frame.includes('\uf421') &&
        frame.includes('Lint') &&
        !frame.includes('Build')
    );
    const second = rendered.renderer.root.findDescendantById('super-sessions-sidebar-ref-1');
    await rendered.mockMouse.click(second.x + 4, second.y);
    assert.deepEqual(opened, ['https://github.com/mastra-ai/mastra/pull/4871']);
  } finally {
    unregister();
    rendered.renderer.destroy();
  }
});
