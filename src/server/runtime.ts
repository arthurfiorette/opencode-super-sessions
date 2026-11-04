import { isDeepStrictEqual } from 'node:util';
import { createSnapshotCache, type SnapshotCache } from '../cache.js';
import type { Options } from '../config.js';
import { createPendingForms, isFormEvent, type PendingForms } from '../host/forms.js';
import { github } from '../providers/github/definition.js';
import { createGitHubProvider } from '../providers/github/provider.js';
import { createGitLabDefinition } from '../providers/gitlab/definition.js';
import { createGitLabProvider } from '../providers/gitlab/provider.js';
import type { ForgeDefinition, ForgeProvider } from '../providers/provider.js';
import { definitions } from '../providers/registry.js';
import { type ProviderId, refKey } from '../refs/ref.js';
import { createRepoResolver, type RepoResolver } from '../repo.js';
import { type Backfill, createBackfill } from './backfill.js';
import { type BodyIndex, bodyIndexPath, disabledIndex, openBodyIndex } from './body-index.js';
import { type BranchCache, createBranchCache } from './branches.js';
import {
  createEventHub,
  type EventContext,
  type EventHub,
  type HandledEvent,
  isHandledEvent,
  type LifecycleEvent
} from './events.js';
import { createWriteQueue, type WriteQueue } from './queue.js';
import {
  applySettings,
  createSettingsStore,
  type SettingsStore,
  serverDefaults
} from './settings.js';

/** State shared by every Location of the daemon. */
export interface Runtime {
  /** Options of the first Location that loaded the plugin. */
  readonly options: Options;
  /** Definitions of the enabled forges that have a runtime provider. */
  readonly definitions: ForgeDefinition[];
  readonly providers: ReadonlyMap<ProviderId, ForgeProvider>;
  readonly cache: SnapshotCache;
  readonly repos: RepoResolver;
  readonly writes: WriteQueue;
  readonly branches: BranchCache;
  readonly events: EventHub;
  /** Questions waiting on the user, which keep a session's worktree like a pending permission. */
  readonly forms: PendingForms;
  /** Sessions with a background refresh running, so repeated `refs` calls do not stack them. */
  readonly refreshing: Set<string>;
  /** The message search index, opened on first use. Disabled when `search.body` is off. */
  readonly bodyIndex: () => Promise<BodyIndex>;
  readonly backfill: Backfill;
  /** Dialog settings layered over the options; `options` reflects them. */
  readonly settings: SettingsStore;
  /**
   * Set by the sweeper (auto-archive and cleanup): called when a cached ref turns merged and on
   * the lifecycle events it reacts to.
   */
  onMerged?: () => void;
  onLifecycle?: (event: LifecycleEvent, context: EventContext) => void;
}

/** Handles one subscribed event. Set by the server entry, which owns the detection logic. */
export type EventHandler = (
  runtime: Runtime,
  event: HandledEvent,
  context: EventContext
) => Promise<void>;

interface Shared {
  runtime: Runtime;
  configuration: Options;
}

// The daemon loads the plugin module once per Location and module state is not shared between
// them, so the runtime hangs off a process-wide symbol like opencode-zero-trust's manager.
const key = Symbol.for('opencode-super-sessions');
const shared = globalThis as typeof globalThis & { [key]?: Shared };
const warned = new Set<string>();

/** Writes a warning to the daemon log, prefixed with the plugin id. */
export function warn(message: string, error?: unknown): void {
  const detail =
    error === undefined ? '' : `: ${error instanceof Error ? error.message : String(error)}`;
  console.warn(`[opencode-super-sessions] ${message}${detail}`);
}

/** Like {@link warn}, once per process for each message. */
export function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  warn(message);
}

/**
 * Returns the process-wide runtime, creating it on first use. The first Location's options win:
 * providers, caches and the event subscriber are shared, so a second configuration cannot apply
 * without a daemon restart.
 */
export function getRuntime(options: Options, handle: EventHandler): Runtime {
  const existing = shared[key];
  if (existing !== undefined) {
    if (!isDeepStrictEqual(existing.configuration, options)) {
      warnOnce(
        'Another Location passed different options. The first options stay in effect until the daemon restarts.'
      );
    }
    return existing.runtime;
  }
  const runtime = createRuntime(options, handle);
  shared[key] = { runtime, configuration: options };
  return runtime;
}

/** Runtime provider for each forge, built from the options that configure it. */
const providerFactories: Record<ProviderId, (options: Options) => ForgeProvider> = {
  github: (options) => createGitHubProvider({ definition: github, ghPath: options.ghPath }),
  gitlab: (options) =>
    createGitLabProvider({
      definition: createGitLabDefinition({ hosts: options.gitlab.hosts }),
      glabPath: options.glabPath
    })
};

/** Providers, their definitions and the repo resolver that recognizes their remotes. */
interface ForgeState {
  providers: Map<ProviderId, ForgeProvider>;
  definitions: ForgeDefinition[];
  repos: RepoResolver;
}

/** Builds the enabled forges from `options.providers`. */
function createForges(options: Options): ForgeState {
  const providers = new Map<ProviderId, ForgeProvider>();
  // Registry order, so the first forge to claim an ambiguous reference does not depend on how
  // the user listed them.
  for (const { id } of definitions) {
    if (options.providers.includes(id)) providers.set(id, providerFactories[id](options));
  }
  const enabled = [...providers.values()].map((provider) => provider.definition);
  return { providers, definitions: enabled, repos: createRepoResolver({ definitions: enabled }) };
}

/** Builds the providers, caches, queue and subscriber for `options`. */
function createRuntime(base: Options, handle: EventHandler): Runtime {
  // Settings from the dialog override some options. `options`, the providers and the resolver
  // are getters so a change applies to the next read without a daemon restart.
  const settings = createSettingsStore(serverDefaults(base), warn);
  let options = applySettings(base, settings.current());
  let forges = createForges(options);
  settings.onChange((next, previous) => {
    options = applySettings(base, next);
    if (next.providers !== previous.providers) forges = createForges(options);
  });
  const cache = watchMerges(createSnapshotCache(), () => runtime.onMerged?.());
  let bodyIndex: Promise<BodyIndex> | undefined;

  const runtime: Runtime = {
    get options() {
      return options;
    },
    get definitions() {
      return forges.definitions;
    },
    get providers() {
      return forges.providers;
    },
    get repos() {
      return forges.repos;
    },
    settings,
    cache,
    writes: createWriteQueue(),
    branches: createBranchCache({
      isOpen(ref) {
        const snapshot = cache.get(refKey(ref));
        return (
          snapshot === undefined || !('ref' in snapshot) || isOpenStatus(snapshot.state.status)
        );
      }
    }),
    forms: createPendingForms(),
    events: createEventHub({
      async handle(event, context) {
        if (isFormEvent(event)) {
          runtime.forms.apply(event);
          return;
        }
        // Deletions reach both: the message index forgets them and cleanup records the worktree.
        if (event.type === 'session.deleted' || !isHandledEvent(event)) {
          runtime.onLifecycle?.(event, context);
        }
        if (isHandledEvent(event)) await handle(runtime, event, context);
      },
      onError: (error) => warn('Handling a session event failed', error)
    }),
    refreshing: new Set(),
    bodyIndex: () => {
      bodyIndex ??= options.search.body
        ? openBodyIndex(bodyIndexPath(), warn)
        : Promise.resolve(disabledIndex);
      return bodyIndex;
    },
    backfill: createBackfill({
      index: () => runtime.bodyIndex(),
      context: () => runtime.events.current(),
      warn
    })
  };
  return runtime;
}

/**
 * Wraps `ensure` to call `merged` when a fetch finds a ref merged that the cache did not know as
 * merged before, so cleanup of merged worktrees runs soon after the merge instead of at the next
 * timed sweep.
 */
function watchMerges(cache: SnapshotCache, merged: () => void): SnapshotCache {
  return {
    ...cache,
    async ensure(provider, candidates, options) {
      const result = await cache.ensure(provider, candidates, options);
      const fresh = [...result].filter(
        ([key, value]) => 'ref' in value && value.state.status === 'merged' && !knownMerged.has(key)
      );
      if (fresh.length === 0) return result;
      for (const [key] of fresh) knownMerged.add(key);
      merged();
      return result;
    }
  };
}

// Keys seen merged at least once in this process. Merged is final, so the set only grows.
const knownMerged = new Set<string>();

/** Whether a status can still change on its own, so lookups that found it recheck sooner. */
function isOpenStatus(status: string): boolean {
  return status === 'open' || status === 'draft';
}
