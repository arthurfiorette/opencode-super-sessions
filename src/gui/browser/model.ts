import type { SessionInfo } from '@opencode/client';
import { createKeyed, type ServerRef } from '@opencode/plugin/gui';
import { createEffect, createMemo, createSignal, onCleanup, untrack } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { listFilters, sessionScope } from '../../host/session-info.js';
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
import { rpcAt, rpcOn, serverPluginMissing } from '../server.js';

// The browser's data for one open dialog: the TUI's page controller (`src/page/state.ts`) bound to
// the window's `ServerRef`, as `src/page/model.ts` binds it to the TUI's client and `data`. The
// window keeps nothing between opens, so each open loads afresh.

// A reload waits for a burst of session events to settle, like the TUI's.
const RELOAD_DELAY = 500;
// Rows of the view on screen asked from the forge again while the dialog stays open.
const REFRESH_INTERVAL = 60_000;

/** Where the dialog lists from, decided when it opens. */
export interface BrowserTarget {
  readonly server: ServerRef;
  /** The routed session, whose project "this project" is; undefined on Home. */
  readonly origin: { readonly id: string; readonly directory: string } | undefined;
}

/** What {@link createBrowserModel} reads besides the target. */
export interface BrowserInput {
  readonly target: BrowserTarget;
  readonly scope: () => PageScope;
  readonly view: () => PageView;
  readonly query: () => string;
}

/**
 * Loads and groups the sessions of one server for the dialog. Call it under the dialog's owner:
 * its listeners, timers and controller end with it.
 */
export function createBrowserModel(input: BrowserInput) {
  const { server, origin } = input.target;
  const client = () => server.client;
  const data = () => server.data;
  // Set once a refs call answers that this server runs no server half; the rows then show no refs.
  const [missing, setMissing] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());

  let originInfo: Promise<SessionInfo> | undefined;
  /** The routed session as the server stores it, read once per open; a failed read is retried. */
  const originSession = (id: string) => {
    if (originInfo !== undefined) return originInfo;
    const reading = Promise.resolve(data().session.get(id)).then(
      (known) => known ?? client().session.get({ sessionID: id })
    );
    originInfo = reading;
    reading.catch(() => {
      if (originInfo === reading) originInfo = undefined;
    });
    return reading;
  };
  /** The scope as the server's list and search take it. */
  const searchScope = async (scope: PageScope): Promise<SearchScope> =>
    scope === 'all' || origin === undefined
      ? { type: 'all' }
      : sessionScope(await originSession(origin.id));
  // The routed session's Location answers for the plugin there; on Home, or when that directory no
  // longer resolves, the server's default one.
  const rpcOptions = async () =>
    origin === undefined ? {} : await rpcAt(server, origin.directory);
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
          ...listFilters(await searchScope(request.scope)),
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
        const scope = await searchScope(request.scope);
        return rpc(async () =>
          rpcOn(server).search(
            { query: request.query, archived: request.archived, scope, limit: 100 },
            await rpcOptions()
          )
        );
      },
      refs: (sessionIDs) => rpc(async () => rpcOn(server).refs({ sessionIDs }, await rpcOptions())),
      refresh: (sessionIDs, force) =>
        rpc(async () =>
          rpcOn(server).refresh(force ? { sessionIDs, force } : { sessionIDs }, await rpcOptions())
        ),
      running,
      async pending(sessionID) {
        const sessions = data().session;
        // Permissions and questions sync on request; only Done candidates get here.
        await Promise.all([
          sessions.permission.sync(sessionID).catch(() => {}),
          sessions.form.sync(sessionID).catch(() => {})
        ]);
        return (
          (sessions.permission.list(sessionID)?.length ?? 0) > 0 ||
          (sessions.form.list(sessionID)?.length ?? 0) > 0
        );
      },
      async lastUserMessageAt(sessionID) {
        const page = await client().message.list({
          sessionID,
          order: 'desc',
          limit: 1,
          type: 'user'
        });
        return page.data[0]?.time.created;
      }
    },
    (next) => setStore(reconcile(next, { key: 'id' }))
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
  const pullGroups = createMemo((): PullGroup[] =>
    input.view() === 'pulls' ? groupPulls(filterPulls(allPulls(), input.query()), now()) : []
  );
  /** Session groups of the list on screen: the search results, or the view's groups. */
  const groups = createMemo((): Group[] => {
    const view = input.view();
    if (view === 'pulls') return [];
    const search = store.search;
    if (search) return groupSearch(search.sessions, search.reasons, running, now());
    if (view === 'done') return doneGroups();
    if (view === 'archived') return archivedGroups();
    return activeGroups();
  });
  const counts = createMemo(() => ({
    active: rowsOf(activeGroups()).length,
    done: rowsOf(doneGroups()).length,
    archived: rowsOf(archivedGroups()).length,
    pulls: allPulls().length
  }));
  /** Whether a session is in the Done view now, by the rule or the user's mark. */
  const isDone = (sessionID: string) =>
    rowsOf(doneGroups()).some((session) => session.id === sessionID);

  // Sessions this open already asked the forge about; the server refetches only stale refs, so
  // asking once per newly shown row, then every minute, keeps the rows current.
  const requested = new Set<string>();
  /** Asks the forge about the given rows that this open has not asked about yet. */
  const refreshNew = (ids: readonly string[]) => {
    const fresh = ids.filter((id) => !requested.has(id));
    for (const id of fresh) requested.add(id);
    void controller.refresh(fresh);
  };

  /** Sessions of the view on screen; in the Pull requests view, each one's newest session. */
  const visibleIDs = () =>
    input.view() === 'pulls'
      ? pullGroups().flatMap((group) => group.pulls.flatMap((pull) => pull.sessions[0]?.id ?? []))
      : rowsOf(groups()).map((session) => session.id);
  // Switching views and searching show rows the load's refresh never saw. A listed row waits for
  // its cached read, since a cold load shows the lists before a slow `refs` answer that would land
  // over the fresher one; search hits outside the lists have no read and go at once.
  createEffect(() => {
    if (store.status !== 'ready') return;
    const listed = new Set([...store.active, ...store.archived].map((session) => session.id));
    const ids = visibleIDs().filter((id) => store.refs[id] !== undefined || !listed.has(id));
    untrack(() => refreshNew(ids));
  });

  let loadToken = 0;
  /** Loads the lists for the scope, then asks the forge about the rows of the view on screen. */
  const load = async () => {
    const token = ++loadToken;
    await controller.load(input.scope());
    if (token === loadToken) refreshNew(visibleIDs());
  };

  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  /** Reloads once a burst of session changes settles. */
  const changed = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void load(), RELOAD_DELAY);
  };
  // `data` is the server's live event feed; a restarted server brings a new one, so the listeners
  // follow it as the refs store's do.
  createKeyed(data, (events) => {
    const offs = [
      events.on('session.deleted', (event) => controller.removed(event.data.sessionID)),
      // A link or unlink, here or in a TUI, writes the session's metadata: read its refs again.
      events.on('session.metadata.updated', (event) => {
        controller.invalidate(event.data.sessionID);
        void controller.reread([event.data.sessionID]).catch(() => {});
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
  const ticker = setInterval(() => {
    setNow(Date.now());
    void controller.refresh(visibleIDs());
  }, REFRESH_INTERVAL);
  onCleanup(() => {
    clearTimeout(reloadTimer);
    clearInterval(ticker);
    controller.dispose();
  });

  return {
    server,
    data: store,
    missing,
    now,
    controller,
    groups,
    pullGroups,
    counts,
    isDone,
    /** Whether the session or one of its subagents runs, by the server's live status. */
    isRunning: running,
    load,
    refreshNew,
    rpcOptions
  };
}

export type BrowserModel = ReturnType<typeof createBrowserModel>;
