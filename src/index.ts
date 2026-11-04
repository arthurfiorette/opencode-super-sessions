import { Plugin } from '@opencode/plugin';
import { SuperSessions } from './rpc.js';

/**
 * Server plugin loaded by the OpenCode daemon for each Location.
 */
export default Plugin.define({
  id: 'opencode-super-sessions',
  async setup(context) {
    // Inert handlers until the server wiring lands, so the TUI degrades to title-only data.
    await context.rpc.register(SuperSessions, {
      status: async () => ({ providers: {} }),
      refs: async () => ({}),
      refresh: async () => ({}),
      search: async () => [],
      link: async (_input, invocation) =>
        invocation.error('unavailable', 'Linking is not available yet.', { reason: 'failed' }),
      unlink: async () => ({})
    });
  }
});
