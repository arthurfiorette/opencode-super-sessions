import { Rpc } from '@opencode/plugin/rpc';
import { z } from 'zod';

/**
 * RPC contract between the TUI and the server plugin. Kept free of OpenTUI imports so
 * any client can call it.
 */
export const SuperSessions = Rpc.define({
  id: 'opencode-super-sessions',
  methods: {
    status: {
      input: z.strictObject({}),
      output: z.strictObject({})
    }
  },
  events: {}
});
