import { Plugin } from '@opencode/plugin';
import { SuperSessions } from './rpc.js';

/**
 * Server plugin loaded by the OpenCode daemon for each Location.
 */
export default Plugin.define({
  id: 'opencode-super-sessions',
  async setup(context) {
    await context.rpc.register(SuperSessions, {
      status: async () => ({ providers: {} })
    });
  }
});
