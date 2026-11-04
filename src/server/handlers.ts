import type { Plugin } from '@opencode/plugin';
import type { RpcHandlers } from '@opencode/plugin/promise/rpc';
import { refKey } from '../refs/ref.js';
import { dismissLink, mergeLinks, setDone } from '../refs/store.js';
import type { SuperSessions } from '../rpc.js';
import { linksOf, parseReference, resolveCandidates, resolveRepo } from './links.js';
import { pullDetailsHandler } from './pull-details.js';
import type { Runtime } from './runtime.js';
import type { SettingsPatch } from './settings.js';
import { maintenanceHandlers } from './sweep.js';
import { buildViews, searchSessions } from './views.js';

/** RPC handlers for one Location, backed by the shared runtime. */
export function rpcHandlers(
  runtime: Runtime,
  context: Plugin.Context
): RpcHandlers<typeof SuperSessions> {
  return {
    async status() {
      // Only each forge's public host is probed: the page shows one line per forge, and
      // self-managed hosts are rare.
      const entries = await Promise.all(
        [...runtime.providers].map(
          async ([id, provider]) =>
            [id, await provider.available(provider.definition.defaultHost)] as const
        )
      );
      return { providers: Object.fromEntries(entries) };
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
        return invocation.error('unavailable', `Could not check ${reference}.`, {
          reason,
          provider: candidate.provider
        });
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
    },

    async 'done.set'({ sessionID, done }) {
      await runtime.writes.update(context.session, sessionID, (refs) =>
        setDone(refs, done, Date.now())
      );
      return {};
    },

    'pull.details': pullDetailsHandler(runtime),

    ...settingsHandlers(runtime, context),
    ...maintenanceHandlers(runtime)
  };
}

/** `settings.get` and `settings.set`, persisted in the plugin's key-value storage. */
function settingsHandlers(runtime: Runtime, context: Plugin.Context) {
  return {
    async 'settings.get'() {
      await runtime.settings.load(context.storage);
      return runtime.settings.view();
    },
    'settings.set': ({ values }: { values: SettingsPatch }) =>
      runtime.settings.set(context.storage, values)
  };
}
