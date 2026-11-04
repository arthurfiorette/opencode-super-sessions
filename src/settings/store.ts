import type { Plugin } from '@opencode/plugin/tui';
import { createSignal } from 'solid-js';
import type { Options } from '../config.js';
import { isUntested } from '../host/compat.js';
import { type ServerSettings, type ServerSettingsView, SuperSessions } from '../rpc.js';
import { readTuiOverrides, type TuiValues, tuiDefaults } from './definitions.js';

/**
 * TUI settings with reactive accessors. Each accessor reads the plugin's synced storage, so a
 * change in the settings dialog, or in another TUI, reaches every reader on its next run.
 */
export interface TuiSettings {
  /** Effective values: options defaults with the dialog's overrides. Reactive. */
  values(): TuiValues;
  readonly defaults: TuiValues;
  /** Overrides one value. A value equal to its default drops the override. */
  set<Key extends keyof TuiValues>(key: Key, value: TuiValues[Key]): Promise<void>;
  /** Default browser scope. */
  scope(): TuiValues['scope'];
  refLine(): boolean;
  /** Whether a row joins its issues on one line instead of one line each. */
  groupIssues(): boolean;
  /** Whether hovered titles scroll, given the host's `animations` value for `auto`. */
  titleScroll(animations: boolean): boolean;
  previewPane(): boolean;
  /** The preview's fraction of the browser width. */
  previewWidth(): number;
  closeTabOnArchive(): boolean;
  /** Title suffix that archives a session, or undefined when off. */
  archiveSuffix(): string | undefined;
  /**
   * Whether the takeover and the peek keys stay off on this host: it is newer than the tested
   * version by minor or major, and the user has not chosen to use the plugin there anyway.
   */
  hostGuarded(version: string): boolean;
}

interface Stored {
  values: Record<string, unknown>;
}

// Keyed by the plugin context, so views that receive only the context (the browser page) can
// read the settings with an import instead of a new prop.
const byContext = new WeakMap<Plugin.Context, TuiSettings>();

/**
 * The settings created for this plugin context. `src/tui.ts` creates them before installing the
 * browser and the sidebar, so a miss is a setup-order bug and throws.
 */
export function tuiSettingsFor(context: Plugin.Context): TuiSettings {
  const settings = byContext.get(context);
  if (settings === undefined) throw new Error('Super Sessions settings read before setup');
  return settings;
}

/** Creates the TUI settings store on the plugin's durable storage. */
export function createTuiSettings(context: Plugin.Context, options: Options): TuiSettings {
  const settings = buildTuiSettings(context, options);
  byContext.set(context, settings);
  return settings;
}

/** Builds the store and its accessors. */
function buildTuiSettings(context: Plugin.Context, options: Options): TuiSettings {
  const defaults = tuiDefaults(options);
  const [stored, update] = context.storage.store<Stored>('settings', { initial: { values: {} } });
  // Parsed on every read so a value written by another plugin version cannot break a reader.
  const values = (): TuiValues => ({ ...defaults, ...readTuiOverrides(stored.values) });
  return {
    values,
    defaults,
    set: (key, value) =>
      update((draft) => {
        if (value === defaults[key]) delete draft.values[key];
        else draft.values[key] = value;
      }),
    scope: () => values().scope,
    refLine: () => values().refLine,
    groupIssues: () => values().groupIssues,
    titleScroll(animations) {
      const mode = values().titleScroll;
      return mode === 'auto' ? animations : mode === 'on';
    },
    previewPane: () => values().previewPane,
    previewWidth: () => values().previewWidth,
    closeTabOnArchive: () => values().closeTabOnArchive,
    archiveSuffix: () => values().archiveSuffix ?? undefined,
    hostGuarded: (version) => isUntested(version) && !values().untestedHosts
  };
}

/** The server's settings as the TUI sees them. */
export interface ServerSettingsClient {
  /** Last values the server returned, or undefined before the first answer. Reactive. */
  view(): ServerSettingsView | undefined;
  /** Error message of the last failed call. Reactive. */
  error(): string | undefined;
  load(): Promise<void>;
  set<Key extends keyof ServerSettings>(key: Key, value: ServerSettings[Key]): Promise<void>;
}

/** Reads and writes server settings over RPC, through the TUI's own Location. */
export function createServerSettings(context: Plugin.Context): ServerSettingsClient {
  const [view, setView] = createSignal<ServerSettingsView>();
  const [error, setError] = createSignal<string>();
  const rpc = () => context.client.rpc(SuperSessions);
  const location = () => ({ location: context.location ?? context.data.location.default() });
  /** Runs one call, keeping its view or its error. */
  const call = async (request: () => Promise<ServerSettingsView>) => {
    try {
      setView(await request());
      setError(undefined);
    } catch {
      setError(
        'Server settings are unavailable. Enable the opencode-super-sessions server plugin.'
      );
    }
  };
  return {
    view,
    error,
    load: () => call(() => rpc()['settings.get']({}, location())),
    set: (key, value) => call(() => rpc()['settings.set']({ values: { [key]: value } }, location()))
  };
}
