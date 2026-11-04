import { Plugin } from '@opencode/plugin';
import { type Options, parseOptions } from './config.js';
import { SuperSessions } from './rpc.js';
import { handleEvent, registerShellHook } from './server/detection.js';
import { rpcHandlers } from './server/handlers.js';
import { getRuntime, warn } from './server/runtime.js';
import { registerTools } from './server/tools.js';

/**
 * Server plugin loaded by the OpenCode daemon once per Location. Each Location registers its own
 * tools, shell hook and RPC handlers; providers, caches, the write queue and the event subscriber
 * are shared process-wide through the runtime.
 */
export default Plugin.define({
  id: 'opencode-super-sessions',
  async setup(context) {
    const options = readOptions(context.options);
    if (options === undefined) {
      await registerInert(context);
      return;
    }
    const runtime = getRuntime(options, handleEvent);
    await registerTools(runtime, context);
    await registerShellHook(runtime, context);
    await context.rpc.register(SuperSessions, rpcHandlers(runtime, context));
    // Attached last so a failed registration above never leaves a subscriber behind.
    return runtime.events.attach(context);
  }
});

/** Parses options, logging and returning undefined when they are invalid. */
function readOptions(input: unknown): Options | undefined {
  try {
    return parseOptions(input);
  } catch (error) {
    // A bad option must not crash the daemon or the other plugins it hosts.
    warn('Invalid plugin options; refs, tools and detection are disabled', error);
    return undefined;
  }
}

/** Registers handlers that report nothing, so the TUI degrades to title-only data. */
async function registerInert(context: Plugin.Context): Promise<void> {
  await context.rpc.register(SuperSessions, {
    status: async () => ({ providers: {} }),
    refs: async () => ({}),
    refresh: async () => ({}),
    search: async () => [],
    link: async (_input, invocation) =>
      invocation.error('unavailable', 'The plugin options are invalid.', { reason: 'failed' }),
    unlink: async () => ({})
  });
}
