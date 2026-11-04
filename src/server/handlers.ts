import type { Plugin } from '@opencode/plugin';
import type { RpcHandlers } from '@opencode/plugin/promise/rpc';
import { refKey } from '../refs/ref.js';
import { dismissLink, mergeLinks } from '../refs/store.js';
import type { SuperSessions } from '../rpc.js';
import { linksOf, parseReference, resolveCandidates, resolveRepo } from './links.js';
import type { Runtime } from './runtime.js';
import { buildViews, searchSessions } from './views.js';

/** RPC handlers for one Location, backed by the shared runtime. */
export function rpcHandlers(
  runtime: Runtime,
  context: Plugin.Context
): RpcHandlers<typeof SuperSessions> {
  return {
    async status() {
      const provider = runtime.providers.get('github');
      if (provider === undefined) return { providers: {} };
      // Only github.com is probed: the page shows one status line, and GHES hosts are rare.
      return { providers: { github: await provider.available('github.com') } };
    },

    refs: ({ sessionIDs }) => buildViews(runtime, context.session, sessionIDs, { wait: false }),

    refresh: ({ sessionIDs, force }) =>
      buildViews(runtime, context.session, sessionIDs, { wait: true, force: force === true }),

    search: (input) => searchSessions(runtime, context.session, input),

    async link({ sessionID, reference }, invocation) {
      // Throws for an unknown session: there is nothing to link to, and no error type fits.
      const info = await context.session.get({ sessionID });
      const base = (await resolveRepo(runtime, info.location.directory)).repo;
      const candidate = parseReference(runtime.definitions, reference, base);
      if (candidate === undefined) {
        return invocation.error('invalid_reference', `Could not read ${reference}.`, {});
      }
      const [resolution] = await resolveCandidates(runtime, [candidate]);
      if (resolution?.status === 'not-found') {
        return invocation.error('not_found', `${reference} does not exist.`, {});
      }
      if (resolution?.status !== 'found') {
        const reason =
          resolution !== undefined && 'reason' in resolution ? resolution.reason : 'failed';
        return invocation.error('unavailable', `Could not check ${reference}.`, { reason });
      }
      const key = refKey(resolution.ref);
      // `manual` is explicit, so mergeLinks lifts an earlier dismissal of the key.
      const next = await runtime.writes.update(context.session, sessionID, (refs) =>
        mergeLinks(refs, linksOf([resolution.ref], 'manual'))
      );
      const link = next.links.find((stored) => refKey(stored.ref) === key);
      if (link === undefined) throw new Error(`Link for ${key} was not stored.`);
      return link;
    },

    async unlink({ sessionID, key }) {
      await runtime.writes.update(context.session, sessionID, (refs) => dismissLink(refs, key));
      return {};
    }
  };
}
