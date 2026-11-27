import type { SessionInfo } from '@opencode/client';
import { createKeyed, type ServerRef } from '@opencode/plugin/gui';
import { createEffect, createMemo, createSignal, on, onCleanup, untrack } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { projectListFilters, sessionScope, wholeProject } from '../../host/session-info.js';
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
 * lists current between opens, and end with it.
 */
export function createBrowserModel(server: ServerRef) {
  const client = () => server.client;
  const data = () => server.data;
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

  // The resolved scope the cached lists were loaded for, and when. Keyed by what the lists hold
  // rather than by the pick: every worktree of a project lists the same sessions.
  let loadedFor: string | undefined;
  let loadedAt = 0;
  let dirty = false;
  let syncToken = 0;
  // Views on screen. Session events only mark the lists dirty while there is none.
  let attached = 0;

  /**
   * Brings the lists up to date for `next`. Cached lists for the same resolved scope stay on
   * screen and reload in the background when older than {@link FRESH_FOR}, dirty or failed; a
   * different scope starts over. Resolves once the lists and their refs are settled, or at once
   * when the cache is fresh. `force` reloads even fresh lists, as Retry does.
   */
  const sync = async (next: ListTarget, force = false): Promise<void> => {
    // A new rail pick starts over at once, before the view's search runs for it; a new routed
    // session waits for its scope below, so another worktree of the project keeps the lists.
    if (JSON.stringify(next.selection) !== JSON.stringify(target.selection)) {
      if (loadedFor !== undefined) controller.reset();
      loadedFor = undefined;
    }
    target = next;
    const token = ++syncToken;
    // The lists' first RPC waits on these; started now, they run beside the lists.
    warmRpc(server, next.origin?.directory);
    // An unresolved scope matches nothing, so the load runs and reports the failure.
    const key = await searchScope().then(
      (resolved) => JSON.stringify(resolved),
      () => undefined
    );
    if (token !== syncToken) return;
    const stale =
      force ||
      dirty ||
      key === undefined ||
      key !== loadedFor ||
      untrack(() => store.status) !== 'ready' ||
      Date.now() - loadedAt > FRESH_FOR;
    if (!stale) return;
    if (key !== loadedFor && loadedFor !== undefined) controller.reset();
    loadedFor = key;
    loadedAt = Date.now();
    dirty = false;
    await controller.load(pageScope());
  };

  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  /** Reloads once a burst of session changes settles while a view shows; else marks dirty. */
  const changed = () => {
    dirty = true;
    if (attached === 0) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void sync(target), RELOAD_DELAY);
  };
  // `data` is the server's live event feed; a restarted server brings a new one, so the listeners
  // follow it as the refs store's do.
  createKeyed(data, (events) => {
    const offs = [
      events.on('session.deleted', (event) => controller.removed(event.data.sessionID)),
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
      };
    },
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
}

/**
 * One view of the model: the groups of its view and search, and the forge calls it makes while
 * it shows. Call it under the view's owner. Its calls end with it: an open's `refresh` is aborted
 * when the dialog closes, so the request does not hold one of the app's four request slots for
 * the seconds the forge takes.
 */
export function createBrowserView(model: BrowserModel, input: BrowserViewInput) {
  const store = model.data;
  onCleanup(model.attach());
  // Cached rows show their ages as of now, not as of the last open.
  model.tick();
  const abort = new AbortController();
  onCleanup(() => abort.abort());

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
  createEffect(on(input.target, () => void load()));

  // Sessions this open already asked the forge about; the server refetches only stale refs, so
  // asking once per newly shown row, then every minute, keeps the rows current.
  const requested = new Set<string>();
  /** Asks the forge about the first rows of `ids` this open has not asked about yet. */
  const refreshNew = (ids: readonly string[]) => {
    const fresh = ids.slice(0, REFRESH_ROWS).filter((id) => !requested.has(id));
    for (const id of fresh) requested.add(id);
    void model.controller.refresh(fresh, abort.signal);
  };
  // Only once the first paint and its refs settled, so the forge call never queues ahead of the
  // reads the rows wait for. Switching views and searching show rows the load never asked about;
  // a listed row waits for its cached read, while search hits outside the lists go at once.
  createEffect(() => {
    if (!settled() || store.status !== 'ready') return;
    const listed = new Set([...store.active, ...store.archived].map((session) => session.id));
    const ids = visibleIDs().filter((id) => store.refs[id] !== undefined || !listed.has(id));
    untrack(() => refreshNew(ids));
  });

  const ticker = setInterval(() => {
    model.tick();
    void model.controller.refresh(visibleIDs().slice(0, REFRESH_ROWS), abort.signal);
  }, REFRESH_INTERVAL);
  onCleanup(() => clearInterval(ticker));

  return {
    groups,
    pullGroups,
    load,
    /** This open's signal, for the forge calls its actions make. */
    signal: abort.signal
  };
}
