import type { SessionInfo } from '@opencode/client';
import { doneAt, isDone } from '../refs/summary.js';
import type { SearchHit, SessionRefView } from '../rpc.js';

export type PageView = 'active' | 'done' | 'archived';
export type PageScope = 'project' | 'all';

/** Views in `tab` order. */
export const VIEWS: readonly PageView[] = ['active', 'done', 'archived'];

/** Page state kept in `storage.memory`, so returning with `<leader>l` after a peek restores it. */
export interface PageMemory {
  query: string;
  view: PageView;
  scope: PageScope;
  selected: string | undefined;
  /** First visible list line. */
  scroll: number;
}

/** A titled run of sessions. Search results use one group without a title. */
export interface Group {
  title?: string;
  sessions: SessionInfo[];
}

/** One terminal line of the session list. Each session takes a `title` and a `detail` line. */
export type Line =
  | { kind: 'blank' }
  | { kind: 'header'; title: string }
  | { kind: 'title' | 'detail'; session: SessionInfo };

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

/** Lays groups out as terminal lines: a blank line between groups, a header, two lines per row. */
export function layoutLines(groups: readonly Group[]): Line[] {
  return groups.flatMap((group, index): Line[] => [
    ...(index > 0 ? [{ kind: 'blank' as const }] : []),
    ...(group.title === undefined ? [] : [{ kind: 'header' as const, title: group.title }]),
    ...group.sessions.flatMap((session): Line[] => [
      { kind: 'title', session },
      { kind: 'detail', session }
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
 * Returns the first visible line so the selected row's two lines are on screen. When the row is
 * the first of its group, its header is kept in view too.
 */
export function scrollFor(
  lines: readonly Line[],
  selected: string | undefined,
  scroll: number,
  height: number
): number {
  const max = Math.max(0, lines.length - height);
  const at = lines.findIndex((line) => line.kind === 'title' && line.session.id === selected);
  if (at === -1 || height <= 0) return Math.min(Math.max(0, scroll), max);
  const top = lines[at - 1]?.kind === 'header' ? at - 1 : at;
  let next = scroll;
  if (top < next) next = top;
  if (at + 2 > next + height) next = at + 2 - height;
  return Math.min(Math.max(0, next), max);
}

/** Ways the page reads and writes sessions. The view binds them to the plugin context. */
export interface PageDeps {
  list(input: { archived: boolean; scope: PageScope; search?: string }): Promise<SessionInfo[]>;
  get(sessionID: string): Promise<SessionInfo>;
  search(input: { query: string; archived: boolean; scope: PageScope }): Promise<SearchHit[]>;
  refs(sessionIDs: string[]): Promise<Record<string, SessionRefView>>;
  refresh(sessionIDs: string[]): Promise<Record<string, SessionRefView>>;
  running(sessionID: string): boolean;
  pending(sessionID: string): Promise<boolean>;
  lastUserMessageAt(sessionID: string): Promise<number | undefined>;
  lastAssistantText(sessionID: string): Promise<string | undefined>;
}

/** Result of the current search. `query` tells which input it answers. */
export interface SearchState {
  query: string;
  status: 'searching' | 'done' | 'error';
  sessions: SessionInfo[];
}

/** Everything the controller loaded. */
export interface PageData {
  status: 'loading' | 'ready' | 'error';
  active: SessionInfo[];
  archived: SessionInfo[];
  refs: Record<string, SessionRefView>;
  extra: Record<string, DoneExtra>;
  /** First line of the last assistant text, by session. Empty string when there is none. */
  last: Record<string, string>;
  search: SearchState | undefined;
}

export const SEARCH_DELAY = 150;
// The RPC accepts at most 200 ids per call.
const RPC_BATCH = 200;

/**
 * Loads and keeps the page's data. Plain TypeScript with a change callback, so it runs under
 * Node in unit tests and the view decides how to make it reactive.
 */
export function createPageController(deps: PageDeps, changed: (data: PageData) => void) {
  let data: PageData = {
    status: 'loading',
    active: [],
    archived: [],
    refs: {},
    extra: {},
    last: {},
    search: undefined
  };
  let disposed = false;
  let loadToken = 0;
  let searchToken = 0;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const lastRequested = new Set<string>();
  const extraRequested = new Set<string>();

  const publish = (update: Partial<PageData>) => {
    if (disposed) return;
    data = { ...data, ...update };
    changed(data);
  };

  /** Fetches cached refs for every loaded session, then the Done lookups for candidates. */
  const loadRefs = async (ids: string[]) => {
    const batches = [];
    for (let start = 0; start < ids.length; start += RPC_BATCH) {
      batches.push(ids.slice(start, start + RPC_BATCH));
    }
    const results = await Promise.allSettled(batches.map((batch) => deps.refs(batch)));
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

  /** Runs the search for the current input. Falls back to the server's title search. */
  const runSearch = async (query: string, archived: boolean, scope: PageScope) => {
    const token = ++searchToken;
    let sessions: SessionInfo[];
    try {
      const hits = await deps.search({ query, archived, scope });
      sessions = await sessionsFor(hits.map((hit) => hit.sessionID));
    } catch {
      // The server plugin may be missing or older; the built-in title search still works.
      try {
        sessions = await deps.list({ archived, scope, search: query });
      } catch {
        if (token === searchToken) publish({ search: { query, status: 'error', sessions: [] } });
        return;
      }
    }
    if (token !== searchToken) return;
    publish({
      search: {
        query,
        status: 'done',
        sessions: sessions.filter((session) => session.parentID === undefined)
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
        await loadRefs([...active, ...archived].map((session) => session.id));
      } catch {
        if (token === loadToken) publish({ status: 'error' });
      }
    },

    /**
     * Sets the search input. Searching waits {@link SEARCH_DELAY} ms after the last keystroke;
     * an empty query clears the results at once.
     */
    search(query: string, archived: boolean, scope: PageScope): void {
      clearTimeout(searchTimer);
      const trimmed = query.trim();
      if (trimmed.length === 0) {
        searchToken++;
        publish({ search: undefined });
        return;
      }
      publish({
        search: { query: trimmed, status: 'searching', sessions: data.search?.sessions ?? [] }
      });
      searchTimer = setTimeout(() => void runSearch(trimmed, archived, scope), SEARCH_DELAY);
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

    /** Loads the last assistant line for rows that need it and have not asked yet. */
    async requestLast(ids: string[]): Promise<void> {
      const missing = ids.filter((id) => !lastRequested.has(id));
      if (missing.length === 0) return;
      for (const id of missing) lastRequested.add(id);
      const found = await Promise.all(
        missing.map(
          async (id) =>
            [id, (await deps.lastAssistantText(id).catch(() => undefined)) ?? ''] as const
        )
      );
      publish({ last: { ...data.last, ...Object.fromEntries(found) } });
    },

    /** Drops cached per-session lookups after the session changed. */
    invalidate(sessionID: string): void {
      lastRequested.delete(sessionID);
      extraRequested.delete(sessionID);
      const { [sessionID]: _last, ...last } = data.last;
      const { [sessionID]: _extra, ...extra } = data.extra;
      publish({ last, extra });
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
