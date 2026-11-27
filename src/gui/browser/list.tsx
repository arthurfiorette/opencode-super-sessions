import type { SessionInfo } from '@opencode/client';
import { type Context, type Persisted, type ServerRef, usePlugin } from '@opencode/plugin/gui';
import { createMemo, createSignal, For, type JSX, Match, Show, Switch } from 'solid-js';
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
import { ALL_KEY, type Rail, type RailMachine, type RailTile, selectionKey } from './rail.js';
import type { BrowserView } from './view.js';

// The session list both browser views draw, the dialog and the side tab: its keyed groups, the
// selection, the rail pick and the row actions, over the machines' shared models.

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
  const waiting = (id: string): 'permission' | 'question' | undefined => {
    const sessions = serverOf(id).data.session;
    if ((sessions.permission.list(id)?.length ?? 0) > 0) return 'permission';
    if ((sessions.form.list(id)?.length ?? 0) > 0) return 'question';
    return undefined;
  };
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
 * What the rail reads of the machines: every listed server's model, and the running and unread
 * state of a session by its own server's live data.
 */
export function railSources(machines: Machines) {
  const live = (server: ServerRef, session: SessionInfo): SessionInfo =>
    server.data.session.get(session.id) ?? session;
  return {
    machines: () =>
      machines.models().map(
        (model): RailMachine => ({
          server: model.server,
          every: model.everyActive,
          want: model.wantEveryActive,
          active: () => (model.data.status === 'ready' ? model.data.active : undefined)
        })
      ),
    running: (server: ServerRef, session: SessionInfo) =>
      isBusy(live(server, session)) || (machines.model(server.id)?.isRunning(session.id) ?? false),
    unread: (server: ServerRef, session: SessionInfo) => {
      const sessions = server.data.session;
      return (
        isUnread(live(server, session)) ||
        (sessions.permission.list(session.id)?.length ?? 0) > 0 ||
        (sessions.form.list(session.id)?.length ?? 0) > 0
      );
    }
  };
}

/**
 * The rail pick of a view: the tile shown as picked, and picking one, which every view follows.
 * A pick outlasts the window's views: `all`, or `project`, which the next open reads as the
 * routed project. Only a pick writes, so the old `allProjects` is read once and dropped here.
 * `picked` runs after each new pick, for the view to reset its selection.
 */
export function createRailPick(
  machines: Machines,
  rail: Rail,
  prefs: Persisted<BrowserPrefs, BrowserPrefs>,
  picked: () => void
) {
  const pickedTile = () => selectionKey(machines.pick(), rail.routedKey());
  const pickTile = (tile: RailTile) => {
    if (tile.key === pickedTile()) return;
    machines.select(tile.selection);
    picked();
    prefs.update((draft) => {
      draft.rail = tile.key === ALL_KEY ? 'all' : 'project';
      delete draft.allProjects;
      return undefined;
    });
  };
  /** Picks the tile `delta` places along the rail, across machines, stopping at its ends. */
  const moveTile = (delta: number) => {
    const tiles = rail.tiles();
    const index = tiles.findIndex((tile) => tile.key === pickedTile());
    const next = tiles[Math.min(tiles.length - 1, Math.max(0, (index === -1 ? 0 : index) + delta))];
    if (next !== undefined) pickTile(next);
  };
  return { pickedTile, pickTile, moveTile };
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
            <For each={props.list.pullGroups()}>
              {(group) => (
                <GroupBlock group={group} rows={props.list.pullsIn().get(group)?.length ?? 0}>
                  <For each={props.list.pullsIn().get(group) ?? []}>{props.pull}</For>
                </GroupBlock>
              )}
            </For>
          </Show>
        </Match>
        <Match when={true}>
          <Show when={props.list.rows().length > 0} fallback={<p class="ss-note">{emptyNote()}</p>}>
            <For each={props.list.sessionGroups()}>
              {(group) => (
                <GroupBlock group={group} rows={props.list.sessionsIn().get(group)?.length ?? 0}>
                  <For each={props.list.sessionsIn().get(group) ?? []}>{props.session}</For>
                </GroupBlock>
              )}
            </For>
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
