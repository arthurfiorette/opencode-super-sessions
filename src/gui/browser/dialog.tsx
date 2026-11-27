import type { SessionInfo } from '@opencode/client';
import {
  type Context,
  createLatest,
  type DialogHandle,
  type Persisted,
  type ServerRef,
  type SessionRef,
  usePlugin
} from '@opencode/plugin/gui';
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack
} from 'solid-js';
import {
  closeSessionTab,
  openSession,
  openWebLink,
  type ProjectLook,
  RAIL_KEYS
} from '../../host/gui.js';
import { isBusy, isUnread, setArchived } from '../../host/session-info.js';
import {
  keepSelection,
  moveSelection,
  type PageScope,
  type PageView,
  type PullRow,
  rowsOf,
  VIEWS
} from '../../page/state.js';
import { refUrl } from '../../refs/look.js';
import { refKey } from '../../refs/ref.js';
import { rowRefs, workLinks } from '../../refs/summary.js';
import { type LinkScope, LinkScopeProvider } from '../links.js';
import { Octicon, type OcticonName } from '../octicons.js';
import { sessionProjectLook } from '../project-avatar.js';
import type { RefsStore } from '../refs-store.js';
import { rpcOn, serverFor } from '../server.js';
import { type BrowserModel, type BrowserTarget, createBrowserView } from './model.js';
import { type BrowserPrefs, opensOnAll } from './prefs.js';
import { Preview } from './preview.js';
import { ALL_KEY, createRail, type RailSelection, type RailTile, selectionKey } from './rail.js';
import { ProjectRail } from './rail-view.js';
import { PullItem, SessionRow } from './row.js';

// The session browser dialog: the TUI's browser (src/page/view.ts) in the window, on the same
// controller and grouping. Keys, checked against the app's and the text field's (see `onKeyDown`):
// up and down move, tab and shift+tab switch views, enter opens in a focused tab and mod+enter in
// the background, alt+s archives or restores, alt+q marks Done or not Done, alt+g opens the
// session's pull request, issue or link, alt+up and alt+down move along the project rail and f5
// reloads the session from its forge.

/** The dialog's chords without a letter that its hints show. */
const KEYS = {
  open: 'enter',
  previousProject: RAIL_KEYS.previous,
  nextProject: RAIL_KEYS.next
} as const;

/** The TUI's tab icons (`tabLabel` in src/page/view.ts); Active has none. */
const TAB_ICONS: Record<PageView, OcticonName | undefined> = {
  active: undefined,
  done: 'check-circle',
  archived: 'archive',
  pulls: 'git-pull-request'
};

/**
 * The orange end of the title's fade, by app mode: the TUI's (`TITLE_ORANGE` in
 * src/page/icons.ts). The app has no orange variable, so it is a fixed color here too; the fade
 * starts from the app's warning color, as the TUI's starts from the theme's.
 */
const TITLE_ORANGE = { dark: '#fe8019', light: '#af3a03' } as const;

/** The preview's share of the dialog's width: the TUI's `previewWidth` option, 0.4 by default. */
function previewShareOf(value: unknown): number {
  return typeof value === 'number' && value >= 0.2 && value <= 0.7 ? value : 0.4;
}

/** What an `alt` chord does. */
type AltAction = 'archive' | 'done' | 'web';

/**
 * The `alt` chords by physical key. On macOS `alt` turns a letter into another character
 * (`alt+s` types `ß`), so `event.key` cannot name them; `event.code` names the key by its QWERTY
 * position on every layout.
 */
const ALT_CODES: Record<string, AltAction> = {
  KeyS: 'archive',
  KeyQ: 'done',
  KeyG: 'web'
};

/** The physical key of each `alt` chord: the inverse of {@link ALT_CODES}. */
const ALT_KEYS: Record<AltAction, string> = {
  archive: 'KeyS',
  done: 'KeyQ',
  web: 'KeyG'
};

/**
 * The Keyboard API's layout map, which names the character each physical key types on the user's
 * layout. Chromium, and so Electron, has it; the DOM types do not list it yet.
 */
interface KeyboardLayout {
  getLayoutMap(): Promise<ReadonlyMap<string, string>>;
}

/**
 * The `alt` chord of an action as the hints and tooltips show it: the letter the user's layout
 * types on the chord's physical key, or the QWERTY letter while the layout is unknown.
 */
function altChord(action: AltAction, layout: ReadonlyMap<string, string> | undefined): string {
  const code = ALT_KEYS[action];
  const typed = layout?.get(code);
  // Only a single letter reads as a key; the keybind parser takes `+` and spaces as separators.
  const letter = typed !== undefined && /^\p{L}$/u.test(typed) ? typed : code.slice(3);
  return `alt+${letter.toLowerCase()}`;
}

/**
 * Opens the browser over whatever the window shows. "This project" is the routed session's
 * project, so it is read once here; on Home the dialog lists every project. `refs` is the store
 * the Work panel reads too, so the preview shares its entries and refreshes. `models` gives the
 * server's browser model, which outlives the dialog. `closed` runs once the dialog closes, however
 * it closes.
 */
export function openBrowser(
  ctx: Context,
  prefs: Persisted<BrowserPrefs, BrowserPrefs>,
  refs: RefsStore,
  models: (server: ServerRef) => BrowserModel,
  closed: () => void = () => {}
): DialogHandle {
  const routed = ctx.sessions.current();
  const server = serverFor(ctx, routed);
  const target: BrowserTarget | undefined =
    server === undefined
      ? undefined
      : {
          server,
          origin: routed === undefined ? undefined : { id: routed.id, directory: routed.directory }
        };
  // The dialog's title keeps naming it for screen readers; browser.css hides it from view, since
  // the browser draws its own header with the TUI's gradient title and its own `esc`.
  return ctx.dialogs.open((dialog) => {
    // The dialog's root is disposed when it closes, by esc, a click outside or `dialog.close`.
    onCleanup(closed);
    return (
      <ctx.ui.Dialog title={ctx.t('browser.title')} size="x-large" closable={target === undefined}>
        <Show when={target} fallback={<p class="ss-note">{ctx.t('browser.noServer')}</p>}>
          {(current) => (
            <SessionBrowser
              target={current()}
              model={models(current().server)}
              prefs={prefs}
              refs={refs}
              close={dialog.close}
            />
          )}
        </Show>
      </ctx.ui.Dialog>
    );
  });
}

/** A group's header in the list's single keyed run of items. */
interface ListHeader {
  readonly header: string;
}

/** Whether a list item is a group header rather than a row. */
function isHeader(item: object): item is ListHeader {
  return 'header' in item;
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

/** Props of {@link SessionBrowser}. */
interface SessionBrowserProps {
  readonly target: BrowserTarget;
  /** The server's browser model, kept between opens. */
  readonly model: BrowserModel;
  readonly prefs: Persisted<BrowserPrefs, BrowserPrefs>;
  readonly refs: RefsStore;
  readonly close: () => void;
}

/** The dialog's content: the project rail, tabs, search, the list and the preview. */
function SessionBrowser(props: SessionBrowserProps) {
  const ctx = usePlugin();
  const target = untrack(() => props.target);
  const home = target.origin === undefined;
  // The rail's pick: every project on Home, where no project is routed, else the user's last
  // pick, read once per open. A pick of a project reopens on the routed session's project.
  const [selection, setSelection] = createSignal<RailSelection>(
    home ||
      opensOnAll(
        untrack(() => props.prefs.value),
        ctx.options.scope
      )
      ? { type: 'all' }
      : { type: 'routed' }
  );
  /** The controller's view of the pick, which tells only all projects from one. */
  const scope = (): PageScope => (selection().type === 'all' ? 'all' : 'project');
  const [view, setView] = createSignal<PageView>('active');
  const [query, setQuery] = createSignal('');
  // The user's last pick of a row and of a pull request. A new object per pick, so picking the
  // same id again, or clearing an already clear one, still counts as a pick.
  const [rowPick, setRowPick] = createSignal<Choice>(NO_PICK, { equals: false });
  const [pullPick, setPullPick] = createSignal<Choice>(NO_PICK, { equals: false });
  const setSelected = (id: string | undefined) => setRowPick({ id });
  const setPull = (key: string | undefined) => setPullPick({ id: key });
  const model = untrack(() => props.model);
  const browser = createBrowserView(model, {
    target: () => ({ origin: target.origin, selection: selection() }),
    view,
    query
  });
  const store = model.data;
  const pullView = () => view() === 'pulls';

  const rows = createMemo(() => rowsOf(browser.groups()));
  const pulls = createMemo(() => browser.pullGroups().flatMap((group) => group.pulls));
  // The list as one keyed run of headers and rows. Rows are the store's own session objects and
  // headers are kept by title, so a publish (refs arriving, a run ending) only updates the rows
  // that changed instead of building every row of a group again.
  const headers = new Map<string, ListHeader>();
  /** The header object of a group title, the same one on every publish. */
  const header = (title: string): ListHeader => {
    let known = headers.get(title);
    if (known === undefined) {
      known = { header: title };
      headers.set(title, known);
    }
    return known;
  };
  const items = createMemo(
    (): Array<ListHeader | SessionInfo> =>
      browser
        .groups()
        .flatMap((group) =>
          group.title === undefined ? group.sessions : [header(group.title), ...group.sessions]
        )
  );
  // Pull request rows are built anew on each publish; one whose fields are unchanged is kept.
  const pullItems = createMemo(
    (previous: ReadonlyMap<string, PullRow>): ReadonlyMap<string, PullRow> => {
      const next = new Map<string, PullRow>();
      for (const item of pulls()) {
        const known = previous.get(item.key);
        next.set(item.key, known !== undefined && samePull(known, item) ? known : item);
      }
      return next;
    },
    new Map()
  );
  const pullList = createMemo(
    (): Array<ListHeader | PullRow> =>
      browser
        .pullGroups()
        .flatMap((group) => [
          header(group.title),
          ...group.pulls.map((item) => pullItems().get(item.key) ?? item)
        ])
  );

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
  /** The session the keys act on: the selected row, or the selected pull request's newest one. */
  const current = (): SessionInfo | undefined =>
    pullView() ? selectedPull()?.sessions[0] : rows().find((row) => row.id === selected());
  /** The session's latest copy the server synced, for a title renamed while the dialog is open. */
  const live = (session: SessionInfo): SessionInfo =>
    target.server.data.session.get(session.id) ?? session;
  const running = (session: SessionInfo) => isBusy(live(session)) || model.isRunning(session.id);
  /** What the session waits on the user for, as the app's own lists know it. */
  const waiting = (id: string): 'permission' | 'question' | undefined => {
    const sessions = target.server.data.session;
    if ((sessions.permission.list(id)?.length ?? 0) > 0) return 'permission';
    if ((sessions.form.list(id)?.length ?? 0) > 0) return 'question';
    return undefined;
  };
  /**
   * The open session a row's links belong to: the row's own when it is routed or open in a tab,
   * else the routed one, so the app's link setting can open them in that session's browser pane.
   * On Home, with no tab of the row open, there is none and links go to the system browser.
   */
  const linkSession = (id: string | undefined): SessionRef | undefined =>
    ctx.sessions.list().find((open) => open.server.id === target.server.id && open.id === id) ??
    ctx.sessions.current();
  /**
   * The links of the row `id()` gives. A page the app opens in its pane opens under this dialog,
   * so the dialog closes, and the row's tab comes to the front when it is not the routed one.
   */
  const linkScope = (id: () => string | undefined): LinkScope => ({
    session: () => linkSession(id()),
    opened(where, session) {
      if (where !== 'app') return;
      if (session !== undefined && session.key !== ctx.sessions.current()?.key) {
        openSession(ctx.tabs, { server: session.server.id, id: session.id }, true);
      }
      props.close();
    }
  });
  /**
   * The project a row draws before its title in the all-projects list, as the sidebar's flat
   * lists do. The routed session's project carries the user's local name and icon.
   */
  const projectOf = (session: SessionInfo): ProjectLook | undefined => {
    if (scope() !== 'all') return undefined;
    const local = ctx.sessions.current()?.project;
    return sessionProjectLook(
      target.server,
      session.projectID,
      session.location.directory,
      local === undefined ? undefined : { id: local.id, name: local.name, icon: local.icon }
    );
  };
  // The TUI's `preview` and `previewWidth` options, which the GUI gets unparsed.
  const showPreview = ctx.options.preview !== false;
  const previewShare = previewShareOf(ctx.options.previewWidth);
  const titleEnd = () => TITLE_ORANGE[ctx.appearance.mode() === 'light' ? 'light' : 'dark'];

  // The view syncs the model for every pick, starting over in a newly picked project. The Pull
  // requests view filters its own rows; the session search stays off there. A new pick asks
  // again, since starting over cleared the results.
  createEffect(() => {
    selection();
    model.controller.search(pullView() ? '' : query(), view() === 'archived', scope());
  });

  // The rail's tiles, from every project's active sessions.
  const rail = createRail({
    server: target.server,
    origin: target.origin,
    local: () => {
      const project = ctx.sessions.current()?.project;
      return project === undefined
        ? undefined
        : { id: project.id, name: project.name, icon: project.icon };
    },
    all: () => scope() === 'all',
    active: () => (store.status === 'ready' ? store.active : undefined),
    running: (session) => running(session),
    unread: (session) => isUnread(live(session)) || waiting(session.id) !== undefined
  });
  /** The tile the rail shows as picked. */
  const pickedTile = () => selectionKey(selection(), rail.routedKey());
  /**
   * Lists a tile's sessions, keeping the view and the search, and selects the first row. The pick
   * outlasts the open: `all`, or `project`, which the next open reads as the routed project. Only
   * this pick writes, so the old `allProjects` is read once and dropped here.
   */
  const pickTile = (tile: RailTile) => {
    if (tile.key === pickedTile()) return;
    setSelection(tile.selection);
    setSelected(undefined);
    setPull(undefined);
    props.prefs.update((draft) => {
      draft.rail = tile.key === ALL_KEY ? 'all' : 'project';
      delete draft.allProjects;
      return undefined;
    });
  };
  /** Picks the tile `delta` places along the rail, stopping at its ends. */
  const moveTile = (delta: number) => {
    const tiles = rail.tiles();
    const index = tiles.findIndex((tile) => tile.key === pickedTile());
    const next = tiles[Math.min(tiles.length - 1, Math.max(0, (index === -1 ? 0 : index) + delta))];
    if (next !== undefined) pickTile(next);
  };

  // The selected row scrolls into view as the keys move it.
  const elements = new Map<string, HTMLElement>();
  createEffect(() => {
    const key = pullView() ? pull() : selected();
    if (key !== undefined) elements.get(key)?.scrollIntoView?.({ block: 'nearest' });
  });
  /**
   * Remembers a row's element under its key while the row is on screen. Called from the row's
   * `ref`, under the row's owner, so the entry leaves with the row.
   */
  const track = (key: string) => (element: HTMLElement) => {
    elements.set(key, element);
    onCleanup(() => {
      if (elements.get(key) === element) elements.delete(key);
    });
  };

  // The user's keyboard layout, for the letters of the `alt` hints. Undefined where the Keyboard
  // API is missing, and the hints show the QWERTY letters.
  const layout = createLatest(
    () => (navigator as Navigator & { keyboard?: KeyboardLayout }).keyboard,
    (keyboard) => keyboard.getLayoutMap()
  );
  const alt = (action: AltAction) => altChord(action, layout.latest);

  let root: HTMLDivElement | undefined;
  let search: HTMLElement | undefined;
  onMount(() => {
    search = root?.querySelector('input') ?? undefined;
    search?.focus();
  });

  const toast = (title: string) => ctx.toast.show({ title, variant: 'error' });
  const switchView = (to: PageView) => {
    setView(to);
    setSelected(undefined);
    setPull(undefined);
  };
  /** Opens the session in a tab, focused unless `background`, and closes the dialog. */
  const open = (session: SessionInfo | undefined, background = false) => {
    if (session === undefined) return;
    openSession(ctx.tabs, { server: target.server.id, id: session.id }, !background);
    if (!background) props.close();
  };
  /**
   * Archives the session, or restores it when it is archived. An archive closes the session's tab
   * unless `closeTabOnArchive` is off; a restore keeps auto-archive from taking the session
   * again, as the TUI's restores do.
   */
  const archive = async (session: SessionInfo | undefined) => {
    if (session === undefined) return;
    // The row's own copy: the controller moves it between the lists right after each update.
    const archived = session.time.archived === undefined;
    try {
      await setArchived(target.server.client, session.id, archived);
    } catch {
      toast(ctx.t(archived ? 'browser.archive.failed' : 'browser.restore.failed'));
      return;
    }
    model.controller.archived(session.id, archived, Date.now());
    if (archived && ctx.options.closeTabOnArchive !== false) {
      closeSessionTab(ctx.tabs, { server: target.server.id, id: session.id });
    }
    // Without the server plugin there is no auto-archive to stop.
    if (!archived) {
      void model
        .rpcOptions()
        .then((options) =>
          rpcOn(target.server)['archive.exclude']({ sessionIDs: [session.id] }, options)
        )
        .catch(() => {});
    }
  };
  /** Marks the session Done, or not Done when it is Done by any means. */
  const toggleDone = async (session: SessionInfo | undefined) => {
    if (session === undefined || model.missing()) return;
    const done = !model.isDone(session.id);
    try {
      await rpcOn(target.server)['done.set'](
        { sessionID: session.id, done },
        await model.rpcOptions()
      );
    } catch {
      toast(ctx.t(done ? 'browser.done.failed' : 'browser.notDone.failed'));
      return;
    }
    void model.controller.refresh([session.id], browser.signal);
  };
  /**
   * Opens the selected pull request in the Pull requests view; otherwise the selected session's
   * first line: its main pull request, else its first issue, else its newest work link.
   */
  const openWeb = () => {
    const session = current();
    const scope = linkScope(() => session?.id);
    /** Opens a page as a click on the row's own link would. */
    const go = (url: string) => {
      const link = scope.session();
      const where = openWebLink(ctx, url, link);
      scope.opened?.(where, link);
    };
    const item = pullView() ? selectedPull() : undefined;
    if (item !== undefined) return go(refUrl(item.ref, item.state));
    const refs = session === undefined ? undefined : store.refs[session.id];
    const summary = refs === undefined ? undefined : rowRefs(refs);
    const primary = summary?.prs[0] ?? summary?.issues[0];
    const url =
      primary !== undefined
        ? refUrl(primary, refs?.states[refKey(primary)])
        : refs === undefined
          ? undefined
          : workLinks(refs)[0]?.url;
    if (url === undefined) ctx.toast.show({ title: ctx.t('browser.open.none') });
    else go(url);
  };
  /** Refetches the selected session's refs, branch pull requests and checkout, past the caches. */
  const reload = async () => {
    const session = current();
    if (session === undefined || model.missing()) return;
    try {
      await model.controller.reload(session.id);
    } catch {
      toast(ctx.t('browser.reload.failed'));
    }
  };
  /** Moves the selection by `delta` rows, clamped to the list. */
  const move = (delta: number) => {
    if (!pullView()) return setSelected(moveSelection(rows(), selected(), delta));
    const list = pulls();
    const index = list.findIndex((item) => item.key === pull());
    setPull(list[Math.min(list.length - 1, Math.max(0, (index === -1 ? 0 : index) + delta))]?.key);
  };

  /**
   * The dialog's keys. The app runs no command keybind while a dialog is open, so only the
   * search field and the dialog itself can clash: arrows and tab do nothing useful in a one-line
   * field, enter has no submit there, the `alt` letters only type symbols on macOS and nothing
   * elsewhere, and f5 is the browser panel's reload, a command the dialog already suspends.
   * `alt+up` and `alt+down` move along the rail from anywhere in the dialog, plain up and down
   * keep moving the rows; on macOS the app's Go menu binds them to the previous and next session,
   * which taking them here keeps from running (RAIL_KEYS in src/host/gui.ts). Enter on a focused
   * button or link stays that control's. Tab switches views only from the search field or the
   * dialog itself; on a button or link it moves the focus as usual, so the keyboard reaches the
   * rail, Retry and the preview's buttons. Without the server plugin, `alt+q`, `alt+g` and f5
   * have nothing to act on and do nothing, and their hints are hidden.
   */
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    const mod = event.metaKey || event.ctrlKey;
    const plain = !mod && !event.altKey && !event.shiftKey;
    const onlyAlt = event.altKey && !mod && !event.shiftKey;
    const missing = model.missing();
    let handled = true;
    if (event.key === 'ArrowDown' && onlyAlt) moveTile(1);
    else if (event.key === 'ArrowUp' && onlyAlt) moveTile(-1);
    else if (event.key === 'ArrowDown' && plain) move(1);
    else if (event.key === 'ArrowUp' && plain) move(-1);
    else if (
      event.key === 'Tab' &&
      !mod &&
      !event.altKey &&
      (event.target === search || event.target === root)
    ) {
      const index = VIEWS.indexOf(view()) + (event.shiftKey ? -1 : 1);
      switchView(VIEWS[(index + VIEWS.length) % VIEWS.length] ?? 'active');
    } else if (event.key === 'Enter' && !event.altKey && !event.shiftKey) {
      if (event.target instanceof Element && event.target.closest('button, a')) return;
      open(current(), mod);
    } else if (event.key === 'F5' && plain) void reload();
    else if (onlyAlt && ALT_CODES[event.code] !== undefined) {
      // Taken even when it does nothing, so the field does not type the key's `alt` symbol.
      const action = ALT_CODES[event.code];
      if (action === 'archive') void archive(current());
      else if (action === 'done') void toggleDone(current());
      else if (!missing) openWeb();
    } else handled = false;
    if (!handled) return;
    event.preventDefault();
    event.stopPropagation();
  };

  /** The hover buttons of a session row. */
  const actions = (session: SessionInfo) => (
    <>
      <ctx.ui.Tooltip
        value={ctx.t(session.time.archived === undefined ? 'browser.archive' : 'browser.restore')}
        keys={ctx.keybinds.keys(alt('archive'))}
      >
        <ctx.ui.IconButton
          icon={session.time.archived === undefined ? 'archive' : 'outline-undo'}
          size="small"
          label={ctx.t(session.time.archived === undefined ? 'browser.archive' : 'browser.restore')}
          onClick={(event) => {
            event.stopPropagation();
            void archive(session);
          }}
        />
      </ctx.ui.Tooltip>
      {/* Done is the server plugin's mark: without it there is nothing to set. */}
      <Show when={session.time.archived === undefined && !model.missing()}>
        <ctx.ui.Tooltip
          value={ctx.t(model.isDone(session.id) ? 'browser.markNotDone' : 'browser.markDone')}
          keys={ctx.keybinds.keys(alt('done'))}
        >
          <ctx.ui.IconButton
            icon="circle-check"
            size="small"
            pressed={model.isDone(session.id)}
            label={ctx.t(model.isDone(session.id) ? 'browser.markNotDone' : 'browser.markDone')}
            onClick={(event) => {
              event.stopPropagation();
              void toggleDone(session);
            }}
          />
        </ctx.ui.Tooltip>
      </Show>
    </>
  );

  /** The note of the view's empty list. */
  const emptyNote = () =>
    store.search !== undefined && !pullView()
      ? ctx.t('browser.empty.search')
      : ctx.t(`browser.empty.${view()}`);

  return (
    // The keys of the list and its search field bubble here. A native listener: Solid delegates
    // `onKeyDown` to the document, after the dialog's own listeners and too late to keep `tab`
    // from moving the focus.
    <div
      ref={root}
      class="ss-browser"
      data-preview={showPreview ? 'on' : 'off'}
      style={{ '--ss-preview-share': `${previewShare * 100}%` }}
      tabIndex={-1}
      on:keydown={onKeyDown}
    >
      <div class="ss-browser-main">
        <ProjectRail tiles={rail.tiles()} picked={pickedTile()} onPick={pickTile} />
        <div class="ss-browser-left">
          <div class="ss-browser-bar">
            <span class="ss-title" aria-hidden="true" style={{ '--ss-title-end': titleEnd() }}>
              {ctx.t('browser.title')}
            </span>
            <div class="ss-tabs" role="tablist" aria-label={ctx.t('browser.views')}>
              <For each={VIEWS}>
                {(item) => (
                  <button
                    type="button"
                    role="tab"
                    class="ss-tab"
                    aria-selected={view() === item}
                    data-view={item}
                    onClick={() => switchView(item)}
                  >
                    <Show when={TAB_ICONS[item]}>
                      {(icon) => <Octicon name={icon()} size={14} class="ss-tab-icon" />}
                    </Show>
                    <span class="ss-tab-label">{ctx.t(`browser.view.${item}`)}</span>
                    <span class="ss-tab-count">{model.counts()[item]}</span>
                  </button>
                )}
              </For>
            </div>
            <span class="ss-esc-bar">
              <CloseHint close={props.close} />
            </span>
          </div>
          <ctx.ui.TextInput
            type="search"
            size="large"
            autofocus
            label={ctx.t('browser.search')}
            placeholder={ctx.t(pullView() ? 'browser.search.pulls' : 'browser.search.placeholder')}
            value={query()}
            onInput={(value) => {
              setQuery(value);
              setSelected(undefined);
              setPull(undefined);
            }}
          />
          <Show when={model.missing()}>
            <p class="ss-note">{ctx.t('browser.pluginMissing')}</p>
          </Show>
          <Show when={store.search?.status === 'error' && !pullView()}>
            <p class="ss-note">{ctx.t('browser.search.failed')}</p>
          </Show>
          <div class="ss-list" role="listbox" aria-label={ctx.t(`browser.view.${view()}`)}>
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
                    onClick={() => void browser.load(true)}
                  >
                    {ctx.t('browser.retry')}
                  </ctx.ui.Button>
                </div>
              </Match>
              <Match when={pullView()}>
                <Show when={pulls().length > 0} fallback={<p class="ss-note">{emptyNote()}</p>}>
                  <For each={pullList()}>
                    {(item) =>
                      isHeader(item) ? (
                        <GroupTitle title={item.header} />
                      ) : (
                        <LinkScopeProvider scope={linkScope(() => item.sessions[0]?.id)}>
                          <PullItem
                            pull={item}
                            selected={pull() === item.key}
                            ref={track(item.key)}
                            onSelect={() => setPull(item.key)}
                            onOpen={() => open(item.sessions[0])}
                          />
                        </LinkScopeProvider>
                      )
                    }
                  </For>
                </Show>
              </Match>
              <Match when={true}>
                <Show when={rows().length > 0} fallback={<p class="ss-note">{emptyNote()}</p>}>
                  <For each={items()}>
                    {(item) =>
                      isHeader(item) ? (
                        <GroupTitle title={item.header} />
                      ) : (
                        <LinkScopeProvider scope={linkScope(() => item.id)}>
                          <SessionRow
                            session={live(item)}
                            view={store.refs[item.id]}
                            selected={selected() === item.id}
                            running={running(item)}
                            waiting={waiting(item.id)}
                            now={model.now()}
                            archivedAge={view() === 'archived' && store.search === undefined}
                            actions={actions(item)}
                            project={projectOf(live(item))}
                            ref={track(item.id)}
                            onSelect={() => setSelected(item.id)}
                            onOpen={() => open(item)}
                          />
                        </LinkScopeProvider>
                      )
                    }
                  </For>
                </Show>
              </Match>
            </Switch>
          </div>
        </div>
        {/* A full-height column beside the list, with `esc` on the line of the list's header. */}
        <Show when={showPreview}>
          <aside class="ss-preview">
            <div class="ss-esc-preview">
              <CloseHint close={props.close} />
            </div>
            <Show
              when={current()}
              fallback={<p class="ss-note">{ctx.t('browser.preview.empty')}</p>}
            >
              {(session) => (
                <LinkScopeProvider scope={linkScope(() => session().id)}>
                  <Preview
                    server={target.server}
                    session={live(session())}
                    running={running(session())}
                    now={model.now()}
                    refs={props.refs}
                  />
                </LinkScopeProvider>
              )}
            </Show>
          </aside>
        </Show>
      </div>
      {/* The TUI's footer: actions on the selected row on the left, the rail's keys on the right. */}
      <div class="ss-hints">
        <div class="ss-hints-actions">
          <Hint keys={KEYS.open} label={ctx.t('browser.hint.open')} />
          <Show
            when={pullView()}
            fallback={
              <>
                <Hint
                  keys={alt('archive')}
                  label={ctx.t(
                    view() === 'archived' ? 'browser.hint.restore' : 'browser.hint.archive'
                  )}
                />
                <Show when={!model.missing()}>
                  <Hint keys={alt('done')} label={ctx.t('browser.hint.done')} />
                </Show>
              </>
            }
          >
            <Show when={!model.missing()}>
              <Hint keys={alt('web')} label={ctx.t('browser.hint.web')} />
            </Show>
          </Show>
        </div>
        <span class="ss-hint">
          <ctx.ui.Keybind keys={ctx.keybinds.keys(KEYS.previousProject)} />
          <ctx.ui.Keybind keys={ctx.keybinds.keys(KEYS.nextProject)} />
          <span>{ctx.t('browser.hint.projects')}</span>
        </span>
      </div>
    </div>
  );
}

/** One key hint of the dialog's footer: the chord in the app's key chips, then what it does. */
function Hint(props: { keys: string; label: string }) {
  const ctx = usePlugin();
  return (
    <span class="ss-hint">
      <ctx.ui.Keybind keys={ctx.keybinds.keys(props.keys)} />
      <span>{props.label}</span>
    </span>
  );
}

/** The muted `esc` the TUI shows at the top right; a click closes the browser too. */
function CloseHint(props: { close: () => void }) {
  const ctx = usePlugin();
  return (
    <button type="button" class="ss-esc" aria-label={ctx.t('browser.close')} onClick={props.close}>
      esc
    </button>
  );
}

/**
 * A group header, such as a day or Running, drawn as the app sidebar's section headers are
 * (browser.css), with the group's name translated when the catalog has it.
 */
function GroupTitle(props: { title: string }) {
  const ctx = usePlugin();
  const key = () => `browser.group.${props.title}`;
  const text = () => {
    const translated = ctx.t(key());
    return translated === key() ? props.title : translated;
  };
  return <h3 class="ss-group-title">{text()}</h3>;
}
