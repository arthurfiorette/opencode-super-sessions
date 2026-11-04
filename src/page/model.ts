import type { LocationPublicInfo, LocationRef, SessionInfo } from '@opencode/client';
import type { Plugin } from '@opencode/plugin/tui';
import type { Route } from '@opencode/plugin/tui/context';
import { createEffect, createMemo, createRoot, createSignal, on } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { listFilters, projectScope, sessionScope } from '../host/session-api.js';
import type { Pins } from '../pins.js';
import { type SearchScope, SuperSessions } from '../rpc.js';
import { tuiSettingsFor } from '../settings/store.js';
import {
  createPageController,
  filterPulls,
  type Group,
  groupPulls,
  groupSearch,
  groupSessions,
  type PageData,
  type PageMemory,
  type PageScope,
  type PageView,
  pullRows,
  rowsOf
} from './state.js';

// A reload waits for a burst of session events to settle.
const RELOAD_DELAY = 500;
// Reopening within this window shows the cached lists without asking the server again.
const FRESH_FOR = 30_000;

/**
 * Sessions, refs and browser state shared by the overlay and the peek keys. It lives as long as
 * the plugin, so reopening the browser draws the cached lists at once and refreshes them in the
 * background. `onError` gets errors from the shared list memos, which live in a root of their own
 * and so outside the view's error boundary.
 */
export function createBrowserModel(
  context: Plugin.Context,
  pins: Pins,
  isOpen: () => boolean,
  onError: (error: unknown) => void
) {
  const client = context.client;
  const [memory, setMemory] = context.storage.memory<PageMemory>('page', {
    initial: { query: '', view: 'active', selected: undefined, scroll: 0 }
  });
  const settings = tuiSettingsFor(context);
  // ctrl+a stores an override here; without one the "Default scope" setting decides.
  const [prefs, setPrefs] = context.storage.store<{ allProjects?: boolean }>('page-prefs', {
    initial: {}
  });
  const allProjects = () => prefs.allProjects ?? settings.scope() === 'all';
  const scope = (): PageScope => (allProjects() ? 'all' : 'project');
  /** Flips the scope for this and later opens, until the default scope setting changes. */
  const toggleScope = () =>
    setPrefs((draft) => {
      draft.allProjects = !allProjects();
    });
  const [origin, setOrigin] = createSignal<Route>({ type: 'home' });
  const [now, setNow] = createSignal(Date.now());

  // The browser opens over a session, home or a plugin page; "this project" means the project of
  // the session underneath, like the built-in list.
  /** The session the browser opened over, when it did. */
  const originSession = (): SessionInfo | undefined => {
    const route = origin();
    return route.type === 'session' ? context.data.session.get(route.sessionID) : undefined;
  };
  /** The TUI's own Location. */
  const home = (): LocationRef => context.location ?? context.data.location.default();
  const location = (): LocationRef => originSession()?.location ?? home();
  const infos = new Map<string, Promise<LocationPublicInfo>>();
  // Directories whose last lookup failed, such as a worktree removed before a restart. RPCs go
  // through the home Location instead, since the host routes them through the request's Location.
  const unreachable = new Set<string>();
  const resolveLocation = () => {
    const directory = location().directory;
    let info = infos.get(directory);
    if (info === undefined) {
      info = client.location.get({ location: { directory } });
      // A failed lookup is retried on the next open instead of failing every open after it.
      info.then(
        () => unreachable.delete(directory),
        () => {
          infos.delete(directory);
          unreachable.add(directory);
        }
      );
      infos.set(directory, info);
    }
    return info;
  };
  /**
   * "This project" for the location under the browser. When its directory does not resolve, a
   * session underneath still names its project and path, so the list stays on that project.
   */
  const projectOf = async (): Promise<Exclude<SearchScope, { type: 'all' }>> => {
    try {
      return projectScope(await resolveLocation());
    } catch (error) {
      const session = originSession();
      if (session === undefined) throw error;
      return sessionScope(session);
    }
  };
  /** The project id and root directory under the browser, for the header. */
  const resolveProject = async (): Promise<{ id: string; directory: string }> => {
    try {
      const info = await resolveLocation();
      return { id: info.project.id, directory: info.project.directory };
    } catch (error) {
      const session = originSession();
      if (session === undefined) throw error;
      return { id: session.projectID, directory: session.location.directory };
    }
  };
  const searchScope = async (target: PageScope): Promise<SearchScope> =>
    target === 'all' ? { type: 'all' } : projectOf();
  const listScope = async (target: PageScope) => listFilters(await searchScope(target));
  const rpc = () => context.client.rpc(SuperSessions);
  /** The Location the plugin's RPCs go through: the one under the browser, if it resolves. */
  const rpcOptions = () => {
    const directory = location().directory;
    return { location: { directory: unreachable.has(directory) ? home().directory : directory } };
  };
  const running = (sessionID: string) =>
    context.data.session.status(sessionID) === 'running' ||
    context.data.session
      .family(sessionID)
      .some((id) => context.data.session.status(id) === 'running');

  const controller = createPageController(
    {
      async list(input) {
        const response = await client.session.list({
          ...(await listScope(input.scope)),
          ...(input.search ? { search: input.search } : {}),
          limit: 200,
          order: 'desc',
          parentID: null,
          archived: input.archived
        });
        return response.data;
      },
      get: (sessionID) => client.session.get({ sessionID }),
      search: async (input) =>
        rpc().search(
          {
            query: input.query,
            archived: input.archived,
            scope: await searchScope(input.scope),
            limit: 100
          },
          rpcOptions()
        ),
      refs: (sessionIDs) => rpc().refs({ sessionIDs }, rpcOptions()),
      refresh: (sessionIDs, force) =>
        rpc().refresh(force ? { sessionIDs, force } : { sessionIDs }, rpcOptions()),
      running,
      async pending(sessionID) {
        const permission = context.data.session.permission;
        const form = context.data.session.form;
        // Lists stay undefined until synced; only Done candidates get here, so syncing is cheap.
        if (permission.list(sessionID) === undefined)
          await permission.sync(sessionID).catch(() => {});
        if (form.list(sessionID) === undefined) await form.sync(sessionID).catch(() => {});
        return (
          (permission.list(sessionID)?.length ?? 0) > 0 || (form.list(sessionID)?.length ?? 0) > 0
        );
      },
      async lastUserMessageAt(sessionID) {
        const page = await client.message.list({
          sessionID,
          order: 'desc',
          limit: 1,
          type: 'user'
        });
        return page.data[0]?.time.created;
      }
    },
    (next) => setData(reconcile(next, { key: 'id' }))
  );
  const [data, setData] = createStore<PageData>(structuredClone(controller.snapshot()));

  /** Groups of one view. Reads the host's run state, so a host change can throw here. */
  const groupsFor = (view: PageView): Group[] => {
    try {
      return groupSessions({
        view,
        sessions: view === 'archived' ? data.archived : data.active,
        refs: data.refs,
        extra: data.extra,
        running,
        pins: pins.ids(),
        now: now()
      });
    } catch (error) {
      onError(error);
      return [];
    }
  };
  // The memos get a root of their own. Only they live in it: the host resolves keymap, slot and
  // storage providers from the owner the plugin's setup runs under, which a root would hide.
  const lists = createRoot((dispose) => {
    // Changing the default in the settings dialog applies at once, over an older ctrl+a choice.
    createEffect(
      on(
        () => settings.scope(),
        () =>
          void setPrefs((draft) => {
            delete draft.allProjects;
          }).catch(() => {}),
        { defer: true }
      )
    );
    const activeGroups = createMemo(() => groupsFor('active'));
    const doneGroups = createMemo(() => groupsFor('done'));
    const archivedGroups = createMemo(() => groupsFor('archived'));
    /** Groups of the list on screen: the search results, or the current view. */
    const searchGroups = createMemo((): Group[] => {
      const search = data.search;
      if (!search) return [];
      try {
        return groupSearch(search.sessions, search.reasons, running, now());
      } catch (error) {
        onError(error);
        return [];
      }
    });
    // Archived sessions count too: a pull request someone worked on stays listed after cleanup.
    const allPulls = createMemo(() => pullRows([...data.active, ...data.archived], data.refs));
    const pullGroups = createMemo(() =>
      memory.view === 'pulls' ? groupPulls(filterPulls(allPulls(), memory.query), now()) : []
    );
    /** Session groups of the list on screen; the Pull requests view lists pull requests instead. */
    const groups = createMemo((): Group[] => {
      if (memory.view === 'pulls') return [];
      if (data.search) return searchGroups();
      if (memory.view === 'done') return doneGroups();
      if (memory.view === 'archived') return archivedGroups();
      return activeGroups();
    });
    /**
     * Sessions in list order, which peeking walks. In the Pull requests view, each pull request's
     * newest session, once.
     */
    const rows = createMemo((): SessionInfo[] => {
      if (memory.view !== 'pulls') return rowsOf(groups());
      const newest = new Map<string, SessionInfo>();
      for (const pull of pullGroups().flatMap((group) => group.pulls)) {
        const session = pull.sessions[0];
        if (session && !newest.has(session.id)) newest.set(session.id, session);
      }
      return [...newest.values()];
    });
    return {
      dispose,
      doneGroups,
      groups,
      pullGroups,
      rows,
      counts: createMemo(() => ({
        active: rowsOf(activeGroups()).length,
        done: rowsOf(doneGroups()).length,
        archived: rowsOf(archivedGroups()).length,
        pulls: allPulls().length
      }))
    };
  });

  // The resolved scope the cached lists were loaded for, and when. Keyed by what the lists hold
  // rather than by directory: every worktree of a project, and any directory in "all projects",
  // lists the same sessions.
  let loadedFor: string | undefined;
  let loadedAt = 0;
  let dirty = false;
  let syncToken = 0;
  /**
   * Brings the lists up to date for the current scope and location. Cached lists for the same
   * resolved scope stay on screen while the location resolves and a reload runs; a different
   * project starts over. Resolves once the lists are settled, or at once when the cache is fresh.
   */
  const sync = async (): Promise<void> => {
    const token = ++syncToken;
    const target = scope();
    // An unresolved scope matches nothing, so the load runs and reports the failure.
    const key = await searchScope(target).then(
      (resolved) => JSON.stringify(resolved),
      () => undefined
    );
    // A later sync, such as a ctrl+a during the lookup, decides instead.
    if (token !== syncToken) return;
    if (key !== undefined && key === loadedFor && !dirty && Date.now() - loadedAt <= FRESH_FOR)
      return;
    if (key !== loadedFor && loadedFor !== undefined) controller.reset();
    loadedFor = key;
    loadedAt = Date.now();
    dirty = false;
    await controller.load(target);
  };
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  /** Reloads soon while the browser is open; otherwise the next open reloads. */
  const changed = () => {
    dirty = true;
    if (!isOpen()) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void sync(), RELOAD_DELAY);
  };
  const offs = [
    context.data.on('session.deleted', (event) => controller.removed(event.data.sessionID)),
    ...(
      [
        'session.created',
        'session.archived',
        'session.unarchived',
        'session.moved',
        'session.renamed'
      ] as const
    ).map((type) => context.data.on(type, changed)),
    ...(
      [
        'session.execution.started',
        'session.execution.succeeded',
        'session.execution.failed',
        'session.execution.interrupted'
      ] as const
    ).map((type) =>
      context.data.on(type, (event) => {
        controller.invalidate(event.data.sessionID);
        changed();
      })
    )
  ];

  return {
    memory,
    setMemory,
    scope,
    toggleScope,
    origin,
    setOrigin,
    now,
    setNow,
    location,
    resolveProject,
    /** "This project" under the browser, as a list scope. */
    resolveScope: projectOf,
    rpc,
    rpcOptions,
    running,
    controller,
    data,
    counts: lists.counts,
    doneGroups: lists.doneGroups,
    groups: lists.groups,
    pullGroups: lists.pullGroups,
    rows: lists.rows,
    /** Merges a patch into the remembered browser state. */
    remember(patch: Partial<PageMemory>) {
      setMemory((draft) => {
        Object.assign(draft, patch);
      });
    },
    sync,
    /**
     * Starts the next open from an empty search. Coming back from a peek skips this: the user
     * is walking through the results.
     */
    clearSearch() {
      setMemory((draft) => {
        draft.query = '';
      });
      controller.search('', false, scope());
    },
    dispose() {
      clearTimeout(reloadTimer);
      for (const off of offs) off();
      controller.dispose();
      lists.dispose();
    }
  };
}

export type BrowserModel = ReturnType<typeof createBrowserModel>;
