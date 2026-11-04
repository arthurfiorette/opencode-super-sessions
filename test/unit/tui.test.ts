import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Plugin } from '@opencode/plugin/tui';
import type { KeymapLayer } from '@opencode/plugin/tui/context';
import plugin from '../../src/tui.js';

test('session.list toggles the browser synchronously and falls through for the classic list', async () => {
  const layers: KeymapLayer[] = [];
  const context = {
    options: {},
    storage: {
      store: () => [{ imported: true, ids: [] }, async () => {}] as const,
      memory: () => [{}, () => {}] as const
    },
    data: { on: () => () => {}, session: { list: () => [] } },
    keymap: {
      layer(factory: () => KeymapLayer) {
        layers.push(factory());
      }
    },
    ui: {
      slot: () => () => {},
      router: { current: () => ({ type: 'home' }) },
      dialog: { clear() {} },
      toast: { show() {} },
      tabs: { enabled: () => false }
    }
  };
  await plugin.setup(context as unknown as Plugin.Context);
  const layer = layers.find((item) =>
    item.commands?.some((command) => command.id === 'session.list')
  );
  const command = layer?.commands?.find((item) => item.id === 'session.list');
  assert.ok(command, 'The plugin takes over session.list.');
  // Priority 1 in global mode is what lets the plugin win over the host's own session.list.
  assert.equal(layer?.mode, 'global');
  assert.equal(layer?.priority, 1);
  // The host only falls through on a literal false; a Promise would count as handled.
  assert.equal(command.run('classic'), false);
  assert.equal(command.run(), undefined);
});
