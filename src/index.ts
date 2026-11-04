import { Plugin } from '@opencode/plugin';
import { type Options, parseOptions } from './config.js';
import { SuperSessions } from './rpc.js';
import { handleEvent, registerShellHook } from './server/detection.js';
import { rpcHandlers } from './server/handlers.js';
import { getRuntime, warn } from './server/runtime.js';
import { serverDefaults } from './server/settings.js';
import { getSweeper } from './server/sweep.js';
import { registerInstructions, registerTools } from './server/tools.js';

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
    // Before tools and hooks: detection reads the dialog's tracking settings.
    await runtime.settings.load(context.storage);
    await registerTools(runtime, context);
    await registerInstructions(runtime, context);
    await registerShellHook(runtime, context);
    const registration = await context.rpc.register(SuperSessions, rpcHandlers(runtime, context));
    // Attached last so a failed registration above never leaves a subscriber behind.
    const detach = runtime.events.attach(context);
    // After attach: the backfill borrows the live contexts the event hub tracks.
    runtime.backfill.start();
    const detachSweeper = getSweeper(runtime).attach(context, registration.events.emit);
    return () => {
      detachSweeper();
      detach();
    };
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
  const defaults = serverDefaults(parseOptions(undefined));
  await context.rpc.register(SuperSessions, {
    status: async () => ({ providers: {} }),
    refs: async () => ({}),
    refresh: async () => ({}),
    search: async () => [],
    link: async (_input, invocation) =>
      invocation.error('unavailable', 'The plugin options are invalid.', { reason: 'failed' }),
    unlink: async () => ({}),
    // Fails, so the browser says the mark did not stick instead of showing no change.
    'done.set': async () => {
      throw new Error('The plugin options are invalid.');
    },
    // Defaults only, and nothing is stored: changing settings would suggest they apply.
    'settings.get': async () => ({ values: defaults, defaults }),
    'settings.set': async () => ({ values: defaults, defaults }),
    presence: async () => ({}),
    // Skipped, so the TUI stops paging a history nothing would read.
    'history.scan': async () => ({ skipped: true }),
    'archive.claim': async () => ({ sessions: [] }),
    'archive.report': async () => ({}),
    'archive.exclude': async () => ({}),
    'cleanup.plan': async () => ({ confirmed: false, worktrees: [] }),
    'cleanup.run': async ({ directories }) => ({
      removed: [],
      kept: directories.map((directory) => ({
        directory,
        reason: 'the plugin options are invalid'
      }))
    })
  });
}
