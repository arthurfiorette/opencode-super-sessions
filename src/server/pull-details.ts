import type { RpcHandlers } from '@opencode/plugin/promise/rpc';
import { createDetailsCache, type DetailsCache } from '../cache.js';
import { refKey } from '../refs/ref.js';
import type { SuperSessions } from '../rpc.js';
import { ensureRefs } from './links.js';
import type { Runtime } from './runtime.js';

type Handler = RpcHandlers<typeof SuperSessions>['pull.details'];

// One cache per runtime. A plugin loaded from a local path is one module per Location, so a
// second Location may fetch a pull request's details once more; nothing else depends on it.
const caches = new WeakMap<Runtime, DetailsCache>();

/**
 * The `pull.details` handler: one forge request for the selected pull request, cached with its
 * snapshot's lifetime. Hosts outside `runtime.hosts` are never asked, like snapshots. `force`
 * refetches the snapshot alongside the details.
 */
export function pullDetailsHandler(runtime: Runtime): Handler {
  return async ({ ref, force }, invocation) => {
    const provider = runtime.providers.get(ref.provider);
    if (ref.kind !== 'pr' || !provider || !runtime.hosts.allows(ref.provider, ref.host)) {
      return invocation.error('unavailable', 'This pull request cannot be asked about.', {
        reason: provider ? 'unknown-host' : 'missing-tool'
      });
    }
    let cache = caches.get(runtime);
    if (cache === undefined) {
      cache = createDetailsCache();
      caches.set(runtime, cache);
    }
    const key = refKey(ref);
    const snapshot = runtime.cache.get(key);
    const status = snapshot !== undefined && 'ref' in snapshot ? snapshot.state.status : undefined;
    const [answer] = await Promise.all([
      cache.get(key, status, () => provider.details(ref), { force: force === true }),
      force === true ? ensureRefs(runtime, [ref], { force: true }) : undefined
    ]);
    if ('reason' in answer) {
      return invocation.error('unavailable', 'The forge did not answer.', {
        reason: answer.reason
      });
    }
    const failure = force === true ? runtime.cache.failure(key) : undefined;
    if (failure !== undefined) {
      return invocation.error('unavailable', 'The forge did not answer.', {
        reason: failure.reason
      });
    }
    return answer;
  };
}
