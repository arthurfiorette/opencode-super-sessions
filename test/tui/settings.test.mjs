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
        clear() {}
      },
      router: { current: route },
      tabs: { list: () => [] },
      toast: { show() {} }
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
  } finally {
    settings.dispose();
    rendered.renderer.destroy();
  }
});

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
