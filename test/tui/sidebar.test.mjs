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
                checksTotal: 3
              }
            }
          : // Conflicts alone still earn the status line.
            { review: { conflicts: true } })
      }
    ])
  )
};

test('the Work rows load cold, put the status icons and the first failed check on one line under the PR line, and a click on a row or a check opens its own URL', async () => {
  let claim;
  const answer = async ({ sessionIDs }) => Object.fromEntries(sessionIDs.map((id) => [id, view]));
  const details = async ({ ref }) => ({
    body: '',
    checks:
      ref.number === 4930
        ? [
            { name: 'Lint', status: 'failure', url: 'https://ci.example/lint' },
            { name: 'Build', status: 'success' },
            { name: 'Typecheck', status: 'failure', url: 'https://ci.example/typecheck' }
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
    const frame = await rendered.waitForFrame(
      (frame) =>
        frame.includes('#4930 Migrate build to Rspack') &&
        frame.includes('#4871') &&
        frame.includes('Typecheck')
    );
    const lines = frame.split('\n');
    const pr = lines.findIndex((line) => line.includes('#4930'));
    // The PR line holds only the number and title. Under it the review icon shares a line with
    // the first failed check; the CI icon is left out since each check carries its own x.
    assert.match(lines[pr + 1], /^ {2}\uf4d2 {2}\uf467 Lint\s*$/);
    assert.equal(lines[pr + 2].indexOf('\uf467 Typecheck'), lines[pr + 1].indexOf('\uf467'));
    assert.equal(frame.split('\uf467').length - 1, 2);
    assert.ok(!frame.includes('Build') && !frame.includes('1/3'));
    // Conflicts alone still earn the status line, without check lines.
    assert.match(lines[lines.findIndex((line) => line.includes('#4871')) + 1], /^ {2}\uf421\s*$/);

    await rendered.mockMouse.click(lines[pr + 1].indexOf('Lint') + 1, pr + 1);
    await rendered.mockMouse.click(lines[pr + 1].indexOf('\uf4d2'), pr + 1);
    const second = rendered.renderer.root.findDescendantById('super-sessions-sidebar-ref-1');
    await rendered.mockMouse.click(second.x + 4, second.y);
    assert.deepEqual(opened, [
      'https://ci.example/lint',
      'https://github.com/mastra-ai/mastra/pull/4871'
    ]);
  } finally {
    unregister();
    rendered.renderer.destroy();
  }
});
