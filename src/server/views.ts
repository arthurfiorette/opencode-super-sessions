import type { Plugin } from '@opencode/plugin';
import { type Ref, type RefState, readSessionRefs, refKey } from '../refs/ref.js';
import { rankSessions, type SearchSession } from '../refs/search.js';
import type { RepoInfo } from '../repo.js';
import type { SearchHit, SearchScope, SessionRefView } from '../rpc.js';
import type { BranchTarget } from './branches.js';
import { ensureRefs, resolveRepo, syncCloses } from './links.js';
import type { SessionAccess } from './queue.js';
import { type Runtime, warn } from './runtime.js';

/** How {@link buildViews} treats the forge. */
export interface ViewMode {
  /** Wait for missing or expired branch lookups and snapshots instead of refreshing them later. */
  wait: boolean;
  /** Refetch everything, even fresh entries. Only meaningful with `wait`. */
  force?: boolean;
}

type SessionInfo = Awaited<ReturnType<Plugin.Context['session']['get']>>;

/**
 * The branch lookup a checkout warrants, if any. The default branch, a detached HEAD and a branch
 * never pushed would all match unrelated pull requests, so they get none.
 */
function branchTarget(info: RepoInfo): BranchTarget | undefined {
  if (info.repo === undefined || info.branch === undefined || !info.upstream) return undefined;
  if (info.branch === info.defaultBranch) return undefined;
  return info.headRepo === undefined
    ? { repo: info.repo, branch: info.branch }
    : { repo: info.repo, branch: info.branch, headRepo: info.headRepo };
}

/** Reads a session, or undefined when it does not exist or cannot be read. */
async function readSession(session: SessionAccess, sessionID: string) {
  return session.get({ sessionID }).catch((): SessionInfo | undefined => undefined);
}

/**
 * Builds the TUI's view of each existing session. Unknown ids are left out. Without `wait`
 * nothing here calls the forge: cached data is returned and stale sessions refresh in the
 * background, so the page reads them on its next call.
 */
export async function buildViews(
  runtime: Runtime,
  session: SessionAccess,
  sessionIDs: string[],
  mode: ViewMode
): Promise<Record<string, SessionRefView>> {
  const loaded = await Promise.all(
    [...new Set(sessionIDs)].map(async (id) => {
      const info = await readSession(session, id);
      if (info === undefined) return undefined;
      const repo = await resolveRepo(runtime, info.location.directory);
      return { id, refs: readSessionRefs(info.metadata), repo, target: branchTarget(repo) };
    })
  );
  const sessions = loaded.filter((entry) => entry !== undefined);

  const force = mode.wait && mode.force === true;
  const stale = new Set<string>();
  const withBranches = await Promise.all(
    sessions.map(async (entry) => {
      const provider = entry.repo.repo && runtime.providers.get(entry.repo.repo.provider);
      if (entry.target === undefined || !provider) return { ...entry, branchRefs: [] as Ref[] };
      const found = mode.wait
        ? await runtime.branches.ensure(provider, entry.target, { force })
        : runtime.branches.get(entry.target);
      if (!mode.wait && runtime.branches.stale(entry.target)) stale.add(entry.id);
      const dismissed = new Set(entry.refs.dismissed);
      const branchRefs = (found ?? []).filter((ref) => !dismissed.has(refKey(ref)));
      return { ...entry, branchRefs };
    })
  );

  if (mode.wait) {
    await ensureRefs(runtime, uniqueRefs(withBranches.flatMap(trackedRefsOf)), { force });
  }

  const views: Record<string, SessionRefView> = {};
  const added: Ref[] = [];
  for (const entry of withBranches) {
    const refs = await syncCloses(runtime, session, entry.id, entry.refs, entry.branchRefs).catch(
      (error: unknown) => {
        warn(`Recording closed issues for ${entry.id} failed`, error);
        return entry.refs;
      }
    );
    if (refs !== entry.refs) added.push(...refs.links.map((link) => link.ref));
    const dismissed = new Set(refs.dismissed);
    views[entry.id] = {
      links: refs.links.filter((link) => !dismissed.has(refKey(link.ref))),
      ...(entry.repo.branch === undefined ? {} : { branch: entry.repo.branch }),
      ...(entry.repo.defaultBranch === undefined
        ? {}
        : { defaultBranch: entry.repo.defaultBranch }),
      branchRefs: entry.branchRefs,
      states: {}
    };
  }
  // Issues recorded just now from `closes` have no snapshot yet; only the missing ones are fetched.
  if (mode.wait && added.length > 0) await ensureRefs(runtime, uniqueRefs(added));

  for (const [id, view] of Object.entries(views)) {
    const keys = uniqueRefs([...view.links.map((link) => link.ref), ...view.branchRefs]).map(
      refKey
    );
    view.states = statesOf(runtime, keys);
    if (!mode.wait && runtime.cache.stale(keys).length > 0) stale.add(id);
  }

  if (stale.size > 0) refreshInBackground(runtime, session, [...stale]);
  return views;
}

/** Every ref a session view shows, stored or derived from its branch. */
function trackedRefsOf(entry: { refs: { links: Array<{ ref: Ref }> }; branchRefs: Ref[] }): Ref[] {
  return [...entry.refs.links.map((link) => link.ref), ...entry.branchRefs];
}

/** Drops repeated refs, keeping the first of each key. */
function uniqueRefs(refs: Ref[]): Ref[] {
  return [...new Map(refs.map((ref) => [refKey(ref), ref])).values()];
}

/** Cached states for keys whose last answer was a state rather than an error. */
function statesOf(runtime: Runtime, keys: string[]): Record<string, RefState> {
  const states: Record<string, RefState> = {};
  for (const key of keys) {
    const snapshot = runtime.cache.get(key);
    if (snapshot !== undefined && 'ref' in snapshot) states[key] = snapshot.state;
  }
  return states;
}

/**
 * Refreshes sessions without blocking the caller. Sessions already refreshing are skipped, so a
 * page that polls `refs` faster than GitHub answers does not stack requests.
 */
export function refreshInBackground(
  runtime: Runtime,
  session: SessionAccess,
  sessionIDs: string[],
  force = false
): void {
  const ids = sessionIDs.filter((id) => !runtime.refreshing.has(id));
  if (ids.length === 0) return;
  for (const id of ids) runtime.refreshing.add(id);
  buildViews(runtime, session, ids, { wait: true, force })
    .catch((error: unknown) => warn('Refreshing session refs failed', error))
    .finally(() => {
      for (const id of ids) runtime.refreshing.delete(id);
    });
}

/** Maps the RPC scope onto `session.list` filters. An empty project subpath means the whole project. */
function listScope(scope: SearchScope): { directory?: string; project?: string; subpath?: string } {
  if (scope.type === 'directory') return { directory: scope.directory };
  if (scope.type === 'project') {
    return scope.subpath === ''
      ? { project: scope.project }
      : { project: scope.project, subpath: scope.subpath };
  }
  return {};
}

/**
 * Searches top-level sessions by title (the server's own search), ref number and cached ref
 * title. Ref matches only cover the 200 most recently updated sessions in scope.
 */
export async function searchSessions(
  runtime: Runtime,
  session: Pick<Plugin.Context['session'], 'list'>,
  input: { query: string; scope: SearchScope; archived: boolean; limit?: number | undefined }
): Promise<SearchHit[]> {
  const filters = { ...listScope(input.scope), archived: input.archived, parentID: null };
  const [titled, recent] = await Promise.all([
    session.list({ ...filters, search: input.query, limit: 50, order: 'desc' }),
    session.list({ ...filters, limit: 200, order: 'desc' })
  ]);
  const infos = new Map([...recent.data, ...titled.data].map((info) => [info.id, info]));

  const candidates = await Promise.all(
    [...infos.values()].map(async (info): Promise<SearchSession> => {
      const refs = readSessionRefs(info.metadata);
      const target = branchTarget(await resolveRepo(runtime, info.location.directory));
      const branchRefs = target === undefined ? [] : (runtime.branches.get(target) ?? []);
      const dismissed = new Set(refs.dismissed);
      return {
        id: info.id,
        title: info.title ?? '',
        updated: info.time.updated,
        refs: uniqueRefs([...refs.links.map((link) => link.ref), ...branchRefs])
          .filter((ref) => !dismissed.has(refKey(ref)))
          .map((ref) => {
            const snapshot = runtime.cache.get(refKey(ref));
            return snapshot !== undefined && 'ref' in snapshot
              ? { ref, title: snapshot.state.title }
              : { ref };
          })
      };
    })
  );

  return rankSessions({
    query: input.query,
    definitions: runtime.definitions,
    sessions: candidates,
    titleHits: titled.data.map((info) => info.id)
  }).slice(0, input.limit ?? 50);
}
