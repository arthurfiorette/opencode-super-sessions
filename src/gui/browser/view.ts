import type { SessionInfo } from '@opencode/client';
import type { ServerRef } from '@opencode/plugin/gui';
import { createEffect, createMemo, createSignal, on, onCleanup, untrack } from 'solid-js';
import { machineTag } from '../../host/gui.js';
import {
  type DoneExtra,
  filterPulls,
  type Group,
  groupPulls,
  groupSearch,
  groupSessions,
  type PageData,
  type PageView,
  type PullGroup,
  pullRows,
  rowsOf,
  type SearchState
} from '../../page/state.js';
import type { SessionRefView } from '../../rpc.js';
import { createStable } from '../stable.js';
import type { Machines, MachinesTarget } from './machines.js';
import type { BrowserModel } from './model.js';

// One view of the browser, the dialog's or the side tab's list: the lists of every server its
// rail pick covers, merged into one list, grouped as the TUI groups one server's, and the forge
// calls it makes while it shows. Each server's model loads, searches and asks its forge on its
// own, so a slow or failing server never holds the others back.

// Rows of the view on screen asked from the forge again while it stays open.
const REFRESH_INTERVAL = 60_000;
// Rows a view asks each server's forge about per open or view switch, from the top of that
// server's rows: about what the dialog shows. The `refs` read has the server refresh every stale
// row in the background anyway, so the rest of the list stays current without a call of the
// window's own.
const REFRESH_ROWS = 30;

/** What {@link createBrowserView} reads besides the machines. */
export interface BrowserViewInput {
  /** The routed session the view opened on, and the rail's pick. */
  readonly target: () => MachinesTarget;
  readonly view: () => PageView;
  readonly query: () => string;
  /**
   * Whether the view is on screen. A view that stays mounted while hidden, as the side tab does,
   * syncs, searches and asks the forge only while it shows. Defaults to always.
   */
  readonly shown?: () => boolean;
}

/**
 * The sessions of several lists, each id once. The first list's copy wins: two listed servers
 * share session ids only when they are the same server reached twice, such as the app's own and
 * a loopback connection to its port.
 */
function unique(lists: readonly (readonly SessionInfo[])[]): SessionInfo[] {
  const seen = new Set<string>();
  const sessions: SessionInfo[] = [];
  for (const list of lists) {
    for (const session of list) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      sessions.push(session);
    }
  }
  return sessions;
}

/** Records of several servers in one, the first server's entry winning, as in {@link unique}. */
function mergeRecords<T>(records: readonly Readonly<Record<string, T>>[]): Record<string, T> {
  return Object.assign({}, ...[...records].reverse());
}

/** Whether two model lists hold the same models in the same order. */
function sameModels(a: readonly BrowserModel[], b: readonly BrowserModel[]): boolean {
  return a.length === b.length && a.every((model, index) => model === b[index]);
}

/**
 * One view over the machines: the merged lists, groups and counts of its pick, and the forge
 * calls it makes while it shows. Call it under the view's owner. Its calls end when it hides or
 * goes: an open's `refresh` is aborted when the dialog closes, so the request does not hold one
 * of the app's four request slots per server for the seconds the forge takes.
 *
 * The lists and the search live in each server's model, one for every view, so each view syncs
 * and searches for itself when it shows and again when another view goes away (`released`).
 */
export function createBrowserView(machines: Machines, input: BrowserViewInput) {
  // A memo: the side tab's visibility is read from the layout, which moves on every route change
  // while the tab stays visible, and each change would end this showing and start another.
  const shown = createMemo(input.shown ?? (() => true));
  // The pick and the routed server, cut from the target where they hold still, so a route
  // change inside one project reaches nothing that reads the lists (createStable in
  // src/gui/stable.ts).
  const pick = createStable(
    () => input.target().pick,
    (a, b) => JSON.stringify(a) === JSON.stringify(b)
  );
  const routedServer = createStable(() => input.target().origin?.server);
  const listed = createMemo(() => machines.listed(pick(), routedServer()), undefined, {
    equals: sameModels
  });
  // Ages show minutes at most, so a tick within the same minute changes no row.
  const [now, setNow] = createSignal(Date.now(), {
    equals: (a, b) => Math.floor(a / 60_000) === Math.floor(b / 60_000)
  });
  const tick = () => setNow(Date.now());

  // The forge calls of the current showing, aborted when it hides or the view goes.
  let abort = new AbortController();
  createEffect(() => {
    if (!shown()) return;
    const current = new AbortController();
    abort = current;
    onCleanup(machines.attach());
    onCleanup(() => current.abort());
    // Cached rows show their ages as of now, not as of the last time they showed.
    untrack(tick);
  });
  // A listed server's session events reload its lists while this view shows them.
  createEffect(() => {
    if (!shown()) return;
    for (const model of listed()) onCleanup(model.attach());
  });

  /** The model each listed or found session came from. */
  const owners = createMemo(() => {
    const byID = new Map<string, BrowserModel>();
    for (const model of listed()) {
      const { active, archived, search } = model.data;
      for (const session of [...active, ...archived, ...(search?.sessions ?? [])]) {
        if (!byID.has(session.id)) byID.set(session.id, model);
      }
    }
    return byID;
  });
  const active = createMemo(() => unique(listed().map((model) => model.data.active)));
  const archived = createMemo(() => unique(listed().map((model) => model.data.archived)));
  const refs = createMemo(() =>
    mergeRecords<SessionRefView>(listed().map((model) => model.data.refs))
  );
  const extra = createMemo(() =>
    mergeRecords<DoneExtra>(listed().map((model) => model.data.extra))
  );
  // Ready as soon as one server's lists are in, so a cached or fast server draws at once and the
  // others fill in; an error only when every listed server failed.
  const status = createMemo((): PageData['status'] => {
    const statuses = listed().map((model) => model.data.status);
    if (statuses.includes('ready')) return 'ready';
    if (statuses.length > 0 && statuses.every((value) => value === 'error')) return 'error';
    return 'loading';
  });
  // Every listed server searches the same query at once (see the search effect below), so the
  // answers merge into one result that is done once every server answered.
  const search = createMemo((): SearchState | undefined => {
    const states = listed().flatMap((model) => model.data.search ?? []);
    const first = states[0];
    if (first === undefined) return undefined;
    const statuses = states.map((state) => state.status);
    return {
      query: first.query,
      status: statuses.includes('searching')
        ? 'searching'
        : statuses.every((value) => value === 'error')
          ? 'error'
          : 'done',
      sessions: unique(states.map((state) => state.sessions)),
      reasons: mergeRecords(states.map((state) => state.reasons))
    };
  });
  /** The merged lists, read the way one server's `PageData` is. */
  const data: Readonly<PageData> = {
    get status() {
      return status();
    },
    get active() {
      return active();
    },
    get archived() {
      return archived();
    },
    get refs() {
      return refs();
    },
    get extra() {
      return extra();
    },
    get search() {
      return search();
    }
  };

  /** The model a session's row came from. */
  const modelOf = (sessionID: string) => owners().get(sessionID);
  /** Whether the session or one of its subagents runs, by its own server's live status. */
  const running = (sessionID: string) => modelOf(sessionID)?.isRunning(sessionID) ?? false;

  const groupsFor = (view: Exclude<PageView, 'pulls'>): Group[] =>
    groupSessions({
      view,
      sessions: view === 'archived' ? archived() : active(),
      refs: refs(),
      extra: extra(),
      running,
      pins: [],
      now: now()
    });
  const activeGroups = createMemo(() => groupsFor('active'));
  const doneGroups = createMemo(() => groupsFor('done'));
  const archivedGroups = createMemo(() => groupsFor('archived'));
  // Archived sessions count too: a pull request someone worked on stays listed after cleanup. A
  // pull request tracked on two machines is one row with the sessions of both.
  const allPulls = createMemo(() => pullRows([...active(), ...archived()], refs()));
  const counts = createMemo(() => ({
    active: rowsOf(activeGroups()).length,
    done: rowsOf(doneGroups()).length,
    archived: rowsOf(archivedGroups()).length,
    pulls: allPulls().length
  }));
  /**
   * Whether a session is in the Done view now, by the rule or the user's mark. A server without
   * the server plugin answers no refs, so its sessions never are.
   */
  const isDone = (sessionID: string) =>
    rowsOf(doneGroups()).some((session) => session.id === sessionID);

  const pullGroups = createMemo((): PullGroup[] =>
    input.view() === 'pulls' ? groupPulls(filterPulls(allPulls(), input.query()), now()) : []
  );
  /** Session groups of the list on screen: the search results, or the view's groups. */
  const groups = createMemo((): Group[] => {
    const view = input.view();
    if (view === 'pulls') return [];
    const found = search();
    if (found) return groupSearch(found.sessions, found.reasons, running, now());
    if (view === 'done') return doneGroups();
    if (view === 'archived') return archivedGroups();
    return activeGroups();
  });
  /** Sessions of the view on screen in list order; in the Pull requests view, each one's newest. */
  const visibleIDs = () =>
    input.view() === 'pulls'
      ? pullGroups().flatMap((group) => group.pulls.flatMap((pull) => pull.sessions[0]?.id ?? []))
      : rowsOf(groups()).map((session) => session.id);

  // The servers whose sync of this open settled: their lists, refs and Done facts are in.
  const [settled, setSettled] = createSignal<ReadonlySet<string>>(new Set());
  let syncToken = 0;
  /**
   * Syncs every listed server's model for the view's target, all at once; `force` reloads fresh
   * lists too, as Retry does. Each server counts as settled on its own.
   */
  const load = async (force = false) => {
    const token = ++syncToken;
    setSettled(new Set<string>());
    const target = untrack(input.target);
    await Promise.allSettled(
      untrack(listed).map(async (model) => {
        await model.sync(machines.targetFor(model, target), force);
        if (token !== syncToken) return;
        setSettled((done) => new Set([...done, model.server.id]));
      })
    );
  };
  createEffect(
    on([input.target, listed, shown, machines.released], () => {
      if (untrack(shown)) void load();
    })
  );
  // The search runs after the sync above, which shows a newly picked scope's lists first, so it
  // searches those. The Pull requests view filters its own rows, so the session search is off
  // there.
  // By the pick's kind only: a route change moves the target's origin, which must not search
  // again.
  const pickType = () => pick().type;
  createEffect(() => {
    if (!shown()) return;
    machines.released();
    const all = pickType() === 'all';
    const query = input.view() === 'pulls' ? '' : input.query();
    const archivedView = input.view() === 'archived';
    for (const model of listed()) {
      model.controller.search(query, archivedView, all ? 'all' : 'project');
    }
  });

  /** The visible ids each listed server owns, in list order. */
  const visibleByModel = () => {
    const ids = visibleIDs();
    return listed().map((model) => ({
      model,
      ids: ids.filter((id) => owners().get(id) === model)
    }));
  };
  // Sessions this view already asked the forge about, by server; the server refetches only stale
  // refs, so asking once per newly shown row, then every minute, keeps the rows current.
  const requested = new Set<string>();
  // Per server, only once its first paint and refs settled, so the forge call never queues ahead
  // of the reads its rows wait for. Switching views and searching show rows the load never asked
  // about; a listed row waits for its cached read, while search hits outside the lists go at
  // once.
  createEffect(() => {
    if (!shown() || status() !== 'ready') return;
    const done = settled();
    const asks = visibleByModel().flatMap(({ model, ids }) => {
      if (!done.has(model.server.id) || model.data.status !== 'ready') return [];
      const known = new Set(
        [...model.data.active, ...model.data.archived].map((session) => session.id)
      );
      const ready = ids.filter((id) => model.data.refs[id] !== undefined || !known.has(id));
      return [{ model, ids: ready }];
    });
    untrack(() => {
      for (const { model, ids } of asks) {
        const fresh = ids
          .slice(0, REFRESH_ROWS)
          .filter((id) => !requested.has(`${model.server.id}\n${id}`));
        for (const id of fresh) requested.add(`${model.server.id}\n${id}`);
        void model.controller.refresh(fresh, abort.signal);
      }
    });
  });

  const ticker = setInterval(() => {
    if (!untrack(shown)) return;
    tick();
    for (const { model, ids } of untrack(visibleByModel)) {
      void model.controller.refresh(ids.slice(0, REFRESH_ROWS), abort.signal);
    }
  }, REFRESH_INTERVAL);
  onCleanup(() => clearInterval(ticker));

  /** Whether the pick lists every machine. */
  const listsAll = () => pickType() === 'all';
  /** Listed servers that run no server plugin, once a call said so. */
  const missingOn = createMemo((): ServerRef[] =>
    listed()
      .filter((model) => model.missing())
      .map((model) => model.server)
  );

  return {
    /** The merged lists of every listed server. */
    data,
    groups,
    pullGroups,
    counts,
    isDone,
    isRunning: running,
    modelOf,
    /** The server a session's row came from. */
    serverOf: (sessionID: string): ServerRef | undefined => modelOf(sessionID)?.server,
    /** Whether a session's server runs no server plugin: no refs, Done or `alt+g` there. */
    missing: (sessionID: string) => modelOf(sessionID)?.missing() ?? false,
    missingOn,
    /** Whether every listed server runs no server plugin, which hides Done and `alt+g`. */
    allMissing: () => listed().length > 0 && missingOn().length === listed().length,
    /** Listed servers whose lists failed while another's show. */
    failedOn: createMemo((): ServerRef[] =>
      status() === 'ready'
        ? listed()
            .filter((model) => model.data.status === 'error')
            .map((model) => model.server)
        : []
    ),
    /** In All, the machines the app lists that are not connected, whose sessions are missing. */
    offline: createMemo((): ServerRef[] =>
      listsAll() ? machines.servers().filter((server) => !server.connected) : []
    ),
    /**
     * The machine name a session's row shows: for a session of a server other than this
     * machine's, once the app lists more than one (`machineTag` in src/host/gui.ts).
     */
    machine: (sessionID: string): string | undefined => {
      const server = modelOf(sessionID)?.server;
      return server === undefined ? undefined : machineTag(server, machines.servers().length);
    },
    /** A load runs on one of the listed servers, over the rows on screen when there are any. */
    loading: () => listed().some((model) => model.loading()),
    now,
    load,
    /** The current showing's signal, for the forge calls the view's actions make. */
    signal: () => abort.signal
  };
}

export type BrowserView = ReturnType<typeof createBrowserView>;
