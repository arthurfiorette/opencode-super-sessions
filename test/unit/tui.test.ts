import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Plugin } from '@opencode/plugin/tui';
import type { Destination, KeymapLayer, Route } from '@opencode/plugin/tui/context';
import plugin from '../../src/tui.js';

/** Sets the plugin up against a host that records layers and navigation. */
async function host(current: Route) {
  const layers: KeymapLayer[] = [];
  const navigations: Destination[] = [];
  const context = {
    options: {},
    storage: {
      store: () => [{ imported: true, ids: [] }, async () => {}] as const
    },
    data: { on: () => () => {}, session: { list: () => [] } },
    keymap: {
      layer(factory: () => KeymapLayer) {
        layers.push(factory());
      }
    },
    ui: {
      router: {
        register: () => () => {},
        navigate: (destination: Destination) => navigations.push(destination),
        current: () => current
      },
      dialog: { clear() {} },
      toast: { show() {} },
      tabs: { enabled: () => false }
    }
  };
  await plugin.setup(context as unknown as Plugin.Context);
  const command = layers
    .flatMap((layer) => layer.commands ?? [])
    .find((item) => item.id === 'session.list');
  assert.ok(command, 'The plugin takes over session.list.');
  return { command, layers, navigations };
}

test('session.list opens the page synchronously and falls through for the classic list', async () => {
  const from: Route = { type: 'session', sessionID: 'ses_1' };
  const terminal = await host(from);
  const layer = terminal.layers.find((item) => item.commands?.includes(terminal.command));
  // Priority 1 in global mode is what lets the plugin win over the host's own session.list.
  assert.equal(layer?.mode, 'global');
  assert.equal(layer?.priority, 1);

  // The host only falls through on a literal false; a Promise would count as handled.
  assert.equal(terminal.command.run('classic'), false);
  assert.deepEqual(terminal.navigations, []);

  assert.equal(terminal.command.run(), undefined);
  assert.deepEqual(terminal.navigations, [
    {
      type: 'plugin',
      name: 'sessions',
      data: { returnRoute: { type: 'session', sessionID: 'ses_1' } }
    }
  ]);
  const target = terminal.navigations[0] as unknown as { data: { returnRoute: Route } };
  assert.notEqual(
    target.data.returnRoute,
    from,
    'The return route is a copy of the live router store.'
  );
});

test('session.list does nothing when the page is already open', async () => {
  const terminal = await host({
    type: 'plugin',
    id: 'opencode-super-sessions.tui',
    name: 'sessions'
  });
  assert.equal(terminal.command.run(), undefined);
  assert.deepEqual(terminal.navigations, []);
});
