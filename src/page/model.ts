import path from 'node:path';
import type { LocationPublicInfo, LocationRef } from '@opencode/client';
import type { Plugin } from '@opencode/plugin/tui';
import type { Route } from '@opencode/plugin/tui/context';
import { createMemo, createRoot, createSignal } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { Pins } from '../pins.js';
import { type SearchScope, SuperSessions } from '../rpc.js';
import {
  createPageController,
  type Group,
  groupSessions,
  type PageData,
  type PageMemory,
  type PageScope,
  type PageView,
  rowsOf
} from './state.js';

// A reload waits for a burst of session events to settle.
const RELOAD_DELAY = 500;
// Reopening within this window shows the cached lists without asking the server again.
const FRESH_FOR = 30_000;

/**
 * Sessions, refs and browser state shared by the overlay and the peek keys. It lives as long as
 * the plugin, so reopening the browser draws the cached lists at once and refreshes them in the
 * background.
 */
export function createBrowserModel(context: Plugin.Context, pins: Pins, isOpen: () => boolean) {
  const client = context.client;
  const [memory, setMemory] = context.storage.memory<PageMemory>('page', {
    initial: { query: '', view: 'active', selected: undefined, scroll: 0 }
  });
  const [prefs, setPrefs] = context.storage.store('page-prefs', {
    initial: { allProjects: false }
  });
  const scope = (): PageScope => (prefs.allProjects ? 'all' : 'project');
  const [origin, setOrigin] = createSignal<Route>({ type: 'home' });
  const [now, setNow] = createSignal(Date.now());

  // The browser opens over a session, home or a plugin page; "this project" means the project of
  // the session underneath, like the built-in list.
  const location = (): LocationRef => {
    const route = origin();
    const from = route.type === 'session' ? context.data.session.get(route.sessionID) : undefined;
    return from?.location ?? context.location ?? context.data.location.default();
  };
  const infos = new Map<string, Promise<LocationPublicInfo>>();
  const resolveLocation = () => {
    const directory = location().directory;
    let info = infos.get(directory);
    if (info === undefined) {
      info = client.location.get({ location: { directory } });
      // A failed lookup is retried on the next open instead of failing every open after it.
      info.catch(() => infos.delete(directory));
      infos.set(directory, info);
    }
    return info;
  };
  // Same rule as the built-in list: the global project (no repository) filters by directory,
  // a real project by project id and the subpath of the directory inside it.
  const searchScope = async (target: PageScope): Promise<SearchScope> => {
    if (target === 'all') return { type: 'all' };
    const info = await resolveLocation();
    if (info.project.id === 'global') return { type: 'directory', directory: info.directory };
    return {
      type: 'project',
      project: info.project.id,
      subpath: path.relative(info.project.directory, info.directory).replaceAll('\\', '/')
    };
  };
  const listScope = async (target: PageScope) => {
    const value = await searchScope(target);
    if (value.type === 'project') return { project: value.project, subpath: value.subpath };
    if (value.type === 'directory') return { directory: value.directory };
    return {};
  };
  const rpc = () => context.client.rpc(SuperSessions);
  const rpcOptions = () => ({ location: { directory: location().directory } });
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
      refresh: (sessionIDs) => rpc().refresh({ sessionIDs }, rpcOptions()),
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

  const groupsFor = (view: PageView) =>
    groupSessions({
      view,
      sessions: view === 'archived' ? data.archived : data.active,
      refs: data.refs,
      extra: data.extra,
      running,
      pins: pins.ids(),
      now: now()
    });
  // The memos get a root of their own. Only they live in it: the host resolves keymap, slot and
  // storage providers from the owner the plugin's setup runs under, which a root would hide.
  const lists = createRoot((dispose) => {
    const activeGroups = createMemo(() => groupsFor('active'));
    const doneGroups = createMemo(() => groupsFor('done'));
    const archivedGroups = createMemo(() => groupsFor('archived'));
    /** Groups of the list on screen: the search results, or the current view. */
    const groups = createMemo((): Group[] => {
      if (data.search)
        return data.search.sessions.length > 0 ? [{ sessions: data.search.sessions }] : [];
      if (memory.view === 'done') return doneGroups();
      if (memory.view === 'archived') return archivedGroups();
      return activeGroups();
    });
    return {
      dispose,
      doneGroups,
      groups,
      rows: createMemo(() => rowsOf(groups())),
      counts: createMemo(() => ({
        active: rowsOf(activeGroups()).length,
        done: rowsOf(doneGroups()).length,
        archived: rowsOf(archivedGroups()).length
      }))
    };
  });

  // What the cached lists were loaded for, and when.
  let loadedFor: string | undefined;
  let loadedAt = 0;
  let dirty = false;
  const reload = () => {
    loadedFor = `${scope()}:${location().directory}`;
    loadedAt = Date.now();
    dirty = false;
    return controller.load(scope());
  };
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  /** Reloads soon while the browser is open; otherwise the next open reloads. */
  const changed = () => {
    if (!isOpen()) {
      dirty = true;
      return;
    }
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void reload(), RELOAD_DELAY);
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
    prefs,
    setPrefs,
    scope,
    origin,
    setOrigin,
    now,
    setNow,
    location,
    resolveLocation,
    rpc,
    rpcOptions,
    running,
    controller,
    data,
    counts: lists.counts,
    doneGroups: lists.doneGroups,
    groups: lists.groups,
    rows: lists.rows,
    /** Merges a patch into the remembered browser state. */
    remember(patch: Partial<PageMemory>) {
      setMemory((draft) => {
        Object.assign(draft, patch);
      });
    },
    /**
     * Brings the lists up to date for the current scope and location. Cached lists for the same
     * scope and location stay on screen while a reload runs; a different project starts over.
     * Returns the reload, or undefined when the cache is fresh.
     */
    sync(): Promise<void> | undefined {
      const key = `${scope()}:${location().directory}`;
      if (key !== loadedFor) {
        if (loadedFor !== undefined) controller.reset();
        return reload();
      }
      if (dirty || Date.now() - loadedAt > FRESH_FOR) return reload();
      return undefined;
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
