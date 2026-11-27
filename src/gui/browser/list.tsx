import type { SessionInfo } from '@opencode/client';
import { type Context, type Persisted, type ServerRef, usePlugin } from '@opencode/plugin/gui';
import {
  createComputed,
  createMemo,
  createSelector,
  createSignal,
  For,
  type JSX,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack
} from 'solid-js';
import { closeSessionTab } from '../../host/gui.js';
import { isBusy, isUnread, setArchived } from '../../host/session-info.js';
import {
  keepSelection,
  moveSelection,
  type PageView,
  type PullRow,
  rowsOf
} from '../../page/state.js';
import { rpcOn } from '../server.js';
import type { Machines } from './machines.js';
import type { BrowserPrefs } from './prefs.js';
import {
  ALL_KEY,
  type ProjectEntry,
  type ProjectSource,
  type Projects,
  pickKey
} from './projects.js';
import type { BrowserView } from './view.js';

// The session list both browser views draw, the dialog and the side tab: its keyed groups, the
// selection, the project pick and the row actions, over the machines' shared models.

export type { BrowserView };

/**
 * A group of the list, the same object on every publish of its title, so the group's block and
 * the rows in it stay mounted. `title` is undefined for the untitled group of a plain list.
 */
export interface ListGroup {
  readonly title: string | undefined;
}

/** Row height in px a skipped group is laid out with until it was drawn once (browser.css). */
const ROW_ESTIMATE = 40;

/**
 * Rows a list mounts when it shows: about what the dialog at full screen height shows at once,
 * since most rows carry detail lines; when they fall short, the first idle step fills in. A
 * list of 400 rows mounted about 13,000 elements in the open's task, and the window then spent
 * about 100 ms styling them, 90 ms on every layout while the dialog stayed open, and 200 ms
 * styling them again on close.
 */
const FIRST_ROWS = 30;

/** Rows each later step mounts, while the end of the mounted rows is near the visible list. */
const STEP_ROWS = 30;

/** How far below the visible list the end of the mounted rows asks for the next step. */
const AHEAD = '0px 0px 100% 0px';

/** How long the pointer rests on a row before the row is selected and previewed. */
export const ROW_DWELL = 300;

/**
 * The one pending hover selection of a list: `start` replaces the pending one, so moving across
 * rows selects nothing until the pointer rests on one, and `cancel` drops it, as leaving the row
 * or a key moving the selection does. Call it under the list's owner.
 */
export function createDwell(delay = ROW_DWELL) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  onCleanup(cancel);
  return {
    start(run: () => void) {
      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        run();
      }, delay);
    },
    cancel
  };
}

/** Runs `run` once the window is idle, or within 200 ms; returns the cancel. */
function whenIdle(run: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(run, { timeout: 200 });
    return () => cancelIdleCallback(handle);
  }
  const timer = setTimeout(run, 16);
  return () => clearTimeout(timer);
}

/**
 * How many rows of a list are mounted: {@link FIRST_ROWS} when it shows, then
 * {@link STEP_ROWS} more per idle moment while the spacer under the mounted rows is within one
 * list height of the visible part, and always up to past `wanted`, the row the keys selected.
 * Rows mount and never unmount until `reset` changes, so a row keeps its element, its hover and
 * its scroll place. Call it under the list's owner.
 */
export function createRowWindow(options: {
  readonly total: () => number;
  readonly wanted: () => number;
  readonly reset: () => unknown;
}) {
  const [limit, setLimit] = createSignal(FIRST_ROWS);
  createComputed(on(options.reset, () => setLimit(FIRST_ROWS), { defer: true }));
  // A keyboard move past the mounted rows mounts the rows up to it before the move scrolls.
  createComputed(() => {
    const wanted = options.wanted();
    if (wanted >= untrack(limit)) setLimit(wanted + STEP_ROWS);
  });
  const remaining = createMemo(() => Math.max(0, options.total() - limit()));
  // Whether the spacer is near the visible rows. Without IntersectionObserver every row mounts,
  // one step per idle moment.
  let near = typeof IntersectionObserver === 'undefined';
  let cancel: (() => void) | undefined;
  const schedule = () => {
    if (cancel !== undefined || !near || untrack(remaining) === 0) return;
    cancel = whenIdle(() => {
      cancel = undefined;
      if (!near) return;
      setLimit((value) => Math.min(untrack(options.total), value + STEP_ROWS));
      // The observer reports the moved spacer after the next layout, before this runs again.
      schedule();
    });
  };
  onCleanup(() => cancel?.());
  /** Watches the spacer under the mounted rows, in the list's scroll box. */
  const watch = (spacer: HTMLElement) => {
    if (typeof IntersectionObserver === 'undefined') return schedule();
    const observer = new IntersectionObserver(
      (entries) => {
        near = entries.at(-1)?.isIntersecting ?? near;
        schedule();
      },
      { root: spacer.closest('[role="listbox"]'), rootMargin: AHEAD }
    );
    observer.observe(spacer);
    onCleanup(() => {
      observer.disconnect();
      near = false;
    });
  };
  return { limit, remaining, watch };
}

/**
 * The room the rows a list has not mounted yet would take, so the scroll bar shows the whole
 * list; it asks for more rows as it nears the visible part.
 */
function MoreRows(props: { rows: number; watch: (spacer: HTMLElement) => void }) {
  let spacer: HTMLDivElement | undefined;
  // After the insert, when the spacer is in the list and `closest` finds the scroll box.
  onMount(() => {
    if (spacer !== undefined) props.watch(spacer);
  });
  return (
    <div
      ref={spacer}
      class="ss-more"
      aria-hidden="true"
      style={{ height: `${props.rows * ROW_ESTIMATE}px` }}
    />
  );
}

/** Whether two builds of a pull request row show the same thing. */
function samePull(a: PullRow, b: PullRow): boolean {
  return (
    a.state === b.state &&
    a.sessions.length === b.sessions.length &&
    a.sessions.every((session, index) => session === b.sessions[index])
  );
}

/** A row or pull request the user picked; `id` is a session id or a pull request's key. */
interface Choice {
  readonly id: string | undefined;
}

/** No pick yet: the list selects its first row. */
const NO_PICK: Choice = { id: undefined };

/** The selection derived from a list and the user's picks, with what it was derived from. */
interface Selection<T> {
  readonly list: readonly T[];
  readonly pick: Choice;
  readonly id: string | undefined;
}

/**
 * The view's rows as keyed groups, and the selection over them. Call it under the view's owner.
 * Rows are the store's own session objects and groups are kept by title, so a publish (refs
 * arriving, a run ending, a project's full list after its share from memory) only updates the
 * rows that changed instead of building every row again.
 */
export function createListState(browser: BrowserView, view: () => PageView) {
  const pullView = () => view() === 'pulls';
  const rows = createMemo(() => rowsOf(browser.groups()));
  const pulls = createMemo(() => browser.pullGroups().flatMap((group) => group.pulls));
  const known = new Map<string, ListGroup>();
  /** The group object of a title in a list (`sessions` or `pulls`), the same on every publish. */
  const groupOf = (list: string, title: string | undefined): ListGroup => {
    const key = `${list}\n${title ?? ''}`;
    let found = known.get(key);
    if (found === undefined) {
      found = { title };
      known.set(key, found);
    }
    return found;
  };
  const sessionGroups = createMemo(() =>
    browser.groups().map((group) => groupOf('sessions', group.title))
  );
  const sessionsIn = createMemo(
    () =>
      new Map(browser.groups().map((group) => [groupOf('sessions', group.title), group.sessions]))
  );
  // Pull request rows are built anew on each publish; one whose fields are unchanged is kept.
  const pullItems = createMemo(
    (previous: ReadonlyMap<string, PullRow>): ReadonlyMap<string, PullRow> => {
      const next = new Map<string, PullRow>();
      for (const item of pulls()) {
        const kept = previous.get(item.key);
        next.set(item.key, kept !== undefined && samePull(kept, item) ? kept : item);
      }
      return next;
    },
    new Map()
  );
  const pullGroups = createMemo(() =>
    browser.pullGroups().map((group) => groupOf('pulls', group.title))
  );
  const pullsIn = createMemo(
    () =>
      new Map(
        browser
          .pullGroups()
          .map((group) => [
            groupOf('pulls', group.title),
            group.pulls.map((item) => pullItems().get(item.key) ?? item)
          ])
      )
  );

  // The user's last pick of a row and of a pull request. A new object per pick, so picking the
  // same id again, or clearing an already clear one, still counts as a pick.
  const [rowPick, setRowPick] = createSignal<Choice>(NO_PICK, { equals: false });
  const [pullPick, setPullPick] = createSignal<Choice>(NO_PICK, { equals: false });
  // Rows change under the selection when sessions are archived, restored or become Done: the row
  // that took the selected one's place is selected. Clearing the selection, as switching views
  // and typing do, selects the first row. An empty list keeps the selection for the next one.
  const rowSelection = createMemo<Selection<SessionInfo>>(
    (previous) => {
      const next = rows();
      const picked = rowPick();
      const id = picked === previous.pick ? previous.id : picked.id;
      return {
        list: next,
        pick: picked,
        id: next.length === 0 ? id : keepSelection(previous.list, next, id)
      };
    },
    { list: [], pick: NO_PICK, id: undefined }
  );
  const pullSelection = createMemo<Selection<PullRow>>(
    (previous) => {
      const next = pulls();
      const picked = pullPick();
      const key = picked === previous.pick ? previous.id : picked.id;
      if (next.length === 0 || next.some((item) => item.key === key)) {
        return { list: next, pick: picked, id: key };
      }
      const index = previous.list.findIndex((item) => item.key === key);
      const kept = next[index === -1 ? 0 : Math.min(index, next.length - 1)]?.key;
      return { list: next, pick: picked, id: kept };
    },
    { list: [], pick: NO_PICK, id: undefined }
  );
  const selected = () => rowSelection().id;
  const pull = () => pullSelection().id;
  // A selection change updates only the row it leaves and the row it reaches.
  const isSelected = createSelector(selected);
  const isPull = createSelector(pull);
  const selectedPull = () => pulls().find((item) => item.key === pull());

  return {
    rows,
    pulls,
    sessionGroups,
    sessionsIn,
    pullGroups,
    pullsIn,
    selected,
    pull,
    /** Whether a session's row is the selected one, read per row. */
    isSelected,
    /** Whether a pull request's row is the selected one, read per row. */
    isPull,
    selectedPull,
    /** Selects a row; undefined selects the first. */
    setSelected: (id: string | undefined) => setRowPick({ id }),
    /** Selects a pull request; undefined selects the first. */
    setPull: (key: string | undefined) => setPullPick({ id: key }),
    /** The session the keys act on: the selected row, or the selected pull request's newest. */
    current: (): SessionInfo | undefined =>
      pullView() ? selectedPull()?.sessions[0] : rows().find((row) => row.id === selected()),
    /** Moves the selection by `delta` rows, clamped to the list. */
    move(delta: number) {
      if (!pullView()) return setRowPick({ id: moveSelection(rows(), selected(), delta) });
      const list = pulls();
      const index = list.findIndex((item) => item.key === pull());
      const next = list[Math.min(list.length - 1, Math.max(0, (index === -1 ? 0 : index) + delta))];
      setPullPick({ id: next?.key });
    }
  };
}

export type ListState = ReturnType<typeof createListState>;

/**
 * What a row shows about a session and what its buttons do, over its own server's live data:
 * its latest synced copy, running and waiting state, archive and Done, each through the client
 * and RPC of the server the row came from. `fallback` is the server of a row the view no longer
 * lists, such as one that just left the list.
 */
export function createRowActions(ctx: Context, browser: BrowserView, fallback: () => ServerRef) {
  const toast = (title: string) => ctx.toast.show({ title, variant: 'error' });
  /** The server a session's row came from. */
  const serverOf = (id: string): ServerRef => browser.serverOf(id) ?? fallback();
  /** The session's latest copy its server synced, for a title renamed while the list shows. */
  const live = (session: SessionInfo): SessionInfo =>
    serverOf(session.id).data.session.get(session.id) ?? session;
  /** Whether the session or one of its subagents runs. */
  const running = (session: SessionInfo) => isBusy(live(session)) || browser.isRunning(session.id);
  /** What the session waits on the user for, as the app's own lists know it. */
  const waiting = (id: string) => waitingFor(serverOf(id).data.session, id);
  /**
   * Archives the session, or restores it when it is archived. An archive closes the session's tab
   * unless `closeTabOnArchive` is off; a restore keeps auto-archive from taking the session
   * again, as the TUI's restores do.
   */
  const archive = async (session: SessionInfo | undefined) => {
    if (session === undefined) return;
    const model = browser.modelOf(session.id);
    const server = model?.server ?? fallback();
    // The row's own copy: the controller moves it between the lists right after each update.
    const archived = session.time.archived === undefined;
    try {
      await setArchived(server.client, session.id, archived);
    } catch {
      toast(ctx.t(archived ? 'browser.archive.failed' : 'browser.restore.failed'));
      return;
    }
    model?.controller.archived(session.id, archived, Date.now());
    if (archived && ctx.options.closeTabOnArchive !== false) {
      closeSessionTab(ctx.tabs, { server: server.id, id: session.id });
    }
    // Without the server plugin there is no auto-archive to stop.
    if (!archived && model !== undefined) {
      void model
        .rpcOptions()
        .then((options) => rpcOn(server)['archive.exclude']({ sessionIDs: [session.id] }, options))
        .catch(() => {});
    }
  };
  /** Marks the session Done, or not Done when it is Done by any means. */
  const toggleDone = async (session: SessionInfo | undefined) => {
    if (session === undefined) return;
    const model = browser.modelOf(session.id);
    if (model === undefined || model.missing()) return;
    const done = !browser.isDone(session.id);
    try {
      await rpcOn(model.server)['done.set'](
        { sessionID: session.id, done },
        await model.rpcOptions()
      );
    } catch {
      toast(ctx.t(done ? 'browser.done.failed' : 'browser.notDone.failed'));
      return;
    }
    void model.controller.refresh([session.id], browser.signal());
  };
  return { serverOf, live, running, waiting, archive, toggleDone };
}

export type RowActions = ReturnType<typeof createRowActions>;

/** Props of {@link RowButtons}. */
export interface RowButtonsProps {
  readonly session: SessionInfo;
  readonly browser: BrowserView;
  readonly actions: RowActions;
  /** The chord each button's tooltip shows, if the view has one. */
  readonly keys?: (action: 'archive' | 'done') => string | undefined;
}

/** The hover buttons of a session row: archive or restore, and Done while not archived. */
export function RowButtons(props: RowButtonsProps) {
  const ctx = usePlugin();
  const keys = (action: 'archive' | 'done') => {
    const chord = props.keys?.(action);
    return chord === undefined ? [] : ctx.keybinds.keys(chord);
  };
  const archived = () => props.session.time.archived !== undefined;
  const done = () => props.browser.isDone(props.session.id);
  return (
    <>
      <ctx.ui.Tooltip
        value={ctx.t(archived() ? 'browser.restore' : 'browser.archive')}
        keys={keys('archive')}
      >
        <ctx.ui.IconButton
          icon={archived() ? 'outline-undo' : 'archive'}
          size="small"
          label={ctx.t(archived() ? 'browser.restore' : 'browser.archive')}
          onClick={(event) => {
            event.stopPropagation();
            void props.actions.archive(props.session);
          }}
        />
      </ctx.ui.Tooltip>
      {/* Done is the server plugin's mark: without it on the row's server there is nothing to set. */}
      <Show when={!archived() && !props.browser.missing(props.session.id)}>
        <ctx.ui.Tooltip
          value={ctx.t(done() ? 'browser.markNotDone' : 'browser.markDone')}
          keys={keys('done')}
        >
          <ctx.ui.IconButton
            icon="circle-check"
            size="small"
            pressed={done()}
            label={ctx.t(done() ? 'browser.markNotDone' : 'browser.markDone')}
            onClick={(event) => {
              event.stopPropagation();
              void props.actions.toggleDone(props.session);
            }}
          />
        </ctx.ui.Tooltip>
      </Show>
    </>
  );
}

/**
 * What the session waits on the user for, by its server's synced permission requests and
 * questions, which the app's data keeps current from `permission.asked`, `permission.replied`,
 * `form.created`, `form.replied` and `form.cancelled` (packages/client/src/solid/data.ts:1451-1463
 * and :1523 at v2.4.2). The browser's waiting marker and the side tab's Working section read it.
 */
export function waitingFor(
  sessions: ServerRef['data']['session'],
  id: string
): 'permission' | 'question' | undefined {
  if ((sessions.permission.list(id)?.length ?? 0) > 0) return 'permission';
  if ((sessions.form.list(id)?.length ?? 0) > 0) return 'question';
  return undefined;
}

/**
 * What a session shows at its end by its own server's live data: waiting on a permission or a
 * question, running, unread, or nothing.
 */
export function sessionStatus(machines: Machines, server: ServerRef, session: SessionInfo) {
  const live = server.data.session.get(session.id) ?? session;
  if (waitingFor(server.data.session, session.id) !== undefined) return 'waiting' as const;
  if (isBusy(live) || (machines.model(server.id)?.isRunning(session.id) ?? false)) {
    return 'running' as const;
  }
  return isUnread(live) ? ('unread' as const) : undefined;
}

/** What the projects read of the machines: every listed server's model's lists. */
export function projectSources(machines: Machines) {
  return () =>
    machines.models().map(
      (model): ProjectSource => ({
        server: model.server,
        every: model.everyActive,
        want: model.wantEveryActive,
        active: () => (model.data.status === 'ready' ? model.data.active : undefined),
        archived: () => (model.data.status === 'ready' ? model.data.archived : undefined)
      })
    );
}

/**
 * The dialog's project pick: the key shown as picked, and picking a project or All. A pick
 * outlasts the dialog: `all`, or `project`, which the next open reads as the routed project.
 * Only a pick writes, so the older `rail` and `allProjects` are read once and dropped here.
 * `picked` runs after each new pick, for the dialog to reset its selection.
 */
export function createPick(
  machines: Machines,
  projects: Projects,
  prefs: Persisted<BrowserPrefs, BrowserPrefs>,
  picked: () => void
) {
  const pickedKey = () => pickKey(machines.pick(), projects.routedKey());
  /** Picks a project, or every project for undefined. */
  const pick = (project: ProjectEntry | undefined) => {
    if ((project?.key ?? ALL_KEY) === pickedKey()) return;
    machines.select(project === undefined ? { type: 'all' } : project.selection);
    picked();
    prefs.update((draft) => {
      draft.pick = project === undefined ? 'all' : 'project';
      delete draft.rail;
      delete draft.allProjects;
      return undefined;
    });
  };
  return { pickedKey, pick };
}

/** Props of {@link ListBody}. */
export interface ListBodyProps {
  readonly browser: BrowserView;
  readonly list: ListState;
  readonly view: PageView;
  /** Draws one session row. */
  readonly session: (session: SessionInfo) => JSX.Element;
  /** Draws one pull request of the Pull requests view. */
  readonly pull: (pull: PullRow) => JSX.Element;
}

/**
 * What the list shows: the spinner while nothing is in memory for the scope, the error with
 * Retry, the empty view's note, else the view's groups of rows. A load over rows on screen draws
 * a thin bar over them instead of the spinner.
 */
export function ListBody(props: ListBodyProps) {
  const ctx = usePlugin();
  const store = props.browser.data;
  const pullView = () => props.view === 'pulls';
  /** The note of the view's empty list. */
  const emptyNote = () =>
    store.search !== undefined && !pullView()
      ? ctx.t('browser.empty.search')
      : ctx.t(`browser.empty.${props.view}`);
  const rows = createRowWindow({
    total: () => (pullView() ? props.list.pulls().length : props.list.rows().length),
    wanted: () =>
      pullView()
        ? props.list.pulls().findIndex((item) => item.key === props.list.pull())
        : props.list.rows().findIndex((session) => session.id === props.list.selected()),
    reset: () => props.view
  });
  /**
   * The mounted share of each group, in list order: groups take the window's rows in turn, and a
   * group past the window is left out.
   */
  const cut = <T,>(groups: readonly ListGroup[], items: ReadonlyMap<ListGroup, readonly T[]>) => {
    let left = rows.limit();
    const shown = new Map<ListGroup, readonly T[]>();
    for (const group of groups) {
      if (left <= 0) break;
      const all = items.get(group) ?? [];
      const part = all.length <= left ? all : all.slice(0, left);
      left -= part.length;
      shown.set(group, part);
    }
    return shown;
  };
  const shownSessions = createMemo(() => cut(props.list.sessionGroups(), props.list.sessionsIn()));
  const shownPulls = createMemo(() => cut(props.list.pullGroups(), props.list.pullsIn()));
  return (
    <>
      <Show when={props.browser.loading() && store.status === 'ready'}>
        <div class="ss-progress" aria-hidden="true" />
      </Show>
      {/* A machine that failed or is not connected says so above the others' rows. */}
      <Show when={store.status === 'ready'}>
        <For each={props.browser.failedOn()}>
          {(server) => (
            <div class="ss-machine-note" data-machine-note={server.id}>
              <p class="ss-note">{ctx.t('browser.machine.failed', { machine: server.name })}</p>
              <ctx.ui.Button
                variant="neutral"
                size="small"
                onClick={() => void props.browser.load(true)}
              >
                {ctx.t('browser.retry')}
              </ctx.ui.Button>
            </div>
          )}
        </For>
      </Show>
      <For each={props.browser.offline()}>
        {(server) => (
          <p class="ss-note" data-machine-note={server.id}>
            {ctx.t('browser.machine.offline', { machine: server.name })}
          </p>
        )}
      </For>
      <Switch>
        <Match when={store.status === 'loading'}>
          <div class="ss-state">
            <ctx.ui.Loader size="large" />
          </div>
        </Match>
        <Match when={store.status === 'error'}>
          <div class="ss-state">
            <p class="ss-note">{ctx.t('browser.error')}</p>
            <ctx.ui.Button
              variant="neutral"
              size="small"
              onClick={() => void props.browser.load(true)}
            >
              {ctx.t('browser.retry')}
            </ctx.ui.Button>
          </div>
        </Match>
        <Match when={pullView()}>
          <Show
            when={props.list.pulls().length > 0}
            fallback={<p class="ss-note">{emptyNote()}</p>}
          >
            <For each={[...shownPulls().keys()]}>
              {(group) => (
                <GroupBlock group={group} rows={shownPulls().get(group)?.length ?? 0}>
                  <For each={shownPulls().get(group) ?? []}>{props.pull}</For>
                </GroupBlock>
              )}
            </For>
            <Show when={rows.remaining() > 0}>
              <MoreRows rows={rows.remaining()} watch={rows.watch} />
            </Show>
          </Show>
        </Match>
        <Match when={true}>
          <Show when={props.list.rows().length > 0} fallback={<p class="ss-note">{emptyNote()}</p>}>
            <For each={[...shownSessions().keys()]}>
              {(group) => (
                <GroupBlock group={group} rows={shownSessions().get(group)?.length ?? 0}>
                  <For each={shownSessions().get(group) ?? []}>{props.session}</For>
                </GroupBlock>
              )}
            </For>
            <Show when={rows.remaining() > 0}>
              <MoreRows rows={rows.remaining()} watch={rows.watch} />
            </Show>
          </Show>
        </Match>
      </Switch>
    </>
  );
}

/**
 * The note that a listed server runs no server plugin, once for every such server. With more
 * than one machine it names them, since the other machines' rows keep their refs.
 */
export function PluginNote(props: { browser: BrowserView; machines: Machines }) {
  const ctx = usePlugin();
  const text = () => {
    const missing = props.browser.missingOn();
    if (props.machines.servers().length < 2) return ctx.t('browser.pluginMissing');
    return ctx.plural('browser.pluginMissingOn', missing.length, {
      machines: missing.map((server) => server.name).join(', ')
    });
  };
  return (
    <Show when={props.browser.missingOn().length > 0}>
      <p class="ss-note" data-note="plugin-missing">
        {text()}
      </p>
    </Show>
  );
}

/**
 * A group's block: its header, then its rows. The block, not each row, skips layout off screen
 * (`content-visibility` in browser.css), laid out at `rows` times {@link ROW_ESTIMATE} until it
 * was drawn once and at its real height after, so no row is ever taller than its content.
 */
export function GroupBlock(props: { group: ListGroup; rows: number; children: JSX.Element }) {
  return (
    <div
      class="ss-group"
      style={{ 'contain-intrinsic-size': `auto ${props.rows * ROW_ESTIMATE + 32}px` }}
    >
      <Show when={props.group.title}>{(title) => <GroupTitle title={title()} />}</Show>
      {props.children}
    </div>
  );
}

/**
 * A group header, such as a day or Running, drawn as the app sidebar's section headers are
 * (browser.css), with the group's name translated when the catalog has it.
 */
export function GroupTitle(props: { title: string }) {
  const ctx = usePlugin();
  const key = () => `browser.group.${props.title}`;
  const text = () => {
    const translated = ctx.t(key());
    return translated === key() ? props.title : translated;
  };
  return <h3 class="ss-group-title">{text()}</h3>;
}
