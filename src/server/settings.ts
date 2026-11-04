import { isDeepStrictEqual } from 'node:util';
import type { Plugin } from '@opencode/plugin';
import type { Options } from '../config.js';
import type { ProviderId } from '../refs/ref.js';
import {
  type ProviderChoice,
  type ServerSettings,
  type ServerSettingsView,
  serverSettingsSchema
} from '../rpc.js';

/** The part of a plugin context that persists settings: the plugin's own key-value store. */
export type SettingsStorage = Pick<Plugin.Context['storage'], 'get' | 'set'>;

/** Server settings: plugin-option defaults with the dialog's overrides on top. */
export interface SettingsStore {
  /** Effective values. Synchronous so hot paths such as event handlers can read it. */
  current(): ServerSettings;
  view(): ServerSettingsView;
  /** Reads stored overrides once per process. Later calls return the first load. */
  load(storage: SettingsStorage): Promise<void>;
  /** Applies and persists overrides. Writes run one at a time in call order. */
  set(storage: SettingsStorage, patch: SettingsPatch): Promise<ServerSettingsView>;
  /** Calls `listener` with the previous and next values after every change. */
  onChange(listener: (next: ServerSettings, previous: ServerSettings) => void): () => void;
}

/** Settings to change. Undefined values are ignored, as RPC input may carry them. */
export type SettingsPatch = { [Key in keyof ServerSettings]?: ServerSettings[Key] | undefined };

// One key holds every override, so a write never leaves half of a change on disk.
const STORAGE_KEY = 'settings';

/** The setting values a plugin entry's options imply, before any dialog override. */
export function serverDefaults(options: Options): ServerSettings {
  return {
    autoArchiveDays: options.autoArchiveDays ?? null,
    trackMentions: options.detect.mentions,
    trackPrompts: options.detect.prompts,
    providers: providerChoice(options.providers),
    cleanupDeleted: options.cleanup.deletedSessions,
    cleanupMerged: options.cleanup.merged,
    cleanupInactiveDays: options.cleanup.inactiveDays ?? null,
    cleanupDoneDays: options.cleanup.doneDays ?? null,
    cleanupUnchanged: options.cleanup.unchanged
  };
}

/** Folds a provider list into the dialog's choice. */
function providerChoice(providers: readonly ProviderId[]): ProviderChoice {
  const github = providers.includes('github');
  const gitlab = providers.includes('gitlab');
  if (github && gitlab) return 'both';
  return gitlab ? 'gitlab' : 'github';
}

/** Expands the dialog's provider choice into the list the runtime builds providers from. */
export function providerList(choice: ProviderChoice): ProviderId[] {
  if (choice === 'both') return ['github', 'gitlab'];
  return [choice];
}

/** Options with the settings that replace option fields applied, for code that reads options. */
export function applySettings(options: Options, settings: ServerSettings): Options {
  return {
    ...options,
    providers: providerList(settings.providers),
    detect: { mentions: settings.trackMentions, prompts: settings.trackPrompts }
  };
}

/**
 * Creates the settings store for `defaults`. Stored overrides that no longer parse are dropped
 * one key at a time, so a schema change after an update loses only the changed key.
 */
export function createSettingsStore(
  defaults: ServerSettings,
  warn: (message: string, error?: unknown) => void
): SettingsStore {
  let overrides: Partial<ServerSettings> = {};
  let loading: Promise<void> | undefined;
  let writes: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(next: ServerSettings, previous: ServerSettings) => void>();

  const current = (): ServerSettings => ({ ...defaults, ...overrides });
  const view = (): ServerSettingsView => ({ values: current(), defaults: { ...defaults } });

  /** Replaces the overrides and tells listeners when the effective values changed. */
  const apply = (next: Partial<ServerSettings>) => {
    const previous = current();
    overrides = next;
    const values = current();
    if (isDeepStrictEqual(previous, values)) return;
    for (const listener of listeners) {
      try {
        listener(values, previous);
      } catch (error) {
        warn('Applying a settings change failed', error);
      }
    }
  };

  return {
    current,
    view,
    load(storage) {
      loading ??= storage
        .get(STORAGE_KEY)
        .then((stored) => apply(readOverrides(stored, defaults)))
        .catch((error: unknown) => warn('Reading saved settings failed; using defaults', error));
      return loading;
    },
    set(storage, patch) {
      const result = writes.then(async () => {
        await loading;
        const changes = Object.fromEntries(
          Object.entries(patch).filter(([, value]) => value !== undefined)
        ) as Partial<ServerSettings>;
        const next = withoutDefaults({ ...overrides, ...changes }, defaults);
        await storage.set(STORAGE_KEY, next);
        apply(next);
        return view();
      });
      writes = result.catch(() => {});
      return result;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

/** Parses each stored key on its own and drops invalid or default-valued ones. */
function readOverrides(stored: unknown, defaults: ServerSettings): Partial<ServerSettings> {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
  const shape = serverSettingsSchema.shape;
  const valid: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (!(key in shape)) continue;
    const parsed = shape[key as keyof typeof shape].safeParse(value);
    if (parsed.success) valid[key] = parsed.data;
  }
  return withoutDefaults(valid as Partial<ServerSettings>, defaults);
}

/**
 * Drops overrides equal to their default, so a later change of the plugin options reaches every
 * setting the user did not change away from it.
 */
function withoutDefaults(
  values: Partial<ServerSettings>,
  defaults: ServerSettings
): Partial<ServerSettings> {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([key, value]) => !isDeepStrictEqual(value, defaults[key as keyof ServerSettings])
    )
  ) as Partial<ServerSettings>;
}
