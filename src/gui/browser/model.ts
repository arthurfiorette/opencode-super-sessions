import type { SessionInfo } from '@opencode/client';
import { createKeyed, type ServerRef } from '@opencode/plugin/gui';
import { createEffect, createMemo, createSignal, on, onCleanup, untrack } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import {
  inScope,
  projectListFilters,
  sessionScope,
  wholeProject
} from '../../host/session-info.js';
import {
  createPageController,
  filterPulls,
  type Group,
  groupPulls,
  groupSearch,
  groupSessions,
  type PageData,
  type PageScope,
  type PageView,
  type PullGroup,
  pullRows,
  rowsOf
} from '../../page/state.js';
import type { SearchScope } from '../../rpc.js';
import { rpcAt, rpcOn, serverPluginMissing, warmRpc } from '../server.js';
import type { RailSelection } from './rail.js';

// The browser's data for one server: the TUI's page controller (`src/page/state.ts`) bound to the
// window's `ServerRef`, as `src/page/model.ts` binds it to the TUI's client and `data`. The model
// lives as long as the window, from the first open on, so reopening draws the cached lists at
// once and reloads them in the background when they are old or a session event changed them. A
// view (the dialog, and later the side panel) attaches to it while it shows and reads the same
// data; `createBrowserView` holds what is the view's own.

// A reload waits for a burst of session events to settle, like the TUI's.
const RELOAD_DELAY = 500;
// Reopening within this window shows the cached lists without asking the server again, as the
// TUI's browser does (FRESH_FOR in src/page/model.ts).
const FRESH_FOR = 30_000;
// Rows of the view on screen asked from the forge again while it stays open.
const REFRESH_INTERVAL = 60_000;
// Rows a view asks the forge about per open or view switch, from the top of the list: about what
// the dialog shows. The `refs` read has the server refresh every stale row in the background
// anyway, so the rest of the list stays current without a call of the window's own.
const REFRESH_ROWS = 30;
// Every project's active sessions asked for the rail and the instant switch: the list's own page.
const EVERY_LIMIT = 200;
// The All scope's key among the cached scopes.
const ALL_SCOPE = JSON.stringify({ type: 'all' } satisfies SearchScope);

/** A scope's lists as last shown, with when they loaded and whether a session event came since. */
interface ScopeLists {
  readonly lists: { readonly active: SessionInfo[]; readonly archived: SessionInfo[] };
  readonly at: number;
  dirty: boolean;
}

/** Where the dialog lists from, decided when it opens. */
export interface BrowserTarget {
  readonly server: ServerRef;
  /** The routed session, whose project "this project" is; undefined on Home. */
  readonly origin: { readonly id: string; readonly directory: string } | undefined;
}

/** What a view lists: the rail's pick over the routed session it opened on. */
export interface ListTarget {
  readonly origin: BrowserTarget['origin'];
  readonly selection: RailSelection;
}

/**
 * Loads and groups the sessions of one server for every view of the window. Call it once per
 * server, under an owner that lives as long as the window: its event listeners keep the cached
 * lists current between opens, and end with it. `selection` is the rail's first pick.
 */
export function createBrowserModel(server: ServerRef, selection: RailSelection) {
  const client = () => server.client;
  const data = () => server.data;
  // The rail's pick, one for every view: the lists hold one scope at a time, so the dialog and
  // the side tab always list the same one.
  const [picked, setPicked] = createSignal<RailSelection>(selection);
  // Counts the views that went away. A view that stays syncs and searches again, since the one
  // that left may have listed or searched for something else.
  const [released, setReleased] = createSignal(0);
  // Set once a refs call answers that this server runs no server half; the rows then show no refs.
  const [missing, setMissing] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  // What the latest sync listed; the controller's requests read it when they start.
  let target: ListTarget = { origin: undefined, selection: { type: 'all' } };

  // Routed sessions as the server stores them, read once each; a failed read is retried.
  const origins = new Map<string, Promise<SessionInfo>>();
  /** The routed session as the server stores it. */
  const originSession = (id: string) => {
    const known = origins.get(id);
    if (known !== undefined) return known;
    const reading = Promise.resolve(data().session.get(id)).then(
      (found) => found ?? client().session.get({ sessionID: id })
    );
    origins.set(id, reading);
    reading.catch(() => {
      if (origins.get(id) === reading) origins.delete(id);
    });
    return reading;
  };
  /** The controller's name for the rail's pick, which it only tells apart as all or one. */
  const pageScope = (): PageScope => (target.selection.type === 'all' ? 'all' : 'project');
  /**
   * The rail's pick as the server's list and search take it, read when a request starts: a new
   * scope resets the controller, which drops the answers of earlier ones. A project is the whole
   * project, as the sidebar's project group lists it.
   */
  const searchScope = async (): Promise<SearchScope> => {
    const { selection, origin } = target;
    if (selection.type === 'all') return { type: 'all' };
    if (selection.type !== 'routed') return selection;
    return origin === undefined
      ? { type: 'all' }
      : wholeProject(sessionScope(await originSession(origin.id)));
  };
  // The routed session's Location answers for the plugin there; on Home, or when that directory no
  // longer resolves, the server's default one.
  const rpcOptions = async () => {
    const origin = target.origin;
    return origin === undefined ? {} : await rpcAt(server, origin.directory);
  };
  /** Runs an RPC, noting a server without the server half before the error goes on. */
  const rpc = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      if (serverPluginMissing(error)) setMissing(true);
      throw error;
    }
  };
  const running = (sessionID: string) => {
    const sessions = data().session;
    return (
      sessions.status(sessionID) === 'running' ||
      sessions.family(sessionID).some((id) => sessions.status(id) === 'running')
    );
  };

  const controller = createPageController(
    {
      async list(request) {
        const response = await client().session.list({
          ...projectListFilters(await searchScope()),
          ...(request.search ? { search: request.search } : {}),
          limit: 200,
          order: 'desc',
          parentID: null,
          archived: request.archived
        });
        return response.data;
      },
      get: (sessionID) => client().session.get({ sessionID }),
      search: async (request) => {
        const scope = await searchScope();
        return rpc(async () =>
          rpcOn(server).search(
            { query: request.query, archived: request.archived, scope, limit: 100 },
            await rpcOptions()
          )
        );
      },
      refs: (sessionIDs) => rpc(async () => rpcOn(server).refs({ sessionIDs }, await rpcOptions())),
      refresh: (sessionIDs, force, signal) =>
        rpc(async () =>
          rpcOn(server).refresh(force ? { sessionIDs, force } : { sessionIDs }, {
            ...(await rpcOptions()),
            ...(signal === undefined ? {} : { signal })
          })
        ),
      running,
      // One call for every candidate. Syncing permissions and questions per session went through
      // each session's Location, which booted the evicted ones (0.4 s to 1.4 s each).
      doneFacts: (sessionIDs) =>
        rpc(async () => rpcOn(server)['done.facts']({ sessionIDs }, await rpcOptions()))
    },
    (next) => setStore(reconcile(next, { key: 'id' })),
    // Titles first: the rows show as soon as the lists answer, and their ref lines fill in after.
    { hold: 0 }
  );
  const [store, setStore] = createStore<PageData>(structuredClone(controller.snapshot()));

  const groupsFor = (view: Exclude<PageView, 'pulls'>): Group[] =>
    groupSessions({
      view,
      sessions: view === 'archived' ? store.archived : store.active,
      refs: store.refs,
      extra: store.extra,
      running,
      pins: [],
      now: now()
    });
  const activeGroups = createMemo(() => groupsFor('active'));
  const doneGroups = createMemo(() => groupsFor('done'));
  const archivedGroups = createMemo(() => groupsFor('archived'));
  // Archived sessions count too: a pull request someone worked on stays listed after cleanup.
  const allPulls = createMemo(() => pullRows([...store.active, ...store.archived], store.refs));
  const counts = createMemo(() => ({
    active: rowsOf(activeGroups()).length,
    done: rowsOf(doneGroups()).length,
    archived: rowsOf(archivedGroups()).length,
    pulls: allPulls().length
  }));
  /** Whether a session is in the Done view now, by the rule or the user's mark. */
  const isDone = (sessionID: string) =>
    rowsOf(doneGroups()).some((session) => session.id === sessionID);

  // Every project's active sessions: the All lists while they show, else one list asked for the
  // rail, at most once per FRESH_FOR. The rail's tiles count from it, and a switch to a project
  // shows that project's share of it at once.
  const [everyActive, setEveryActive] = createSignal<readonly SessionInfo[]>();
  let everyAt = 0;
  let everyAsking = false;
  /** Asks for every project's active sessions unless a fresh list is in. */
  const wantEveryActive = () => {
    if (everyAsking || Date.now() - everyAt <= FRESH_FOR) return;
    everyAsking = true;
    client()
      .session.list({ limit: EVERY_LIMIT, order: 'desc', parentID: null, archived: false })
      .then((page) => {
        setEveryActive(page.data);
        everyAt = Date.now();
      })
      .catch(() => {
        // The tiles keep what they had; the next open asks again.
      })
      .finally(() => {
        everyAsking = false;
      });
  };

  // The resolved scope the shown lists belong to, and when they loaded. Keyed by what the lists
  // hold rather than by the pick: every worktree of a project lists the same sessions.
  let loadedFor: string | undefined;
  let loadedAt = 0;
  let dirty = false;
  let syncToken = 0;
  // Views on screen. Session events only mark the lists dirty while there is none.
  let attached = 0;
  // The lists of the other scopes shown before, by resolved scope, each with its own age, so
  // switching back to one draws at once and asks again only past FRESH_FOR or a session event.
  const scopes = new Map<string, ScopeLists>();
  const [showsAll, setShowsAll] = createSignal(false);
  // Set while a load runs, for the views' progress hint over the rows already on screen.
  const [loading, setLoading] = createSignal(false);
  let loads = 0;

  // While All shows, its active list is every project's.
  createEffect(() => {
    if (!showsAll() || store.status !== 'ready') return;
    setEveryActive([...store.active]);
    everyAt = loadedAt;
  });

  /**
   * What a scope shows before its own list answers: its lists from an earlier visit, else its
   * share of every project's active sessions and of the All archived list. Undefined when nothing
   * in memory has any of its sessions, so the view shows as loading.
   */
  const seedFor = (key: string, scope: SearchScope) => {
    const cached = scopes.get(key);
    if (cached !== undefined) return cached;
    const all = scopes.get(ALL_SCOPE)?.lists;
    const active = (everyActive() ?? all?.active ?? []).filter((item) => inScope(item, scope));
    const archived = (all?.archived ?? []).filter((item) => inScope(item, scope));
    if (active.length === 0 && archived.length === 0) return undefined;
    // Age 0 and dirty: shown at once, loaded in the background right after.
    return { lists: { active, archived }, at: 0, dirty: true };
  };

  /** Shows the lists of `key` in place of the current ones, keeping those for a later visit. */
  const enter = (key: string, scope: SearchScope) => {
    if (key === loadedFor) return;
    const shown = untrack(() => controller.snapshot());
    if (loadedFor !== undefined && shown.status === 'ready') {
      scopes.set(loadedFor, {
        lists: { active: [...shown.active], archived: [...shown.archived] },
        at: loadedAt,
        dirty
      });
    }
    const seed = seedFor(key, scope);
    controller.show(seed?.lists);
    loadedFor = key;
    loadedAt = seed?.at ?? 0;
    dirty = seed?.dirty ?? true;
    setShowsAll(scope.type === 'all');
  };

  /**
   * The rail's pick resolved without a request, when it can be: the routed project needs the
   * routed session, which the server may not have synced yet.
   */
  const knownScope = (): SearchScope | undefined => {
    const { selection, origin } = target;
    if (selection.type === 'all') return { type: 'all' };
    if (selection.type !== 'routed') return selection;
    if (origin === undefined) return { type: 'all' };
    const info =
      data().session.get(origin.id) ??
      [...store.active, ...store.archived].find((item) => item.id === origin.id);
    return info === undefined ? undefined : wholeProject(sessionScope(info));
  };

  /**
   * Brings the lists up to date for `next`. Lists of the same resolved scope stay on screen and
   * reload in the background when older than {@link FRESH_FOR}, dirty or failed. Another scope
   * shows at once from what the model holds (see `seedFor`) and loads in the background, with
   * only its sessions without refs asking for theirs. Resolves once the lists and their refs are
   * settled, or at once when the lists are fresh. `force` reloads even fresh lists, as Retry does.
   */
  const sync = async (next: ListTarget, force = false): Promise<void> => {
    target = next;
    const token = ++syncToken;
    // The lists' first RPC waits on these; started now, they run beside the lists.
    warmRpc(server, next.origin?.directory);
    const previous = loadedFor;
    // Before the view's search runs for the new pick, so it searches the new lists.
    const known = untrack(knownScope);
    if (known !== undefined) enter(JSON.stringify(known), known);
    // An unresolved scope matches nothing, so the load runs and reports the failure.
    const resolved = await searchScope().catch(() => undefined);
    if (token !== syncToken) return;
    const key = resolved === undefined ? undefined : JSON.stringify(resolved);
    if (resolved !== undefined && key !== undefined) enter(key, resolved);
    const stale =
      force ||
      dirty ||
      key === undefined ||
      key !== loadedFor ||
      untrack(() => store.status) !== 'ready' ||
      Date.now() - loadedAt > FRESH_FOR;
    if (!stale) return;
    loadedAt = Date.now();
    dirty = false;
    loads++;
    setLoading(true);
    try {
      await controller.load(pageScope(), previous !== loadedFor ? { refs: 'missing' } : {});
    } finally {
      loads--;
      if (loads === 0) setLoading(false);
    }
  };

  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  /** Reloads once a burst of session changes settles while a view shows; else marks dirty. */
  const changed = () => {
    for (const cached of scopes.values()) cached.dirty = true;
    dirty = true;
    if (attached === 0) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void sync(target), RELOAD_DELAY);
  };
  // `data` is the server's live event feed; a restarted server brings a new one, so the listeners
  // follow it as the refs store's do.
  createKeyed(data, (events) => {
    const offs = [
      events.on('session.deleted', (event) => {
        controller.removed(event.data.sessionID);
        for (const cached of scopes.values()) cached.dirty = true;
      }),
      // A link or unlink, here or in a TUI, writes the session's metadata: read its refs again,
      // or on the next open when nothing shows them.
      events.on('session.metadata.updated', (event) => {
        controller.invalidate(event.data.sessionID);
        if (attached === 0) dirty = true;
        else void controller.reread([event.data.sessionID]).catch(() => {});
      }),
      ...(
        [
          'session.created',
          'session.forked',
          'session.archived',
          'session.unarchived',
          'session.moved',
          'session.renamed'
        ] as const
      ).map((type) => events.on(type, changed)),
      ...(
        [
          'session.execution.started',
          'session.execution.succeeded',
          'session.execution.failed',
          'session.execution.interrupted'
        ] as const
      ).map((type) =>
        events.on(type, (event) => {
          controller.invalidate(event.data.sessionID);
          changed();
        })
      )
    ];
    onCleanup(() => {
      for (const off of offs) off();
    });
  });
  onCleanup(() => {
    clearTimeout(reloadTimer);
    controller.dispose();
  });

  return {
    server,
    data: store,
    missing,
    now,
    controller,
    activeGroups,
    doneGroups,
    archivedGroups,
    allPulls,
    counts,
    isDone,
    /** Whether the session or one of its subagents runs, by the server's live status. */
    isRunning: running,
    sync,
    /** A load runs, over the rows on screen when there are any. */
    loading,
    /** Every project's active sessions, once known; see `wantEveryActive`. */
    everyActive,
    wantEveryActive,
    rpcOptions,
    /** The scope the controller's search takes for the latest sync. */
    pageScope,
    /**
     * Counts a view on screen until the returned function runs. While one shows, session events
     * reload the lists; without one they wait for the next open.
     */
    attach(): () => void {
      attached++;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        attached--;
        setReleased((count) => count + 1);
      };
    },
    /** The rail's pick every view lists. */
    selection: picked,
    /** Picks a rail tile for every view. */
    select: (next: RailSelection) => setPicked(next),
    /** Moves each time a view goes away; see {@link createBrowserView}. */
    released,
    /** Moves the clock the rows' ages read. */
    tick: () => setNow(Date.now())
  };
}

export type BrowserModel = ReturnType<typeof createBrowserModel>;

/** What {@link createBrowserView} reads besides the model. */
export interface BrowserViewInput {
  /** The routed session the view opened on, and the rail's pick. */
  readonly target: () => ListTarget;
  readonly view: () => PageView;
  readonly query: () => string;
  /**
   * Whether the view is on screen. A view that stays mounted while hidden, as the side tab does,
   * syncs, searches and asks the forge only while it shows. Defaults to always.
   */
  readonly shown?: () => boolean;
}

/**
 * One view of the model: the groups of its view and search, and the forge calls it makes while
 * it shows. Call it under the view's owner. Its calls end when it hides or goes: an open's
 * `refresh` is aborted when the dialog closes, so the request does not hold one of the app's four
 * request slots for the seconds the forge takes.
 *
 * The lists and the search are the model's, one for every view, so each view syncs and searches
 * for itself when it shows and again when another view goes away (`released`).
 */
export function createBrowserView(model: BrowserModel, input: BrowserViewInput) {
  const store = model.data;
  const shown = input.shown ?? (() => true);
  // The forge calls of the current showing, aborted when it hides or the view goes.
  let abort = new AbortController();
  createEffect(() => {
    if (!shown()) return;
    const current = new AbortController();
    abort = current;
    onCleanup(model.attach());
    onCleanup(() => current.abort());
    // Cached rows show their ages as of now, not as of the last time they showed.
    untrack(model.tick);
  });

  const pullGroups = createMemo((): PullGroup[] =>
    input.view() === 'pulls'
      ? groupPulls(filterPulls(model.allPulls(), input.query()), model.now())
      : []
  );
  /** Session groups of the list on screen: the search results, or the view's groups. */
  const groups = createMemo((): Group[] => {
    const view = input.view();
    if (view === 'pulls') return [];
    const search = store.search;
    if (search) return groupSearch(search.sessions, search.reasons, model.isRunning, model.now());
    if (view === 'done') return model.doneGroups();
    if (view === 'archived') return model.archivedGroups();
    return model.activeGroups();
  });
  /** Sessions of the view on screen in list order; in the Pull requests view, each one's newest. */
  const visibleIDs = () =>
    input.view() === 'pulls'
      ? pullGroups().flatMap((group) => group.pulls.flatMap((pull) => pull.sessions[0]?.id ?? []))
      : rowsOf(groups()).map((session) => session.id);

  // Set once this open's sync settled: the lists, their refs and Done facts are in.
  const [settled, setSettled] = createSignal(false);
  let syncToken = 0;
  /** Syncs the model for the view's target; `force` reloads fresh lists too, as Retry does. */
  const load = async (force = false) => {
    const token = ++syncToken;
    setSettled(false);
    await model.sync(untrack(input.target), force);
    if (token === syncToken) setSettled(true);
  };
  createEffect(
    on([input.target, shown, model.released], () => {
      if (untrack(shown)) void load();
    })
  );
  // The search runs after the sync above, which shows a newly picked scope's lists first, so it
  // searches those. The Pull requests view filters its own rows, so the session search is off
  // there.
  createEffect(() => {
    if (!shown()) return;
    model.released();
    const all = input.target().selection.type === 'all';
    const pulls = input.view() === 'pulls';
    model.controller.search(
      pulls ? '' : input.query(),
      input.view() === 'archived',
      all ? 'all' : 'project'
    );
  });

  // Sessions this view already asked the forge about; the server refetches only stale refs, so
  // asking once per newly shown row, then every minute, keeps the rows current.
  const requested = new Set<string>();
  /** Asks the forge about the first rows of `ids` this view has not asked about yet. */
  const refreshNew = (ids: readonly string[]) => {
    const fresh = ids.slice(0, REFRESH_ROWS).filter((id) => !requested.has(id));
    for (const id of fresh) requested.add(id);
    void model.controller.refresh(fresh, abort.signal);
  };
  // Only once the first paint and its refs settled, so the forge call never queues ahead of the
  // reads the rows wait for. Switching views and searching show rows the load never asked about;
  // a listed row waits for its cached read, while search hits outside the lists go at once.
  createEffect(() => {
    if (!shown() || !settled() || store.status !== 'ready') return;
    const listed = new Set([...store.active, ...store.archived].map((session) => session.id));
    const ids = visibleIDs().filter((id) => store.refs[id] !== undefined || !listed.has(id));
    untrack(() => refreshNew(ids));
  });

  const ticker = setInterval(() => {
    if (!untrack(shown)) return;
    model.tick();
    void model.controller.refresh(visibleIDs().slice(0, REFRESH_ROWS), abort.signal);
  }, REFRESH_INTERVAL);
  onCleanup(() => clearInterval(ticker));

  return {
    groups,
    pullGroups,
    load,
    /** The current showing's signal, for the forge calls the view's actions make. */
    signal: () => abort.signal
  };
}
