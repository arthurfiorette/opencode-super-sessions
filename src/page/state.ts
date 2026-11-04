import type { SessionInfo } from '@opencode/client';
import { type ProviderId, type Ref, type RefState, refKey } from '../refs/ref.js';
import { rankSessions } from '../refs/search.js';
import { doneAt, isDone, trackedRefs } from '../refs/summary.js';
import type { SearchHit, SearchMatch, SessionRefView } from '../rpc.js';

export type PageView = 'active' | 'done' | 'archived' | 'pulls';
export type PageScope = 'project' | 'all';

/** Views in `tab` order. */
export const VIEWS: readonly PageView[] = ['active', 'done', 'archived', 'pulls'];

/**
 * Page state kept in `storage.memory`, so returning with `<leader>l` after a peek restores it.
 * The project scope is not here: it is a durable preference.
 */
export interface PageMemory {
  query: string;
  view: PageView;
  /**
   * The selected session. In the Pull requests view it is the selected pull request's newest
   * session, so peeking and the way back work as in the other views.
   */
  selected: string | undefined;
  /** `refKey` of the selected pull request in the Pull requests view. */
  pull?: string | undefined;
  /** First visible list line. */
  scroll: number;
}

/** A pull request in the Pull requests view and the sessions that track it, newest first. */
export interface PullRow {
  key: string;
  ref: Ref;
  state: RefState | undefined;
  sessions: SessionInfo[];
}

/** A day of the Pull requests view. */
export interface PullGroup {
  title: string;
  pulls: PullRow[];
}

/**
 * One row per pull request the given top-level sessions track (stored links and branch pull
 * requests, mentions left out), with its sessions newest first.
 */
export function pullRows(
  sessions: readonly SessionInfo[],
  refs: Readonly<Record<string, SessionRefView>>
): PullRow[] {
  const rows = new Map<string, PullRow>();
  for (const session of sessions) {
    const view = refs[session.id];
    if (session.parentID !== undefined || view === undefined) continue;
    for (const ref of trackedRefs(view)) {
      if (ref.kind !== 'pr') continue;
      const key = refKey(ref);
      const row = rows.get(key) ?? { key, ref, state: view.states[key], sessions: [] };
      row.state ??= view.states[key];
      row.sessions.push(session);
      rows.set(key, row);
    }
  }
  for (const row of rows.values()) row.sessions.sort((a, b) => b.time.updated - a.time.updated);
  return [...rows.values()];
}

/**
 * When a pull request last changed: its `updatedAt` on the forge, else its merge or close, else
 * the newest update of its sessions (states cached before `updatedAt` existed have none).
 */
export function pullUpdated(row: PullRow): number {
  return (
    row.state?.updatedAt ??
    row.state?.mergedAt ??
    row.state?.closedAt ??
    row.sessions[0]?.time.updated ??
    0
  );
}

/**
 * Pull requests whose title holds the query, or whose number it names (`12`, `#12`, `!12`). A
 * number matches only whole, like the session search.
 */
export function filterPulls(rows: readonly PullRow[], query: string): PullRow[] {
  const text = query.trim().toLowerCase();
  if (text === '') return [...rows];
  const number = /^[#!]?(\d+)$/.exec(text)?.[1];
  return rows.filter(
    (row) =>
      (number !== undefined && String(row.ref.number) === number) ||
      (row.state?.title.toLowerCase().includes(text) ?? false)
  );
}

/**
 * Groups pull requests by the day they last changed on the forge, newest day first. Within a
 * day, open and draft ones come first, then merged and closed ones, newest change first.
 */
export function groupPulls(rows: readonly PullRow[], now: number): PullGroup[] {
  const open = (row: PullRow) =>
    row.state?.status === 'merged' || row.state?.status === 'closed' ? 1 : 0;
  const sorted = [...rows].sort(
    (a, b) =>
      startOfDay(pullUpdated(b)) - startOfDay(pullUpdated(a)) ||
      open(a) - open(b) ||
      pullUpdated(b) - pullUpdated(a)
  );
  const today = new Date(now).toDateString();
  const groups: PullGroup[] = [];
  for (const row of sorted) {
    const date = new Date(pullUpdated(row)).toDateString();
    const title = date === today ? 'Today' : date;
    const last = groups.at(-1);
    if (last?.title === title) last.pulls.push(row);
    else groups.push({ title, pulls: [row] });
  }
  return groups;
}

/** Lays the Pull requests view out like the session list: one line per pull request. */
export function layoutPulls(groups: readonly PullGroup[]): Line[] {
  return groups.flatMap((group, index): Line[] => [
    ...(index > 0 ? [{ kind: 'blank' as const }] : []),
    { kind: 'header' as const, title: group.title },
    ...group.pulls.map((pull) => ({ kind: 'pull' as const, pull }))
  ]);
}

/** A titled run of sessions. */
export interface Group {
  title?: string;
  sessions: SessionInfo[];
}

/** Lines a session row can draw under its title, in this order. */
export type DetailKind = 'pr' | 'issues';

/** One terminal line of the session list. A session takes a `title` line and the others it needs. */
export type Line =
  | { kind: 'blank' }
  | { kind: 'header'; title: string }
  | { kind: 'title' | DetailKind; session: SessionInfo }
  /** The `index`th line (1 and up) of a title that wraps. */
  | { kind: 'wrap'; session: SessionInfo; index: number }
  /** A row of the Pull requests view. */
  | { kind: 'pull'; pull: PullRow };

/** What the Done rule needs beyond refs. Fetched only for sessions that could be Done. */
export interface DoneExtra {
  pending: boolean;
  lastUserMessageAt?: number | undefined;
}

/** Input of {@link groupSessions}. */
export interface GroupInput {
  view: PageView;
  /** Non-archived sessions for Active and Done, archived ones for Archived. */
  sessions: readonly SessionInfo[];
  refs: Readonly<Record<string, SessionRefView>>;
  extra: Readonly<Record<string, DoneExtra>>;
  running(sessionID: string): boolean;
  /** Plugin pins in pin order. */
  pins: readonly string[];
  now: number;
}

/**
 * Whether a session could be Done if nothing were pending and the user had not written since
 * the refs closed. Only these sessions pay for the pending and last-message lookups.
 */
export function doneCandidate(
  session: SessionInfo,
  refs: Readonly<Record<string, SessionRefView>>,
  running: boolean
): boolean {
  const view = refs[session.id];
  if (view === undefined) return false;
  return isDone({ running, pending: false, archived: session.time.archived !== undefined, view });
}

/**
 * Whether a session belongs in the Done view. A candidate whose lookups have not finished stays
 * in Active, so rows do not jump to Done and back while the page loads.
 */
export function sessionDone(
  session: SessionInfo,
  refs: Readonly<Record<string, SessionRefView>>,
  extra: Readonly<Record<string, DoneExtra>>,
  running: boolean
): boolean {
  const view = refs[session.id];
  const known = extra[session.id];
  if (view === undefined || known === undefined) return false;
  return isDone({
    running,
    pending: known.pending,
    archived: session.time.archived !== undefined,
    view,
    ...(known.lastUserMessageAt === undefined ? {} : { lastUserMessageAt: known.lastUserMessageAt })
  });
}

/**
 * Groups sessions for a view.
 *
 * - Active: Pinned in pin order, then Running, then one group per day of `time.updated`. Done
 *   sessions are left out, except pinned ones: a pin is an explicit choice to keep it in sight.
 * - Done: one group per day of the last merge or close.
 * - Archived: one group per day of `time.archived`, newest update first within a day.
 */
export function groupSessions(input: GroupInput): Group[] {
  const roots = input.sessions.filter((session) => session.parentID === undefined);
  const done = (session: SessionInfo) =>
    sessionDone(session, input.refs, input.extra, input.running(session.id));
  const byUpdated = (a: SessionInfo, b: SessionInfo) => b.time.updated - a.time.updated;
  if (input.view === 'archived') {
    const day = (session: SessionInfo) => startOfDay(session.time.archived ?? session.time.updated);
    const sorted = [...roots].sort((a, b) => day(b) - day(a) || byUpdated(a, b));
    return byDay(sorted, (session) => session.time.archived ?? session.time.updated, input.now);
  }
  if (input.view === 'done') {
    const at = (session: SessionInfo) => {
      const view = input.refs[session.id];
      return (view === undefined ? undefined : doneAt(view)) ?? session.time.updated;
    };
    const sorted = roots.filter(done).sort((a, b) => at(b) - at(a));
    return byDay(sorted, at, input.now);
  }
  const byID = new Map(roots.map((session) => [session.id, session]));
  const pinned = input.pins.flatMap((id) => byID.get(id) ?? []);
  const pinnedIDs = new Set(pinned.map((session) => session.id));
  const rest = roots.filter((session) => !pinnedIDs.has(session.id) && !done(session));
  const running = rest.filter((session) => input.running(session.id)).sort(byUpdated);
  const idle = rest.filter((session) => !input.running(session.id)).sort(byUpdated);
  return [
    ...(pinned.length > 0 ? [{ title: 'Pinned', sessions: pinned }] : []),
    ...(running.length > 0 ? [{ title: 'Running', sessions: running }] : []),
    ...byDay(idle, (session) => session.time.updated, input.now)
  ];
}

// Match tiers in the order a day group lists them.
const MATCH_TIER: Record<SearchMatch, number> = {
  title: 0,
  'ref-number': 1,
  'ref-title': 2,
  body: 3
};

/**
 * Groups search results like the Active list: Running first, then one group per day of
 * `time.updated`, with pins left in place. Within a group, title matches come first, then ref
 * numbers, ref titles and message hits, newest update first within a tier. Hits the server adds
 * later land in their day group by the same rule instead of after the local ones.
 */
export function groupSearch(
  sessions: readonly SessionInfo[],
  reasons: Readonly<Record<string, SearchReason>>,
  running: (sessionID: string) => boolean,
  now: number
): Group[] {
  const tier = (session: SessionInfo) => MATCH_TIER[reasons[session.id]?.match ?? 'body'];
  const ranked = (a: SessionInfo, b: SessionInfo) =>
    tier(a) - tier(b) || b.time.updated - a.time.updated;
  const active = sessions.filter((session) => running(session.id)).sort(ranked);
  const day = (session: SessionInfo) => startOfDay(session.time.updated);
  const idle = sessions
    .filter((session) => !running(session.id))
    .sort((a, b) => day(b) - day(a) || ranked(a, b));
  return [
    ...(active.length > 0 ? [{ title: 'Running', sessions: active }] : []),
    ...byDay(idle, (session) => session.time.updated, now)
  ];
}

/** Splits sessions, already in display order, into consecutive day groups. */
function byDay(sessions: SessionInfo[], time: (session: SessionInfo) => number, now: number) {
  const today = new Date(now).toDateString();
  const groups: Group[] = [];
  for (const session of sessions) {
    const date = new Date(time(session)).toDateString();
    const title = date === today ? 'Today' : date;
    const last = groups.at(-1);
    if (last?.title === title) last.sessions.push(session);
    else groups.push({ title, sessions: [session] });
  }
  return groups;
}

/** Local midnight of a timestamp, so sessions archived on the same day share a group. */
function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Sessions of all groups in display order. */
export function rowsOf(groups: readonly Group[]): SessionInfo[] {
  return groups.flatMap((group) => group.sessions);
}

/**
 * Lays groups out as terminal lines. Each row is its title, on `titleLines` lines, plus the
 * detail lines `details` names. Rows follow each other with no gap, and one blank line comes
 * before every group after the first, like the host's session list.
 */
export function layoutLines(
  groups: readonly Group[],
  details: (session: SessionInfo) => readonly DetailKind[],
  titleLines: (session: SessionInfo) => number = () => 1
): Line[] {
  return groups.flatMap((group, index): Line[] => [
    ...(index > 0 ? [{ kind: 'blank' as const }] : []),
    ...(group.title === undefined ? [] : [{ kind: 'header' as const, title: group.title }]),
    ...group.sessions.flatMap((session): Line[] => [
      { kind: 'title', session },
      ...Array.from({ length: Math.max(0, titleLines(session) - 1) }, (_, line) => ({
        kind: 'wrap' as const,
        session,
        index: line + 1
      })),
      ...details(session).map((kind) => ({ kind, session }))
    ])
  ]);
}

/** Moves the selection by `delta` rows, clamped to the list. */
export function moveSelection(
  rows: readonly SessionInfo[],
  selected: string | undefined,
  delta: number
): string | undefined {
  if (rows.length === 0) return undefined;
  const index = rows.findIndex((session) => session.id === selected);
  const from = index === -1 ? 0 : index;
  return rows[Math.min(rows.length - 1, Math.max(0, from + delta))]?.id;
}

/**
 * Keeps the selection when the list changes. When the selected row left the list (archived,
 * deleted, moved to Done), the row that took its index is selected, so archiving several
 * sessions in a row needs no cursor movement.
 */
export function keepSelection(
  previous: readonly SessionInfo[],
  next: readonly SessionInfo[],
  selected: string | undefined
): string | undefined {
  if (next.some((session) => session.id === selected)) return selected;
  const index = previous.findIndex((session) => session.id === selected);
  if (index === -1) return next[0]?.id;
  return next[Math.min(index, next.length - 1)]?.id;
}

/**
 * Returns the first visible line so every line of the selected row is on screen. When the row is
 * the first of its group, its header is kept in view too. `selected` is a session id, or a pull
 * request's key in the Pull requests view.
 */
export function scrollFor(
  lines: readonly Line[],
  selected: string | undefined,
  scroll: number,
  height: number
): number {
  const max = Math.max(0, lines.length - height);
  const at = lines.findIndex(
    (line) =>
      (line.kind === 'title' && line.session.id === selected) ||
      (line.kind === 'pull' && line.pull.key === selected)
  );
  if (at === -1 || height <= 0) return Math.min(Math.max(0, scroll), max);
  const top = lines[at - 1]?.kind === 'header' ? at - 1 : at;
  let end = at + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line === undefined || line.kind === 'blank' || line.kind === 'header') break;
    if (line.kind === 'title' || line.kind === 'pull' || line.session.id !== selected) break;
    end++;
  }
  let next = scroll;
  if (top < next) next = top;
  if (end > next + height) next = end - height;
  return Math.min(Math.max(0, next), max);
}

/** Ways the page reads and writes sessions. The view binds them to the plugin context. */
export interface PageDeps {
  list(input: { archived: boolean; scope: PageScope; search?: string }): Promise<SessionInfo[]>;
  get(sessionID: string): Promise<SessionInfo>;
  search(input: { query: string; archived: boolean; scope: PageScope }): Promise<SearchHit[]>;
  refs(sessionIDs: string[]): Promise<Record<string, SessionRefView>>;
  /** `force` refetches fresh entries too and reads the git checkouts again. */
  refresh(sessionIDs: string[], force?: boolean): Promise<Record<string, SessionRefView>>;
  running(sessionID: string): boolean;
  pending(sessionID: string): Promise<boolean>;
  lastUserMessageAt(sessionID: string): Promise<number | undefined>;
}

/** Why a session is in the search results. */
export interface SearchReason {
  match: SearchMatch;
  /** `refKey` of the ref that matched, for ref matches. */
  ref?: string | undefined;
}

/**
 * Result of the current search. `query` tells which input it answers. `searching` means the
 * server's answer has not arrived yet; `sessions` then holds the local matches.
 */
export interface SearchState {
  query: string;
  status: 'searching' | 'done' | 'error';
  sessions: SessionInfo[];
  /** Match reason by session id. */
  reasons: Record<string, SearchReason>;
}

/** Everything the controller loaded. */
export interface PageData {
  status: 'loading' | 'ready' | 'error';
  active: SessionInfo[];
  archived: SessionInfo[];
  refs: Record<string, SessionRefView>;
  extra: Record<string, DoneExtra>;
  search: SearchState | undefined;
}

export const SEARCH_DELAY = 150;
// The RPC accepts at most 200 ids per call.
const RPC_BATCH = 200;

/** Data before the first load. */
function initialData(): PageData {
  return { status: 'loading', active: [], archived: [], refs: {}, extra: {}, search: undefined };
}

/**
 * Ranks the loaded sessions for a query on the client: titles, ref numbers and cached ref titles,
 * with the same rules as the server. URLs and `owner/repo#N` need the forge definitions, so only
 * the server answers those.
 */
export function localSearch(
  query: string,
  sessions: readonly SessionInfo[],
  refs: Readonly<Record<string, SessionRefView>>
): SearchHit[] {
  return rankSessions({
    query,
    definitions: [],
    sessions: sessions
      .filter((session) => session.parentID === undefined)
      .map((session) => {
        const view = refs[session.id];
        const all = view ? [...view.branchRefs, ...view.links.map((link) => link.ref)] : [];
        return {
          id: session.id,
          title: session.title ?? '',
          updated: session.time.updated,
          refs: all.map((ref) => {
            const title = view?.states[refKey(ref)]?.title;
            return title === undefined ? { ref } : { ref, title };
          })
        };
      })
  });
}

/**
 * Local hits plus the server's other hits. A session both found keeps the local reason, so rows
 * do not move or relabel when the server answers; {@link groupSearch} decides the order.
 */
function mergeHits(local: readonly SearchHit[], remote: readonly SearchHit[]): SearchHit[] {
  const seen = new Set(local.map((hit) => hit.sessionID));
  return [...local, ...remote.filter((hit) => !seen.has(hit.sessionID))];
}

/** Match reasons by session id. */
function reasonsOf(hits: readonly SearchHit[]): Record<string, SearchReason> {
  return Object.fromEntries(
    hits.map((hit) => [
      hit.sessionID,
      hit.ref === undefined ? { match: hit.match } : { match: hit.match, ref: hit.ref }
    ])
  );
}

/**
 * Loads and keeps the browser's data. Plain TypeScript with a change callback, so it runs under
 * Node in unit tests and the caller decides how to make it reactive.
 */
export function createPageController(deps: PageDeps, changed: (data: PageData) => void) {
  let data = initialData();
  let disposed = false;
  let loadToken = 0;
  let searchToken = 0;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const extraRequested = new Set<string>();

  const publish = (update: Partial<PageData>) => {
    if (disposed) return;
    data = { ...data, ...update };
    changed(data);
  };

  /**
   * Fetches cached refs for every loaded session, then the Done lookups for candidates. A load
   * superseded while its refs were in flight drops them: they may be older than the newer
   * load's answer, and a reset in between means they belong to another scope.
   */
  const loadRefs = async (ids: string[], token: number) => {
    const batches = [];
    for (let start = 0; start < ids.length; start += RPC_BATCH) {
      batches.push(ids.slice(start, start + RPC_BATCH));
    }
    const results = await Promise.allSettled(batches.map((batch) => deps.refs(batch)));
    if (token !== loadToken) return;
    const refs = { ...data.refs };
    for (const result of results)
      if (result.status === 'fulfilled') Object.assign(refs, result.value);
    publish({ refs });
    await classify();
  };

  /** Runs the pending and last-message lookups for sessions that could be Done. */
  const classify = async () => {
    const candidates = data.active.filter(
      (session) =>
        !extraRequested.has(session.id) &&
        doneCandidate(session, data.refs, deps.running(session.id))
    );
    if (candidates.length === 0) return;
    for (const session of candidates) extraRequested.add(session.id);
    const found = await Promise.all(
      candidates.map(async (session) => {
        const [pending, lastUserMessageAt] = await Promise.all([
          deps.pending(session.id).catch(() => false),
          deps.lastUserMessageAt(session.id).catch(() => undefined)
        ]);
        return [session.id, { pending, lastUserMessageAt }] as const;
      })
    );
    publish({ extra: { ...data.extra, ...Object.fromEntries(found) } });
  };

  /**
   * Asks the server for the query and merges its hits after the local ones. Falls back to the
   * server's title search when the plugin's RPC does not answer.
   */
  const runSearch = async (
    query: string,
    archived: boolean,
    scope: PageScope,
    local: SearchHit[],
    token: number
  ) => {
    let remote: SearchHit[];
    try {
      remote = await deps.search({ query, archived, scope });
    } catch {
      // The server plugin may be missing or older; the built-in title search still works.
      try {
        const titled = await deps.list({ archived, scope, search: query });
        remote = titled.map((session) => ({ sessionID: session.id, match: 'title', score: 0 }));
      } catch {
        if (token === searchToken && data.search) {
          publish({ search: { ...data.search, status: 'error' } });
        }
        return;
      }
    }
    if (token !== searchToken) return;
    const hits = mergeHits(local, remote);
    const sessions = await sessionsFor(hits.map((hit) => hit.sessionID));
    if (token !== searchToken) return;
    publish({
      search: {
        query,
        status: 'done',
        sessions: sessions.filter((session) => session.parentID === undefined),
        reasons: reasonsOf(hits)
      }
    });
  };

  /** Resolves hit ids to sessions, fetching the ones outside the loaded lists. */
  const sessionsFor = async (ids: string[]) => {
    const known = new Map(
      [...data.active, ...data.archived].map((session) => [session.id, session])
    );
    const resolved = await Promise.all(
      ids.map((id) => known.get(id) ?? deps.get(id).catch(() => undefined))
    );
    return resolved.filter((session): session is SessionInfo => session !== undefined);
  };

  return {
    snapshot: () => data,

    /** Loads both session lists for a scope. Earlier loads still in flight are ignored. */
    async load(scope: PageScope): Promise<void> {
      const token = ++loadToken;
      try {
        const [active, archived] = await Promise.all([
          deps.list({ archived: false, scope }),
          deps.list({ archived: true, scope })
        ]);
        if (token !== loadToken) return;
        publish({ status: 'ready', active, archived });
        await loadRefs(
          [...active, ...archived].map((session) => session.id),
          token
        );
      } catch {
        if (token === loadToken) publish({ status: 'error' });
      }
    },

    /** Clears the lists and lookups, for a scope or project whose cache does not apply. */
    reset(): void {
      loadToken++;
      searchToken++;
      clearTimeout(searchTimer);
      extraRequested.clear();
      publish(initialData());
    },

    /**
     * Sets the search input. The loaded sessions are filtered at once; the server, which also
     * finds sessions outside the loaded lists and message text, is asked {@link SEARCH_DELAY} ms
     * after the last keystroke. An empty query clears the results.
     */
    search(query: string, archived: boolean, scope: PageScope): void {
      clearTimeout(searchTimer);
      const token = ++searchToken;
      const trimmed = query.trim();
      if (trimmed.length === 0) {
        publish({ search: undefined });
        return;
      }
      const local = localSearch(trimmed, archived ? data.archived : data.active, data.refs);
      const known = new Map(
        [...data.active, ...data.archived].map((session) => [session.id, session])
      );
      publish({
        search: {
          query: trimmed,
          status: 'searching',
          sessions: local.flatMap((hit) => known.get(hit.sessionID) ?? []),
          reasons: reasonsOf(local)
        }
      });
      searchTimer = setTimeout(
        () => void runSearch(trimmed, archived, scope, local, token),
        SEARCH_DELAY
      );
    },

    /** Asks the forge for fresh state of the given sessions, then reclassifies Done. */
    async refresh(ids: string[]): Promise<void> {
      if (ids.length === 0) return;
      try {
        const refs = await deps.refresh(ids.slice(0, RPC_BATCH));
        publish({ refs: { ...data.refs, ...refs } });
        await classify();
      } catch {
        // The server plugin is optional; rows keep their cached refs.
      }
    },

    /**
     * Refetches one session's refs, branch pull requests and git checkout, ignoring the caches
     * (a rate limit still holds). Resolves to the forges that failed; throws when the server
     * plugin did not answer for the session.
     */
    async reload(sessionID: string): Promise<ProviderId[]> {
      const { [sessionID]: found } = await deps.refresh([sessionID], true);
      if (found === undefined) throw new Error(`No refs came back for ${sessionID}.`);
      const { failed = [], ...view } = found;
      publish({ refs: { ...data.refs, [sessionID]: view } });
      await classify();
      return failed;
    },

    /** Drops the Done lookups of a session after it ran again. */
    invalidate(sessionID: string): void {
      extraRequested.delete(sessionID);
      const { [sessionID]: _extra, ...extra } = data.extra;
      publish({ extra });
    },

    /** Moves a session between the lists after the server accepted an archive or restore. */
    archived(sessionID: string, archived: boolean, now: number): void {
      const session = [...data.active, ...data.archived].find((item) => item.id === sessionID);
      if (session === undefined) return;
      const { archived: _archived, ...time } = session.time;
      const moved: SessionInfo = { ...session, time: archived ? { ...time, archived: now } : time };
      const active = data.active.filter((item) => item.id !== sessionID);
      const rest = data.archived.filter((item) => item.id !== sessionID);
      publish({
        active: archived ? active : [moved, ...active],
        archived: archived ? [moved, ...rest] : rest,
        search: data.search && {
          ...data.search,
          sessions: data.search.sessions.filter((item) => item.id !== sessionID)
        }
      });
    },

    /** Removes a deleted session everywhere. */
    removed(sessionID: string): void {
      const keep = (item: SessionInfo) => item.id !== sessionID;
      publish({
        active: data.active.filter(keep),
        archived: data.archived.filter(keep),
        search: data.search && { ...data.search, sessions: data.search.sessions.filter(keep) }
      });
    },

    dispose(): void {
      disposed = true;
      clearTimeout(searchTimer);
    }
  };
}

export type PageController = ReturnType<typeof createPageController>;
