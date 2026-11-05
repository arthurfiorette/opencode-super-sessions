import type { Plugin } from '@opencode/plugin';
import type { BranchPull } from '../providers/provider.js';
import {
  type ProviderId,
  type Ref,
  type RefLink,
  type RefState,
  readSessionRefs,
  refKey,
  type SessionRefs
} from '../refs/ref.js';
import { rankSessions, type SearchSession } from '../refs/search.js';
import type { RepoInfo } from '../repo.js';
import type { SearchHit, SearchScope, SessionRefView } from '../rpc.js';
import { type BranchTarget, sessionBranchPulls } from './branches.js';
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
async function readSession(session: Pick<SessionAccess, 'get'>, sessionID: string) {
  return session.get({ sessionID }).catch((): SessionInfo | undefined => undefined);
}

/** A session's branch pull requests: all of the checkout's, and those that count for it. */
interface BranchRefs {
  /** The checkout's pull requests the user did not dismiss, whichever session opened them. */
  checkout: Ref[];
  /** The ones that came out of this session (see {@link sessionBranchPulls}). */
  own: Ref[];
  /**
   * Keys of checkout pull requests that do not count for the session and that it does not link
   * on its own. `closes` links recorded through them are hidden.
   */
  foreign: Set<string>;
}

/** Splits a branch lookup into the pull requests that count for the session and the others. */
function branchRefsOf(
  refs: SessionRefs,
  created: number,
  target: BranchTarget | undefined,
  pulls: readonly BranchPull[] | undefined
): BranchRefs {
  if (target === undefined || pulls === undefined) {
    return { checkout: [], own: [], foreign: new Set() };
  }
  const dismissed = new Set(refs.dismissed);
  const kept = pulls.filter((pull) => !dismissed.has(refKey(pull.ref)));
  const own = sessionBranchPulls(kept, target.branch, { created, pushed: refs.pushed ?? [] });
  const counted = new Set([
    ...own.map(refKey),
    ...refs.links.filter((link) => link.source !== 'mention').map((link) => refKey(link.ref))
  ]);
  const checkout = kept.map((pull) => pull.ref);
  return {
    checkout,
    own,
    foreign: new Set(checkout.map(refKey).filter((key) => !counted.has(key)))
  };
}

/**
 * Links a view shows: not dismissed, and no `closes` link recorded through a branch pull request
 * that does not count for the session. Those stay stored, so they come back if the session
 * pushes to the branch, and links of every other source are never hidden here.
 */
function visibleLinks(refs: SessionRefs, foreign: ReadonlySet<string>): RefLink[] {
  const dismissed = new Set(refs.dismissed);
  return refs.links.filter(
    (link) =>
      !dismissed.has(refKey(link.ref)) &&
      !(link.source === 'closes' && link.via !== undefined && foreign.has(link.via))
  );
}

/**
 * A session's view, and the same view with every branch pull request of its checkout. Worktree
 * cleanup decides per checkout, so it reads `checkout`, which includes pull requests other
 * sessions opened on the branch.
 */
export interface SessionViews {
  view: SessionRefView;
  checkout: SessionRefView;
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
  const built = await collectViews(runtime, session, sessionIDs, mode);
  return Object.fromEntries(Object.entries(built).map(([id, entry]) => [id, entry.view]));
}

/** {@link buildViews}, plus the checkout view worktree cleanup reads. */
export async function collectViews(
  runtime: Runtime,
  session: SessionAccess,
  sessionIDs: string[],
  mode: ViewMode
): Promise<Record<string, SessionViews>> {
  const force = mode.wait && mode.force === true;
  const loaded = await Promise.all(
    [...new Set(sessionIDs)].map(async (id) => {
      const info = await readSession(session, id);
      if (info === undefined) return undefined;
      const repo = await resolveRepo(runtime, info.location.directory, { force });
      return {
        id,
        created: info.time.created,
        refs: readSessionRefs(info.metadata),
        repo,
        target: branchTarget(repo)
      };
    })
  );
  const sessions = loaded.filter((entry) => entry !== undefined);

  const stale = new Set<string>();
  const withBranches = await Promise.all(
    sessions.map(async (entry) => {
      const provider = entry.repo.repo && runtime.providers.get(entry.repo.repo.provider);
      if (entry.target === undefined || !provider) {
        return { ...entry, branches: branchRefsOf(entry.refs, entry.created, undefined, []) };
      }
      const found = mode.wait
        ? await runtime.branches.ensure(provider, entry.target, { force })
        : runtime.branches.get(entry.target);
      if (!mode.wait && runtime.branches.stale(entry.target)) stale.add(entry.id);
      return { ...entry, branches: branchRefsOf(entry.refs, entry.created, entry.target, found) };
    })
  );

  if (mode.wait) {
    // The checkout's pull requests include the session's own, and cleanup reads their states.
    const refs = withBranches.flatMap((entry) => [
      ...entry.refs.links.map((link) => link.ref),
      ...entry.branches.checkout
    ]);
    await ensureRefs(runtime, uniqueRefs(refs), { force });
  }

  const views: Record<string, SessionViews> = {};
  const targets = new Map<string, BranchTarget | undefined>();
  const added: Ref[] = [];
  for (const entry of withBranches) {
    targets.set(entry.id, entry.target);
    // Only the session's own branch pull requests record `closes` links.
    const refs = await syncCloses(runtime, session, entry.id, entry.refs, entry.branches.own).catch(
      (error: unknown) => {
        warn(`Recording closed issues for ${entry.id} failed`, error);
        return entry.refs;
      }
    );
    if (refs !== entry.refs) added.push(...refs.links.map((link) => link.ref));
    const view: SessionRefView = {
      links: visibleLinks(refs, entry.branches.foreign),
      ...(entry.repo.branch === undefined ? {} : { branch: entry.repo.branch }),
      ...(entry.repo.defaultBranch === undefined
        ? {}
        : { defaultBranch: entry.repo.defaultBranch }),
      branchRefs: entry.branches.own,
      states: {},
      ...(refs.done === undefined ? {} : { done: refs.done }),
      ...(refs.doneAt === undefined ? {} : { doneAt: refs.doneAt })
    };
    views[entry.id] = { view, checkout: { ...view, branchRefs: entry.branches.checkout } };
  }
  // Issues recorded just now from `closes` have no snapshot yet; only the missing ones are fetched.
  if (mode.wait && added.length > 0) await ensureRefs(runtime, uniqueRefs(added));

  for (const [id, { view, checkout }] of Object.entries(views)) {
    const keys = uniqueRefs([...view.links.map((link) => link.ref), ...view.branchRefs]).map(
      refKey
    );
    view.states = statesOf(runtime, keys);
    checkout.states = statesOf(runtime, [
      ...new Set([...keys, ...checkout.branchRefs.map(refKey)])
    ]);
    if (!mode.wait && runtime.cache.stale(keys).length > 0) stale.add(id);
    if (force) {
      const failed = failedForges(runtime, targets.get(id), [
        ...view.links.map((link) => link.ref),
        ...view.branchRefs
      ]);
      if (failed.length > 0) view.failed = failed;
    }
  }

  if (stale.size > 0) refreshInBackground(runtime, session, [...stale]);
  return views;
}

/** Drops repeated refs, keeping the first of each key. */
function uniqueRefs(refs: Ref[]): Ref[] {
  return [...new Map(refs.map((ref) => [refKey(ref), ref])).values()];
}

/** Forges whose last answer for the branch lookup or one of the refs was an error. */
function failedForges(
  runtime: Runtime,
  target: BranchTarget | undefined,
  refs: Ref[]
): ProviderId[] {
  const failed = new Set<ProviderId>();
  if (target !== undefined && runtime.branches.failure(target)) failed.add(target.repo.provider);
  for (const ref of refs) {
    if (runtime.cache.failure(refKey(ref))) failed.add(ref.provider);
  }
  return [...failed];
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

type SearchInput = {
  query: string;
  scope: SearchScope;
  archived: boolean;
  limit?: number | undefined;
};

/**
 * Searches top-level sessions by title (the server's own search), ref number, cached ref title
 * and finally message text. Ref matches only cover the 200 most recently updated sessions in
 * scope.
 */
export async function searchSessions(
  runtime: Runtime,
  session: Pick<Plugin.Context['session'], 'list' | 'get'>,
  input: SearchInput
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
      const pulls = target === undefined ? undefined : runtime.branches.get(target);
      const branches = branchRefsOf(refs, info.time.created, target, pulls);
      const links = visibleLinks(refs, branches.foreign);
      return {
        id: info.id,
        title: info.title ?? '',
        updated: info.time.updated,
        refs: uniqueRefs([...links.map((link) => link.ref), ...branches.own]).map((ref) => {
          const snapshot = runtime.cache.get(refKey(ref));
          return snapshot !== undefined && 'ref' in snapshot
            ? { ref, title: snapshot.state.title }
            : { ref };
        })
      };
    })
  );

  const ranked = rankSessions({
    query: input.query,
    definitions: runtime.definitions,
    sessions: candidates,
    titleHits: titled.data.map((info) => info.id)
  });
  const body = await bodyHits(runtime, session, input, infos.keys(), ranked);
  return [...ranked, ...body].slice(0, input.limit ?? 50);
}

// Sessions read from the message index per search, and how many of them may need a
// `session.get` because they are not among the listed candidates (children, older sessions).
const BODY_HITS = 200;
const BODY_LOOKUPS = 50;

/**
 * Message text matches below every other tier, newest message first. Hits in a subagent's
 * session count for its top-level session, since the page lists only those.
 */
async function bodyHits(
  runtime: Runtime,
  session: Pick<Plugin.Context['session'], 'get'>,
  input: SearchInput,
  listed: Iterable<string>,
  ranked: SearchHit[]
): Promise<SearchHit[]> {
  const found = (await runtime.bodyIndex()).search(input.query, { limit: BODY_HITS });
  // Listed sessions passed the server's scope and archive filters already.
  const accepted = new Set(listed);
  const rejected = new Set<string>();
  let lookups = 0;

  /** The in-scope top-level session a hit belongs to, reading unlisted ones within the budget. */
  const resolve = async (start: string): Promise<string | undefined> => {
    let id = start;
    while (!accepted.has(id)) {
      if (rejected.has(id) || lookups >= BODY_LOOKUPS) return undefined;
      lookups++;
      const info = await readSession(session, id);
      if (info?.parentID !== undefined) {
        id = info.parentID;
        continue;
      }
      if (info === undefined || !inScope(info, input)) {
        rejected.add(id);
        return undefined;
      }
      accepted.add(id);
    }
    return id;
  };

  const seen = new Set(ranked.map((hit) => hit.sessionID));
  const hits: SearchHit[] = [];
  for (const { sessionID } of found) {
    const id = await resolve(sessionID);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    hits.push({ sessionID: id, match: 'body', score: 0 });
  }
  return hits;
}

/** Whether a top-level session read outside `session.list` matches the search filters. */
function inScope(info: SessionInfo, input: SearchInput): boolean {
  if ((info.time.archived !== undefined) !== input.archived) return false;
  const scope = input.scope;
  if (scope.type === 'directory') return info.location.directory === scope.directory;
  if (scope.type === 'project') {
    return (
      info.projectID === scope.project &&
      (scope.subpath === '' || (info.subpath ?? '') === scope.subpath)
    );
  }
  return true;
}
