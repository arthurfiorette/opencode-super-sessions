import { isDeepStrictEqual } from 'node:util';
import { createSnapshotCache, type SnapshotCache } from '../cache.js';
import type { Options } from '../config.js';
import { createGitHubProvider } from '../providers/github/provider.js';
import type { ForgeDefinition, ForgeProvider } from '../providers/provider.js';
import { definitions } from '../providers/registry.js';
import { type ProviderId, refKey } from '../refs/ref.js';
import { createRepoResolver, type RepoResolver } from '../repo.js';
import { type BranchCache, createBranchCache } from './branches.js';
import { createEventHub, type EventContext, type EventHub, type HandledEvent } from './events.js';
import { createWriteQueue, type WriteQueue } from './queue.js';

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
  /** Sessions with a background refresh running, so repeated `refs` calls do not stack them. */
  readonly refreshing: Set<string>;
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

/** Builds the providers, caches, queue and subscriber for `options`. */
function createRuntime(options: Options, handle: EventHandler): Runtime {
  const providers = new Map<ProviderId, ForgeProvider>();
  for (const id of options.providers) {
    const definition = definitions.find((candidate) => candidate.id === id);
    if (id !== 'github' || definition === undefined) {
      warnOnce(`The ${id} provider is not available yet and is ignored.`);
      continue;
    }
    providers.set(id, createGitHubProvider({ definition, ghPath: options.ghPath }));
  }
  const enabled = [...providers.values()].map((provider) => provider.definition);
  const cache = createSnapshotCache();

  const runtime: Runtime = {
    options,
    definitions: enabled,
    providers,
    cache,
    repos: createRepoResolver({ definitions: enabled }),
    writes: createWriteQueue(),
    branches: createBranchCache({
      isOpen(ref) {
        const snapshot = cache.get(refKey(ref));
        return (
          snapshot === undefined || !('ref' in snapshot) || isOpenStatus(snapshot.state.status)
        );
      }
    }),
    events: createEventHub({
      handle: (event, context) => handle(runtime, event, context),
      onError: (error) => warn('Handling a session event failed', error)
    }),
    refreshing: new Set()
  };
  return runtime;
}

/** Whether a status can still change on its own, so lookups that found it recheck sooner. */
function isOpenStatus(status: string): boolean {
  return status === 'open' || status === 'draft';
}
