import type { SessionInfo } from '@opencode/client';
import { Plugin } from '@opencode/plugin/tui';
import type { KeymapCommand } from '@opencode/plugin/tui/context';
import { z } from 'zod';
import { type Options, parseOptions } from './config.js';
import {
  CLASSIC_LIST,
  DIALOG_MODE,
  OVER_HOST,
  quickSwitchCommand,
  SESSION_LIST
} from './host/keymap.js';
import { setArchived } from './host/session-api.js';
import { installBrowser } from './page/page.js';
import { createPins, type Pins } from './pins.js';
import { type Availability, SuperSessions } from './rpc.js';
import { installSettings } from './settings/install.js';
import type { TuiSettings } from './settings/store.js';
import { installSidebar } from './sidebar.js';

const TITLE = 'Super Sessions';

const availability: Record<Availability, string> = {
  ok: 'ready',
  'missing-tool': 'gh not found. Install the GitHub CLI or set ghPath.',
  unauthenticated: 'gh is not logged in. Run gh auth login.'
};

/**
 * TUI plugin loaded by each OpenCode terminal client. It takes over the session list command,
 * installs the session browser overlay and the sidebar section, and adds the archive commands.
 */
export default Plugin.define({
  id: 'opencode-super-sessions.tui',
  setup(context) {
    let options: Options;
    try {
      options = parseOptions(context.options);
    } catch (error) {
      // Stay inert: a half-configured plugin that takes over the session list would be worse
      // than the built-in list.
      context.ui.toast.show({
        title: TITLE,
        message: `Plugin disabled: ${describeOptionsError(error)}`,
        variant: 'error'
      });
      return;
    }
    const pins = createPins(context);
    // Settings dialog, its stores, and the TUI half of auto-archive and cleanup. First, because
    // the browser and the sidebar read the stores through `tuiSettingsFor`.
    const settings = installSettings(context, options, pins);
    const browser = installBrowser(context, options, pins);
    const uninstallSidebar = installSidebar(context, options);

    // Must stay synchronous: the keymap only falls through to the built-in dialog when `run`
    // returns a literal `false`, and a Promise counts as handled.
    const toggleBrowser = () => {
      // The palette and other host dialogs would otherwise stay open above the browser. Only
      // when one is open: clearing also refocuses whatever the last dialog took focus from.
      if (context.keymap.mode.current() === DIALOG_MODE) context.ui.dialog.clear();
      browser.toggle();
    };

    const commands: KeymapCommand[] = [
      {
        id: SESSION_LIST,
        title: 'Switch session',
        group: 'Session',
        palette: true,
        slash: { name: 'sessions', aliases: ['resume', 'continue'] },
        run: (input) => (input?.trim() === CLASSIC_LIST ? false : toggleBrowser())
      },
      ...quickSwitch(context, pins),
      {
        id: 'super-sessions.classic',
        title: 'Classic session list',
        group: 'Session',
        palette: true,
        slash: { name: 'sessions-classic' },
        run: () => context.keymap.dispatch(SESSION_LIST, CLASSIC_LIST)
      },
      {
        id: 'super-sessions.archive.current',
        title: 'Archive session',
        group: 'Session',
        palette: true,
        slash: { name: 'archive' },
        run: () => setCurrentArchived(context, settings.tui, true)
      },
      {
        id: 'super-sessions.unarchive.current',
        title: 'Restore archived session',
        group: 'Session',
        palette: true,
        slash: { name: 'unarchive' },
        run: () => setCurrentArchived(context, settings.tui, false)
      },
      {
        id: 'super-sessions.status',
        title: 'Super Sessions status',
        group: 'Session',
        palette: true,
        // Takes an argument so `/super-sessions settings` reaches the dialog; plain
        // `/super-sessions` still shows the status.
        slash: { name: 'super-sessions', arguments: true },
        run: (input) => {
          const argument = input?.trim() ?? '';
          if (argument === 'settings') return settings.open();
          if (argument === 'undo') return void settings.maintenance.undo();
          if (argument === '' || argument === 'status') return showStatus(context);
          context.ui.toast.show({
            message: `Unknown argument "${argument}". Try /super-sessions settings or undo.`,
            variant: 'warning'
          });
        }
      },
      ...settings.commands
    ];
    // Priority 1 puts these IDs above the host's own commands, so the user's configured keys,
    // the slash names and the palette entries all reach this plugin first. The layer factory is
    // reactive, so the marked-archive entry follows the suffix setting.
    context.keymap.layer(() => {
      const suffix = settings.tui.archiveSuffix();
      return {
        mode: 'global',
        priority: OVER_HOST,
        commands: [
          ...commands,
          {
            id: 'super-sessions.archive.marked',
            title: suffix ? `Archive sessions ending in "${suffix}"` : 'Archive marked sessions',
            group: 'Session',
            palette: true,
            enabled: suffix !== undefined,
            slash: { name: 'archive-marked' },
            run: () => (suffix === undefined ? undefined : archiveMarked(context, suffix))
          }
        ]
      };
    });

    // Read at event time, so turning suffix archiving on or off in the dialog applies at once.
    const offRenamed = context.data.on('session.renamed', (event) => {
      const suffix = settings.tui.archiveSuffix();
      const title = event.data.title;
      if (suffix === undefined || !title.endsWith(suffix)) return;
      void archiveWithTitle(context, event.data.sessionID, stripSuffix(title, suffix));
    });

    return () => {
      offRenamed();
      settings.dispose();
      pins.dispose();
      browser.dispose();
      uninstallSidebar();
    };
  }
});

/** Names the first invalid option for the toast. */
function describeOptionsError(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    if (issue) return `${issue.path.join('.') || 'options'}: ${issue.message}`;
  }
  return 'invalid options.';
}

/** Quick switch commands that follow the plugin's pins instead of the host's. */
function quickSwitch(context: Plugin.Context, pins: Pins): KeymapCommand[] {
  return Array.from({ length: 9 }, (_, index) => ({
    id: quickSwitchCommand(index + 1),
    title: `Switch to pinned session ${index + 1}`,
    group: 'Session',
    // The host disables quick switch while tabs are on; tabs own those keys then.
    enabled: () => !context.ui.tabs.enabled(),
    run() {
      const target = pins.slots()[index];
      if (target === undefined) return;
      const route = context.ui.router.current();
      if (route.type === 'session' && route.sessionID === target) return;
      context.ui.router.navigate({ type: 'session', sessionID: target });
    }
  }));
}

/** Archives or restores the root of the session on screen. */
async function setCurrentArchived(
  context: Plugin.Context,
  settings: TuiSettings,
  archived: boolean
) {
  const route = context.ui.router.current();
  if (route.type !== 'session') {
    context.ui.toast.show({ message: 'Open a session first.', variant: 'warning' });
    return;
  }
  // A subagent view belongs to its root session; archiving the child alone would hide nothing.
  const sessionID = context.data.session.root(route.sessionID);
  try {
    await setArchived(context.client, sessionID, archived);
  } catch {
    context.ui.toast.show({
      message: archived ? 'Could not archive the session.' : 'Could not restore the session.',
      variant: 'error'
    });
    return;
  }
  context.ui.toast.show({
    message: archived ? 'Session archived' : 'Session restored',
    variant: 'success'
  });
  if (archived && settings.closeTabOnArchive()) context.ui.tabs.close(sessionID);
}

/** Shows forge availability from the server plugin. */
async function showStatus(context: Plugin.Context) {
  let message: string;
  try {
    const location = context.location ?? context.data.location.default();
    const status = await context.client.rpc(SuperSessions).status({}, { location });
    const lines = Object.entries(status.providers).map(
      ([provider, state]) =>
        `${provider === 'github' ? 'GitHub' : provider}: ${availability[state]}`
    );
    message = lines.length > 0 ? lines.join('\n') : 'No forge providers are enabled.';
  } catch {
    message = 'Status unavailable. Enable the opencode-super-sessions server plugin.';
  }
  await context.ui.dialog.alert({ title: TITLE, message });
}

/** Removes the archive suffix and any space left before it. */
function stripSuffix(title: string, suffix: string): string {
  return title.slice(0, title.length - suffix.length).trimEnd();
}

/** Archives a session and sets its title in one update, so the rename does not fire twice. */
async function archiveWithTitle(context: Plugin.Context, sessionID: string, title: string) {
  try {
    await setArchived(context.client, sessionID, true, title);
    context.ui.toast.show({ message: `Archived "${title}"`, variant: 'success' });
  } catch {
    context.ui.toast.show({ message: 'Could not archive the session.', variant: 'error' });
  }
}

/** Archives every root session whose title already ends with the suffix, after confirmation. */
async function archiveMarked(context: Plugin.Context, suffix: string) {
  let marked: SessionInfo[];
  try {
    marked = (await listAllRoots(context)).filter((session) => session.title?.endsWith(suffix));
  } catch {
    context.ui.toast.show({ message: 'Could not list sessions.', variant: 'error' });
    return;
  }
  if (marked.length === 0) {
    context.ui.toast.show({ message: `No sessions end in "${suffix}".` });
    return;
  }
  const confirmed = await context.ui.dialog.confirm({
    title: 'Archive marked sessions?',
    message: `Archive ${marked.length} ${marked.length === 1 ? 'session' : 'sessions'} and remove "${suffix}" from their titles.`,
    label: { confirm: 'Archive' }
  });
  if (!confirmed) return;
  let failed = 0;
  // One at a time: the daemon serializes session writes anyway, and a burst of parallel updates
  // only makes partial failures harder to read.
  for (const session of marked) {
    try {
      await setArchived(context.client, session.id, true, stripSuffix(session.title ?? '', suffix));
    } catch {
      failed++;
    }
  }
  context.ui.toast.show({
    message:
      failed === 0
        ? `Archived ${marked.length} ${marked.length === 1 ? 'session' : 'sessions'}`
        : `Archived ${marked.length - failed}, ${failed} failed`,
    variant: failed === 0 ? 'success' : 'warning'
  });
}

/** Every non-archived root session across all projects, following list cursors. */
async function listAllRoots(context: Plugin.Context): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await context.client.session.list({
      archived: false,
      parentID: null,
      limit: 200,
      order: 'desc',
      ...(cursor ? { cursor } : {})
    });
    sessions.push(...page.data);
    cursor = page.cursor.next ?? undefined;
  } while (cursor);
  return sessions;
}
