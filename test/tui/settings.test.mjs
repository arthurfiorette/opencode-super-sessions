import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { migrateV1, resolveThemeDocument } from '@opencode/theme/tui';
import { CliRenderEvents, InputRenderable } from '@opentui/core';
import { testRender } from '@opentui/solid';
import { jsx } from '@opentui/solid/jsx-runtime';
import { createSignal } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import themeSource from '../fixtures/theme-opencode.json';

const { parseOptions } = await import('../../dist/config.js');
const { installSettings } = await import('../../dist/settings/install.js');

test('the settings dialog loads cold and writes a server setting changed with right', async () => {
  const theme = resolveThemeDocument(migrateV1(themeSource), 'dark');
  const options = parseOptions({});
  // The server plugin's settings RPC, holding values like the real one: defaults plus overrides.
  const { serverDefaults } = await import('../../dist/server/settings.js');
  const defaults = serverDefaults(options);
  let values = { ...defaults };
  const writes = [];
  // Text prompts the dialog opened, and what the user types into the next ones.
  const prompts = [];
  const answers = [];
  const toasts = [];
  let renderer;
  let shown;
  const layers = [];
  const stores = new Map();
  const [route] = createSignal({ type: 'home' });
  const context = {
    options: {},
    location: { directory: '/repo' },
    theme,
    themeMode: 'dark',
    get renderer() {
      return renderer;
    },
    client: {
      rpc: () => ({
        events: { on: () => () => {} },
        'settings.get': async () => ({ values, defaults }),
        'settings.set': async (input) => {
          writes.push(input.values);
          values = { ...values, ...input.values };
          return { values, defaults };
        }
      })
    },
    data: {
      session: { root: (id) => id },
      location: { default: () => ({ directory: '/repo' }) }
    },
    keymap: {
      layer(factory) {
        layers.push(factory());
      },
      mode: { current: () => 'modal' }
    },
    storage: {
      store(name, store) {
        if (!stores.has(name)) {
          const [value, set] = createStore(structuredClone(store.initial));
          stores.set(name, [value, async (mutation) => set(produce(mutation))]);
        }
        return stores.get(name);
      }
    },
    ui: {
      dialog: {
        show(render) {
          shown = render;
        },
        clear() {},
        prompt: async (input) => {
          prompts.push(input);
          return answers.shift();
        }
      },
      router: { current: route },
      tabs: { list: () => [] },
      toast: {
        show(toast) {
          toasts.push(toast.message);
        }
      }
    }
  };
  const pins = { ids: () => [], has: () => false };
  const settings = installSettings(context, options, pins);
  settings.open();
  assert.ok(shown, 'Opening shows a host dialog.');
  const rendered = await testRender(() => jsx('box', { width: 60, children: shown() }), {
    width: 60,
    height: 40
  });
  renderer = rendered.renderer;
  /** Runs the dialog's `right` binding, as the host's keymap would on the key. */
  const right = () =>
    layers
      .flatMap((layer) => layer.commands)
      .find((command) => command.bind === 'right')
      .run();
  try {
    // Mounted cold: the view module loads only now.
    await import('../../dist/settings/dialog-view.js');
    await rendered.waitForFrame((frame) => frame.includes('Super Sessions settings'));
    // The dialog focuses its search field from a 1 ms timer, like the host's dialogs, and on
    // Windows that timer can fire after this point. waitForFrame gives up once nothing is
    // scheduled, so the keys would reach nothing.
    await focusOn(rendered.renderer, InputRenderable);

    await rendered.mockInput.typeText('merged');
    await rendered.waitForFrame(
      (frame) => frame.includes('Delete merged worktrees') && !frame.includes('Default scope')
    );
    right();
    await rendered.waitForFrame((frame) => /Delete merged worktrees\s+on/.test(frame));
    assert.deepEqual(writes, [{ cleanupMerged: true }]);

    // Groups show only once the Active view groups by group, right under that choice.
    const command = (id) =>
      layers.flatMap((layer) => layer.commands).find((item) => item.id === id);
    const search = rendered.renderer.currentFocusedRenderable;
    search.value = '';
    // Both rows carry the keyword, and "Group issues" does not.
    await rendered.mockInput.typeText('stage');
    await rendered.waitForFrame(
      (frame) => /Group Active sessions by\s+day/.test(frame) && !frame.includes('Group issues')
    );
    assert.doesNotMatch(rendered.captureCharFrame(), /Groups\s+none/);
    right();
    await rendered.waitForFrame((frame) =>
      /Group Active sessions by\s+group\s*\n.*Groups\s+none/.test(frame)
    );
    command('dialog.select.next').run();
    // Groups take a list, so enter opens a prompt and left/right leave them alone.
    right();
    answers.push('Pinned', 'Coding, Testing');
    command('dialog.select.submit').run();
    await until(() => prompts.length === 1);
    assert.deepEqual(writes, [{ cleanupMerged: true }]);
    assert.match(toasts.at(-1), /^Groups not saved: /);
    command('dialog.select.submit').run();
    await until(() => writes.length === 2);
    assert.deepEqual(writes[1], { groups: ['Coding', 'Testing'] });
    assert.equal(prompts[1].value, '');
  } finally {
    settings.dispose();
    rendered.renderer.destroy();
  }
});

/** Polls `ready` for at most two seconds. */
async function until(ready) {
  const deadline = Date.now() + 2000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Resolves once a `type` renderable has the focus, listening for the renderer's focus event. */
function focusOn(renderer, type) {
  return new Promise((resolve) => {
    const check = () => {
      if (!(renderer.currentFocusedRenderable instanceof type)) return false;
      renderer.off(CliRenderEvents.FOCUSED_RENDERABLE, check);
      resolve();
      return true;
    };
    if (!check()) renderer.on(CliRenderEvents.FOCUSED_RENDERABLE, check);
  });
}
