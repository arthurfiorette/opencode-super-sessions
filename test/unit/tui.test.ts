import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Plugin } from '@opencode/plugin/tui';
import type { KeymapLayer } from '@opencode/plugin/tui/context';
import plugin from '../../src/tui.js';

test('session.list falls through to the classic list with a literal false', async () => {
  const layers: KeymapLayer[] = [];
  const context = {
    app: { name: 'opencode', version: '2.2.5', channel: 'latest' },
    options: {},
    storage: {
      store: () => [{ imported: true, ids: [] }, async () => {}] as const,
      memory: () => [{}, () => {}] as const
    },
    // Settings and maintenance subscribe to server events and report open sessions from setup on.
    client: { rpc: () => ({ events: { on: () => () => {} } }) },
    data: {
      on: () => () => {},
      session: { list: () => [], root: (id: string) => id },
      location: { default: () => ({ directory: '/repo' }) }
    },
    keymap: {
      layer(factory: () => KeymapLayer) {
        layers.push(factory());
      },
      mode: { current: () => 'base' }
    },
    ui: {
      slot: () => () => {},
      router: { current: () => ({ type: 'home' }) },
      dialog: { clear() {} },
      toast: { show() {} },
      tabs: { enabled: () => false, list: () => [] }
    }
  };
  await plugin.setup(context as unknown as Plugin.Context);
  const command = layers
    .flatMap((layer) => layer.commands ?? [])
    .find((item) => item.id === 'session.list');
  // The host only falls through on a literal false; a Promise would count as handled.
  assert.equal(command?.run('classic'), false);
});
