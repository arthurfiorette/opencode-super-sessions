import type { SessionInfo } from '@opencode/client';
import type { Plugin } from '@opencode/plugin/tui';
import type { KeymapCommand } from '@opencode/plugin/tui/context';
import { createComponent, createMemo, type JSX, lazy } from 'solid-js';
import { COMMAND_GROUP } from '../commands.js';
import type { Options } from '../config.js';
import { BASE_MODE, DIALOG_MODE } from '../host/keymap.js';
import type { Pins } from '../pins.js';
import type { SettingRow } from './definitions.js';
import { installMaintenance, type Maintenance } from './maintenance.js';
import {
  createServerSettings,
  createTuiSettings,
  type ServerSettingsClient,
  type TuiSettings
} from './store.js';

/** Everything the settings dialog view needs. */
export interface SettingsDialogProps {
  context: Plugin.Context;
  tui: TuiSettings;
  server: ServerSettingsClient;
  /** Row to select first, by key. */
  focus?: SettingRow['key'] | undefined;
  /** Asks for a custom archive suffix, then reopens the dialog on that row. */
  promptSuffix(): void;
  /** Dry run and confirmation, then reopens the dialog on the action row. */
  runCleanup(): void;
  /** Confirmation, then scans every session in the scope and reopens the dialog on its row. */
  scanAll(): void;
}

/** What "Scan all sessions now" needs from the browser and the history scanner. */
export interface ScanAll {
  /** Every session in the browser's current scope. */
  sessions(): Promise<{ scope: 'project' | 'all'; sessions: SessionInfo[] }>;
  scan(sessions: readonly SessionInfo[]): Promise<void>;
}

/** The settings dialog, its stores and the TUI half of auto-archive and cleanup. */
export interface SettingsInstall {
  /** Reactive TUI settings for the browser, the sidebar and the commands. */
  readonly tui: TuiSettings;
  readonly server: ServerSettingsClient;
  readonly maintenance: Maintenance;
  /** Opens the dialog over whatever is on screen. Synchronous, for keymap `run`. */
  open(focus?: SettingRow['key']): void;
  /** Palette entries: the dialog and the auto-archive undo. */
  readonly commands: KeymapCommand[];
  dispose(): void;
}

// Importing `./tui` from Node must not load OpenTUI, so the view loads when the dialog opens.
const View = lazy(() => import('./dialog-view.js'));

/** Creates the stores, starts maintenance and returns the dialog opener and its commands. */
export function installSettings(
  context: Plugin.Context,
  options: Options,
  pins: Pins,
  history: ScanAll
): SettingsInstall {
  const tui = createTuiSettings(context, options);
  const server = createServerSettings(context);
  // A confirmation would replace whatever dialog is open, and the browser overlay is not a host
  // dialog but pushes its own keymap mode; either way the base mode is gone.
  const busy = () => context.keymap.mode.current() !== BASE_MODE;
  const maintenance = installMaintenance(context, tui, pins, server, busy);

  const open = (focus?: SettingRow['key']) => {
    void server.load();
    context.ui.dialog.show(() =>
      lazyNode(View, {
        context,
        tui,
        server,
        focus,
        promptSuffix: () => void promptSuffix(),
        runCleanup: () => void maintenance.runCleanup().finally(() => open('cleanup.run')),
        scanAll: () => void scanAll().finally(() => open('history.scan'))
      })
    );
  };

  /** Lists the scope's sessions, asks once, then scans them in the background. */
  const scanAll = async () => {
    const toast = (message: string, variant: 'info' | 'error' = 'info') =>
      context.ui.toast.show({ message, variant });
    let listed: Awaited<ReturnType<ScanAll['sessions']>>;
    try {
      listed = await history.sessions();
    } catch {
      toast('Could not list sessions.', 'error');
      return;
    }
    const total = listed.sessions.length;
    if (total === 0) {
      toast('No sessions to scan.');
      return;
    }
    const where = listed.scope === 'all' ? 'all projects' : 'this project';
    const confirmed = await context.ui.dialog.confirm({
      title: 'Scan all sessions?',
      message: [
        `This reads the whole history of ${total === 1 ? '1 session' : `${total} sessions`} in ${where}, one session at a time, to find pull requests, issues and text for search.`,
        'Sessions scanned before are skipped. Progress shows in a notification.'
      ].join('\n\n'),
      label: { confirm: 'Scan' }
    });
    // Not awaited: the scan outlives the dialog, which reopens at once.
    if (confirmed) void history.scan(listed.sessions);
  };

  /** Prompts for a custom suffix; an empty answer keeps the current value. */
  const promptSuffix = async () => {
    const value = await context.ui.dialog.prompt({
      title: 'Archive on title suffix',
      description: 'Sessions whose title ends with this text are archived and the text removed.',
      placeholder: 'For example " !" or " [done]"',
      value: tui.archiveSuffix() ?? ''
    });
    // Leading spaces are part of the suffix (" !"), so only an all-blank answer counts as empty.
    if (value !== undefined && value.trim() !== '') {
      await tui
        .set('archiveSuffix', value.slice(0, 10))
        .catch(() =>
          context.ui.toast.show({ message: 'Could not save the setting.', variant: 'error' })
        );
    }
    open('archiveSuffix');
  };

  const commands: KeymapCommand[] = [
    {
      id: 'super-sessions.settings',
      title: 'Super Sessions settings',
      group: COMMAND_GROUP,
      palette: true,
      run: () => {
        if (context.keymap.mode.current() === DIALOG_MODE) context.ui.dialog.clear();
        open();
      }
    },
    {
      id: 'super-sessions.archive.undo',
      title: 'Undo auto-archive',
      group: COMMAND_GROUP,
      palette: true,
      enabled: () => maintenance.undoable(),
      run: () => void maintenance.undo()
    }
  ];

  return { tui, server, maintenance, open, commands, dispose: maintenance.dispose };
}

/** Renders a lazily loaded component, hiding Solid's empty-string placeholder while it loads. */
function lazyNode<Props extends object>(
  component: (props: Props) => JSX.Element,
  props: Props
): JSX.Element {
  const view = createComponent(component, props);
  return createMemo(() => {
    const node = typeof view === 'function' ? view() : view;
    // OpenTUI boxes cannot contain text nodes.
    return node === '' ? undefined : node;
  });
}
