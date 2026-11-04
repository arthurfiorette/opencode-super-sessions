import path from 'node:path';
import type { SessionInfo } from '@opencode/client';
import type { KeymapCommand } from '@opencode/plugin/tui/context';
import type { ResolvedTheme } from '@opencode/theme/tui';
import {
  type BoxRenderable,
  type InputRenderable,
  MouseButton,
  type MouseEvent,
  type Renderable,
  SliderRenderable,
  TextAttributes
} from '@opentui/core';
import { jsx } from '@opentui/solid/jsx-runtime';
import {
  createComponent,
  createEffect,
  createMemo,
  createSignal,
  Index,
  on,
  onCleanup,
  onMount,
  untrack
} from 'solid-js';
import { openUrl, refUrl } from '../browser.js';
import { useCliSettings } from '../cli-settings.js';
import { COMMAND_PALETTE, HOST_COMMANDS, OVER_HOST } from '../host/keymap.js';
import { rpcError } from '../host/rpc.js';
import { isUnread, regenerateTitle, setArchived } from '../host/session-api.js';
import { DIALOG_BACKDROP, dialogTheme, sessionBackground } from '../host/theme.js';
import { type Ref, refKey, refNumber } from '../refs/ref.js';
import { rowRefs } from '../refs/summary.js';
import { excludeFromAutoArchive } from '../settings/maintenance.js';
import { tuiSettingsFor } from '../settings/store.js';
import { ICONS, titleGradient } from './icons.js';
import { guardActions, type PageProps, type PeekBannerProps, routeKey } from './page.js';
import { Preview } from './preview.js';
import { workLines } from './preview-header.js';
import {
  cells,
  detailKinds,
  detailsLine,
  findRef,
  formatAge,
  NO_DETAILS,
  type RowDetails,
  type RowModel,
  rowDetails,
  runningColor,
  type Segment,
  titleLine,
  titleRoom,
  wrapLine,
  wrapTitle
} from './row.js';
import {
  keepSelection,
  type Line,
  layoutLines,
  moveSelection,
  type PageView,
  rowsOf,
  type SearchReason,
  scrollFor,
  VIEWS
} from './state.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** Keymap mode pushed while the browser is open. */
const MODE = 'super-sessions';
const PREVIEW_MIN_COLUMNS = 120;
const REFRESH_INTERVAL = 60_000;
const SCOPE_DELAY = 200;
const VIEW_LABELS: Record<PageView, string> = {
  active: 'Active',
  done: 'Done',
  archived: 'Archived'
};
const EMPTY: Record<PageView, string> = {
  active: 'No sessions',
  done: 'No done sessions',
  archived: 'No archived sessions'
};
// Header row layout, shared by the boxes and the measure that decides which pieces fit. The title
// never drops; the pieces after it do.
const TITLE = 'Super Sessions';
const HEADER_PADDING = 2;
const TABS_INDENT = 4;
const TAB_GAP = 3;
// Blank cells kept between the last tab and the `esc` hint.
const ESC_GAP = 2;
// Footer layout: side padding and the blank cells between two hints.
const FOOTER_PADDING = 2;
const HINT_GAP = 2;
// Free in the host's default keymap and in the search input's own bindings: ctrl+e and ctrl+k
// edit the line there, ctrl+n moves through host dialogs, ctrl+x is the host's leader.
const DONE_KEY = 'ctrl+q';

/** Which optional pieces the header row shows. */
interface HeaderFit {
  project: boolean;
  icons: boolean;
  counts: boolean;
}

// The tab names alone, kept even when they do not fit.
const LABELS_ONLY: HeaderFit = { project: false, icons: false, counts: false };
// Widest first; each step drops one more piece.
const HEADER_FITS: readonly HeaderFit[] = [
  { project: true, icons: true, counts: true },
  { project: false, icons: true, counts: true },
  { project: false, icons: false, counts: true },
  LABELS_ONLY
];

/**
 * Session browser drawn over the current route like the host's dialogs, only larger: header with
 * view tabs, search, grouped list, preview and key hints.
 */
export default function SessionBrowser(props: PageProps) {
  const context = props.context;
  const model = props.model;
  const controller = model.controller;
  const data = model.data;
  const memory = model.memory;
  // The host draws its dialogs on this surface; the plugin theme resolves the same tokens.
  const theme = () => dialogTheme(context);
  const client = context.client;
  const [panelWidth, setPanelWidth] = createSignal(0);
  const [leftWidth, setLeftWidth] = createSignal(0);
  const [listHeight, setListHeight] = createSignal(0);
  const [listWidth, setListWidth] = createSignal(0);
  const [frame, setFrame] = createSignal(0);
  const [deleting, setDeleting] = createSignal<string>();
  const [projectLabel, setProjectLabel] = createSignal('');
  const [projectID, setProjectID] = createSignal<string>();
  const cli = useCliSettings();
  const settings = tuiSettingsFor(context);
  let input: InputRenderable | undefined;
  let listBox: BoxRenderable | undefined;
  let panelBox: BoxRenderable | undefined;
  let leftBox: BoxRenderable | undefined;

  const remember = model.remember;
  const scope = model.scope;
  const rows = model.rows;
  const selected = () => rows().find((session) => session.id === memory.selected);
  const live = (session: SessionInfo) => context.data.session.get(session.id) ?? session;
  const slots = createMemo(() => new Map(props.pins.slots().map((id, index) => [id, index + 1])));
  const reason = (session: SessionInfo): SearchReason | undefined =>
    data.search?.reasons[session.id];

  const branchOf = (session: SessionInfo) => {
    const view = data.refs[session.id];
    const vcs = context.data.location.vcs.info(session.location)?.branch;
    const current = view?.branch ?? vcs?.current;
    const fallback = view?.defaultBranch ?? vcs?.default;
    return current && current !== fallback ? current : undefined;
  };
  // The "PR and issue line" setting turns the PR, status and issues lines off together.
  const detailsOf = (session: SessionInfo): RowDetails =>
    settings.refLine()
      ? rowDetails({
          options: props.options,
          theme: theme(),
          mode: context.themeMode,
          refs: data.refs[session.id],
          matched: reason(session)?.ref
        })
      : NO_DETAILS;
  /** The age, or the archive and update ages in the Archived view, on the title line. */
  const rightOf = (session: SessionInfo) => {
    const info = live(session);
    const now = model.now();
    const archivedAt =
      memory.view === 'archived' && !data.search
        ? (session.time.archived ?? info.time.archived)
        : undefined;
    return archivedAt === undefined
      ? // Padded to the widest age (`11mo`), so labels before it line up down the list.
        formatAge(now - info.time.updated).padStart(4)
      : `archived ${formatAge(now - archivedAt)} · updated ${formatAge(now - info.time.updated)}`;
  };
  /**
   * A row's title wrapped at its column. It reads no selection, hover or delete state, so moving
   * the selection never changes a row's height.
   */
  const titleOf = (session: SessionInfo): string[] => {
    const room = titleRoom({
      // The row box pads one cell on each side.
      width: listWidth() - 2,
      label: matchLabel(reason(session), data.refs[session.id]),
      right: rightOf(session)
    });
    return wrapTitle(live(session).title || 'Untitled session', room);
  };
  const lines = createMemo(() =>
    layoutLines(
      model.groups(),
      (session) => detailKinds(detailsOf(session)),
      (session) => titleOf(session).length
    )
  );
  const visible = createMemo(() => lines().slice(memory.scroll, memory.scroll + listHeight()));

  // Rows change under the cursor when sessions are archived, deleted or classified as Done.
  createEffect(
    on(rows, (next, previous) => {
      // An empty list means "still loading" as often as "nothing left"; keeping the id lets a
      // selection restored from memory survive until the sessions arrive.
      if (next.length === 0) return;
      const keep = keepSelection(
        previous ?? [],
        next,
        untrack(() => memory.selected)
      );
      if (keep !== untrack(() => memory.selected)) remember({ selected: keep });
    })
  );
  createEffect(() => {
    const scroll = scrollFor(
      lines(),
      memory.selected,
      untrack(() => memory.scroll),
      listHeight()
    );
    if (scroll !== untrack(() => memory.scroll)) remember({ scroll });
  });
  createEffect(
    on(
      () => memory.selected,
      () => setDeleting(undefined),
      { defer: true }
    )
  );

  // The preview's branch needs the directory's VCS info, which the host fetches only on request.
  const synced = new Set<string>();
  createEffect(() => {
    const session = selected();
    if (!session) return;
    const directory = session.location.directory;
    if (synced.has(directory) || data.refs[session.id]?.branch !== undefined) return;
    synced.add(directory);
    void context.data.location.vcs.sync({ directory }).catch(() => {});
  });

  const visibleIDs = () =>
    untrack(() => visible().flatMap((line) => (line.kind === 'title' ? [line.session.id] : [])));
  // Cached lists draw at once; a reload, when due, and the forge refresh run behind them.
  const refreshVisible = () => void controller.refresh(visibleIDs());
  const sync = () => {
    const pending = model.sync();
    if (pending === undefined) refreshVisible();
    else void pending.then(refreshVisible);
  };
  sync();
  // Pressing ctrl+a several times in a row loads only the scope it stops on, instead of one
  // reload, refs call and refresh per press.
  let scopeTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(
      scope,
      () => {
        clearTimeout(scopeTimer);
        scopeTimer = setTimeout(sync, SCOPE_DELAY);
      },
      { defer: true }
    )
  );
  onCleanup(() => clearTimeout(scopeTimer));
  createEffect(() => controller.search(memory.query, memory.view === 'archived', scope()));
  onMount(() => {
    input?.focus();
    // Closing a host dialog refocuses what it took focus from one tick later, which can land
    // after this mount and leave typing in the prompt underneath. Claim the focus back once.
    const refocus = setTimeout(() => {
      if (input && !input.isDestroyed && !input.focused) input.focus();
    }, 10);
    onCleanup(() => clearTimeout(refocus));
    void model
      .resolveLocation()
      .then((info) => {
        setProjectID(info.project.id);
        const project = context.data.project.get(info.project.id);
        const root = project?.canonical ?? info.project.directory;
        setProjectLabel(info.project.id === 'global' ? '' : project?.name || path.basename(root));
      })
      .catch(() => {});
  });

  const timers = [
    setInterval(() => {
      model.setNow(Date.now());
      refreshVisible();
    }, REFRESH_INTERVAL),
    setInterval(() => {
      if (!untrack(() => cli.animations)) return;
      if (untrack(() => rows().some((session) => model.running(session.id))))
        setFrame((value) => value + 1);
    }, 80)
  ];
  onCleanup(() => {
    for (const timer of timers) clearInterval(timer);
  });
  model.setNow(Date.now());

  const shortcut = (id: string, fallback: string) => context.keymap.shortcuts(id)[0] ?? fallback;
  const toast = (message: string, variant: 'info' | 'success' | 'warning' | 'error' = 'info') =>
    context.ui.toast.show({ message, variant });

  const setQuery = (value: string) =>
    model.setMemory((draft) => {
      draft.query = value;
      draft.selected = undefined;
      draft.scroll = 0;
    });
  const select = (sessionID: string | undefined) => remember({ selected: sessionID });
  const move = (delta: number) => select(moveSelection(rows(), memory.selected, delta));
  // Rows on screen now, from the real line heights, so a page jump never skips past one.
  const pageRows = () => Math.max(1, visible().filter((line) => line.kind === 'title').length - 1);
  const open = (sessionID = memory.selected) => {
    if (sessionID === undefined) return;
    props.close();
    context.ui.router.navigate({ type: 'session', sessionID });
  };
  const setView = (view: PageView) =>
    model.setMemory((draft) => {
      draft.view = view;
      draft.selected = undefined;
      draft.scroll = 0;
    });

  const archive = async () => {
    const session = selected();
    if (!session) return;
    // The row's own copy, not the live one: the controller moves it between lists right after
    // each update, while the host's synced copy may still be catching up.
    const archived = session.time.archived === undefined;
    try {
      await setArchived(client, session.id, archived);
    } catch {
      toast(
        archived ? 'Could not archive the session.' : 'Could not restore the session.',
        'error'
      );
      return;
    }
    controller.archived(session.id, archived, Date.now());
    if (archived && settings.closeTabOnArchive()) context.ui.tabs.close(session.id);
    if (!archived) void excludeFromAutoArchive(context, [session.id]);
  };
  const rename = async () => {
    const session = selected();
    if (!session) return;
    const title = await context.ui.dialog.prompt({
      title: 'Rename session',
      value: live(session).title ?? ''
    });
    if (!title?.trim()) return;
    try {
      await client.session.update({ sessionID: session.id, title: title.trim() });
    } catch {
      toast('Could not rename the session.', 'error');
    }
  };
  const remove = async () => {
    const session = selected();
    if (!session) return;
    if (deleting() !== session.id) {
      setDeleting(session.id);
      return;
    }
    try {
      await client.session.remove({ sessionID: session.id });
      controller.removed(session.id);
    } catch {
      setDeleting(undefined);
      toast('Could not delete the session.', 'error');
    }
  };
  const retitle = async () => {
    const session = selected();
    if (!session) return;
    try {
      await regenerateTitle(client, session.id);
      toast('Regenerating title');
    } catch {
      toast('Could not regenerate the title.', 'error');
    }
  };
  const link = async () => {
    const session = selected();
    if (!session) return;
    const reference = await context.ui.dialog.prompt({
      title: 'Link pull request or issue',
      placeholder: 'URL, owner/repo#N or #N'
    });
    if (!reference?.trim()) return;
    try {
      const linked = await model
        .rpc()
        .link({ sessionID: session.id, reference: reference.trim() }, model.rpcOptions());
      toast(
        `Linked ${linked.ref.kind === 'pr' ? 'PR' : 'issue'} ${refNumber(linked.ref)}`,
        'success'
      );
      void controller.refresh([session.id]);
    } catch (error) {
      toast(linkError(error), 'error');
    }
  };
  const archiveDone = async () => {
    const done = rowsOf(model.doneGroups());
    if (done.length === 0) return;
    const confirmed = await context.ui.dialog.confirm({
      title: 'Archive done sessions?',
      message: `Archive ${done.length} done ${done.length === 1 ? 'session' : 'sessions'}.`,
      label: { confirm: 'Archive' }
    });
    if (!confirmed) return;
    let failed = 0;
    for (const session of done) {
      try {
        await setArchived(client, session.id, true);
        controller.archived(session.id, true, Date.now());
        if (settings.closeTabOnArchive()) context.ui.tabs.close(session.id);
      } catch {
        failed++;
      }
    }
    if (failed > 0) toast(`${failed} could not be archived.`, 'warning');
  };
  /** Whether the session is in the Done view now, by the rule or the user's mark. */
  const doneNow = (session: SessionInfo) =>
    rowsOf(model.doneGroups()).some((row) => row.id === session.id);
  /** Marks the selected session Done, or not Done when it is Done by any means. */
  const toggleDone = async () => {
    const session = selected();
    if (!session) return;
    const done = !doneNow(session);
    try {
      await model.rpc()['done.set']({ sessionID: session.id, done }, model.rpcOptions());
    } catch {
      toast(
        done ? 'Could not mark the session done.' : 'Could not mark the session not done.',
        'error'
      );
      return;
    }
    void controller.refresh([session.id]);
  };
  const openRef = () => {
    const session = selected();
    const view = session ? data.refs[session.id] : undefined;
    const summary = view ? rowRefs(view) : undefined;
    const primary = summary?.pr ?? summary?.issues[0];
    if (!view || !primary) {
      toast('No pull request or issue on this session.');
      return;
    }
    if (!openUrl(refUrl(primary, view.states[refKey(primary)])))
      toast('Could not open the browser.', 'error');
  };

  // The arrow keys drive the list, or the preview's Work rows after `right`. The search input
  // keeps the terminal focus either way, so typing still searches.
  const [focus, setFocus] = createSignal<'list' | 'work'>('list');
  const [workIndex, setWorkIndex] = createSignal(0);
  /** Gives the arrow keys back to the list. */
  const focusList = () => {
    setFocus('list');
  };
  const workRefs = createMemo(() => {
    const session = selected();
    const view = session ? data.refs[session.id] : undefined;
    if (!view) return [];
    return workLines(view).flatMap((line) => (line.kind === 'ref' ? [line.ref] : []));
  });
  /** The Work row the keyboard selected, while the Work rows have the keys. */
  const workRef = () => (focus() === 'work' ? workRefs()[workIndex()] : undefined);
  // The Work rows belong to the selected session; another session or search hands the keys back.
  createEffect(on(() => [memory.selected, memory.query], focusList, { defer: true }));
  // A refresh can drop rows under the cursor.
  createEffect(() => {
    const count = workRefs().length;
    if (count === 0) focusList();
    else if (untrack(workIndex) >= count) setWorkIndex(count - 1);
  });
  /** Moves the Work selection by `delta`, clamped to the rows. */
  const moveWork = (delta: number) => {
    setWorkIndex((index) => Math.min(workRefs().length - 1, Math.max(0, index + delta)));
  };
  /** `right`: into the Work rows, unless the search cursor still has text to move over. */
  const focusWork = () => {
    if (focus() === 'work') return;
    if (input && input.cursorOffset < cells(input.value)) return false;
    // The preview is hidden on narrow terminals, and a session without refs has no rows.
    if (!wide() || workRefs().length === 0) return;
    setWorkIndex(0);
    setFocus('work');
  };
  /** `enter` in the Work rows: opens the selected ref's page, like a click on the row. */
  const openWork = () => {
    const ref = workRef();
    const session = selected();
    if (!ref || !session) return;
    if (!openUrl(refUrl(ref, data.refs[session.id]?.states[refKey(ref)])))
      toast('Could not open the browser.', 'error');
  };

  const nextView = (step: number) =>
    setView(VIEWS[(VIEWS.indexOf(memory.view) + VIEWS.length + step) % VIEWS.length] ?? 'active');
  const peek = () => {
    if (memory.selected !== undefined) props.peek(memory.selected);
  };
  const togglePin = () => {
    const session = selected();
    if (session)
      void props.pins.toggle(session.id).catch(() => toast('Could not save pins.', 'error'));
  };
  /**
   * Every browser action with the key that runs it, in the order the keys dialog lists them.
   * Actions that do nothing in the current state, such as archiving all done sessions outside
   * the Done view, are left out.
   */
  const keyActions = (): Array<{ title: string; key: string; run: () => unknown }> => {
    const current = selected();
    return [
      { title: 'Open session', key: 'enter', run: () => open() },
      { title: 'Peek session', key: 'space', run: peek },
      {
        title: memory.view === 'archived' ? 'Restore session' : 'Archive session',
        key: 'ctrl+s',
        run: archive
      },
      {
        title: current && doneNow(current) ? 'Mark not done' : 'Mark done',
        key: DONE_KEY,
        run: toggleDone
      },
      { title: 'Next view', key: 'tab', run: () => nextView(1) },
      { title: 'Previous view', key: 'shift+tab', run: () => nextView(-1) },
      {
        title: scope() === 'project' ? 'Show all projects' : 'Show this project',
        key: 'ctrl+a',
        run: () => model.toggleScope().catch(() => {})
      },
      {
        title: 'Rename session',
        key: shortcut(HOST_COMMANDS.rename, 'ctrl+r'),
        run: rename
      },
      {
        title: 'Regenerate title',
        key: shortcut('super-sessions.retitle', 'ctrl+t'),
        run: retitle
      },
      {
        title: current && props.pins.has(current.id) ? 'Unpin session' : 'Pin session',
        key: shortcut(HOST_COMMANDS.pin, 'ctrl+f'),
        run: togglePin
      },
      {
        title: 'Delete session',
        key: shortcut(HOST_COMMANDS.delete, 'ctrl+d'),
        run: remove
      },
      ...(memory.view === 'done' && !data.search
        ? [
            {
              title: 'Archive all done sessions',
              key: shortcut('super-sessions.archive.done', 'ctrl+y'),
              run: archiveDone
            }
          ]
        : []),
      {
        title: 'Link pull request or issue',
        key: shortcut('super-sessions.link', 'ctrl+l'),
        run: link
      },
      {
        title: 'Open pull request in browser',
        key: shortcut('super-sessions.open.ref', 'ctrl+g'),
        run: openRef
      },
      ...(wide() && workRefs().length > 0
        ? [{ title: 'Focus the preview links', key: 'right', run: focusWork }]
        : []),
      {
        title: 'Show command palette',
        key: 'ctrl+p',
        run: () => context.keymap.dispatch(COMMAND_PALETTE)
      },
      {
        title: 'Super Sessions settings',
        key: 'ctrl+o',
        run: () => context.keymap.dispatch('super-sessions.settings')
      },
      { title: 'Close', key: 'esc', run: props.close }
    ];
  };
  /**
   * The keys dialog: the browser's actions in the host's select dialog, key on the right like the
   * command palette. Picking one closes the dialog and runs it on the selected session.
   */
  const showKeys = async () => {
    const actions = keyActions();
    const index = await context.ui.dialog.select({
      title: 'Keys',
      placeholder: 'Search actions',
      options: actions.map((action, value) => ({
        title: action.title,
        value,
        footer: action.key
      }))
    });
    if (index === undefined) return;
    // The host gives the focus back to the search field a tick after the dialog closes. An action
    // that opens another dialog (rename, link) runs before that tick, and that dialog would
    // remember no focus to return to on close.
    if (input && !input.isDestroyed) input.focus();
    void actions[index]?.run();
  };

  // Host dialogs push the "modal" mode above this one, which turns this layer off while a rename
  // prompt or confirm is open and back on when it closes. Created inside the component, so the
  // layer goes away with the browser.
  const commands: KeymapCommand[] = [
    {
      bind: 'up',
      title: 'Previous session',
      run: () => (focus() === 'work' ? moveWork(-1) : move(-1))
    },
    {
      bind: 'down',
      title: 'Next session',
      run: () => (focus() === 'work' ? moveWork(1) : move(1))
    },
    // `right` is also the search field's cursor key; `focusWork` hands it back while the cursor
    // is not at the end. `left` stays the field's until the Work rows have the keys.
    { bind: 'right', title: 'Focus the preview links', run: focusWork },
    {
      bind: 'left',
      title: 'Back to the list',
      enabled: () => focus() === 'work',
      run: focusList
    },
    { bind: 'pageup', title: 'Page up', run: () => move(-pageRows()) },
    { bind: 'pagedown', title: 'Page down', run: () => move(pageRows()) },
    { bind: 'home', title: 'First session', run: () => move(-rows().length) },
    { bind: 'end', title: 'Last session', run: () => move(rows().length) },
    {
      bind: 'return',
      title: 'Open session',
      run: () => (focus() === 'work' ? openWork() : open())
    },
    // Space also types into the search box. Returning false lets the key fall through to the
    // focused input, so peeking only takes the key while the search is empty.
    {
      bind: 'space',
      title: 'Peek session',
      run: () => {
        if (memory.query.length > 0) return false;
        peek();
      }
    },
    // Terminals without the kitty protocol send ctrl+/ as 0x1F, which OpenTUI reads as ctrl+_;
    // kitty sends ctrl+/. `?` arrives as `?`, or as shift+/ or shift+? under kitty, and types
    // into a non-empty search like space.
    ...['ctrl+/', 'ctrl+_'].map((bind) => ({ bind, title: 'Keys', run: () => void showKeys() })),
    ...['?', 'shift+/', 'shift+?'].map((bind) => ({
      bind,
      title: 'Keys',
      run: () => {
        if (memory.query.length > 0) return false;
        void showKeys();
      }
    })),
    {
      bind: 'escape',
      title: 'Close',
      run: () => (focus() === 'work' ? focusList() : props.close())
    },
    // The dialog opens above the overlay, and closing it gives the keys back to the browser.
    // Not ctrl+,: the host splits binding strings on commas (registerCommaBindings in
    // @opentui/keymap), so `ctrl+,` throws and `ctrl+comma` never matches the key event, and
    // legacy terminals cannot send it anyway. The host's ctrl+o (`open.menu`) belongs to the
    // session view, which is not active under the browser.
    {
      bind: 'ctrl+o',
      title: 'Super Sessions settings',
      run: () => context.keymap.dispatch('super-sessions.settings')
    },
    // A plain binding, not the host's id: a command with that id here would catch its own
    // dispatch. The palette opens above the browser, and closing it gives the keys back.
    {
      bind: 'ctrl+p',
      title: 'Show command palette',
      run: () => context.keymap.dispatch(COMMAND_PALETTE)
    },
    { bind: 'tab', title: 'Next view', run: () => nextView(1) },
    // The host binds shift+tab to agent.cycle; this layer's mode is on top while the browser is
    // open, so the key cycles views here and agents everywhere else.
    { bind: 'shift+tab', title: 'Previous view', run: () => nextView(-1) },
    {
      bind: 'ctrl+a',
      title: 'Toggle all projects',
      run: () => void model.toggleScope().catch(() => {})
    },
    { bind: 'ctrl+s', title: 'Archive or restore', run: () => void archive() },
    { bind: DONE_KEY, title: 'Mark done or not done', run: () => void toggleDone() },
    { id: HOST_COMMANDS.rename, title: 'Rename session', run: () => void rename() },
    { id: HOST_COMMANDS.delete, title: 'Delete session', run: () => void remove() },
    {
      id: HOST_COMMANDS.pin,
      title: 'Pin or unpin session',
      run: togglePin
    },
    {
      id: 'super-sessions.retitle',
      title: 'Regenerate title',
      bind: 'ctrl+t',
      run: () => void retitle()
    },
    {
      id: 'super-sessions.link',
      title: 'Link pull request or issue',
      bind: 'ctrl+l',
      run: () => void link()
    },
    {
      id: 'super-sessions.archive.done',
      title: 'Archive all done sessions',
      bind: 'ctrl+y',
      enabled: () => memory.view === 'done' && !data.search,
      run: () => void archiveDone()
    },
    {
      id: 'super-sessions.open.ref',
      title: 'Open pull request in browser',
      bind: 'ctrl+g',
      run: openRef
    },
    // Last on purpose: the specific bindings above win on keys shared with app.exit (ctrl+d).
    // Like the host's dialogs, the exit keys clear the search first and close on the next press;
    // quitting OpenCode from a list is never what the user meant.
    {
      id: HOST_COMMANDS.exit,
      title: 'Close',
      run: () => {
        if (memory.query.length === 0) return props.close();
        if (input) input.value = '';
        setQuery('');
      }
    }
  ];
  context.keymap.layer(() => ({
    mode: MODE,
    priority: OVER_HOST,
    commands: guardActions(props.fail, commands)
  }));

  // The mode turns off the prompt and every other base-mode layer while the browser is open.
  onCleanup(context.keymap.mode.push(MODE));
  // The quick switch keys and the host's tab keys change the route under the browser; the
  // browser belongs to the route it opened over.
  createEffect(on(() => routeKey(context.ui.router.current()), props.close, { defer: true }));
  // Focus moves to the search input while open and back to the prompt (or whatever had it) on
  // close, like the host's dialogs.
  const previous = context.renderer.currentFocusedRenderable;
  previous?.blur();
  onCleanup(() => {
    setTimeout(() => {
      if (previous && !previous.isDestroyed && attached(context.renderer.root, previous))
        previous.focus();
    }, 1);
  });

  const hover = (session: SessionInfo) => select(session.id);
  const leave = () => {};

  const markerOf = (session: SessionInfo): Segment | undefined => {
    const slot = slots().get(session.id);
    if (slot !== undefined) return { text: String(slot), fg: theme().hue.accent[200] };
    const permission = context.data.session.permission.list(session.id)?.length ?? 0;
    const form = context.data.session.form.list(session.id)?.length ?? 0;
    // Same glyphs and color as the host's session list gutter.
    if (permission > 0 || form > 0) {
      return {
        text: permission > 0 ? '!' : '?',
        fg: theme().text.feedback.warning.base,
        bold: true
      };
    }
    if (model.running(session.id)) {
      // The host's spinner stands still as `⋯` while animations are off.
      const text = cli.animations ? (SPINNER[frame() % SPINNER.length] ?? '') : '⋯';
      return { text, fg: runningColor(theme()) };
    }
    return isUnread(live(session)) ? { text: '●', fg: theme().text.feedback.info.base } : undefined;
  };

  // Zebra rows: every second session of a group, all of its lines, on the session view's
  // background, the others on the panel's. Each group starts over, so a day reads the same
  // whatever came before it. When a theme gives both the same color, the stripe goes one step
  // darker than the panel instead.
  const stripes = createMemo(
    () =>
      new Map(
        model
          .groups()
          .flatMap((group) => group.sessions.map((session, index) => [session.id, index]))
      )
  );
  const stripe = () => {
    const shade = sessionBackground(context.theme);
    const panel = theme().background.base;
    return shade.equals(panel) ? theme().decrease(panel) : shade;
  };

  /** The row's title lines; a delete confirmation takes the first and blanks the rest. */
  const titleLines = (session: SessionInfo): string[] => {
    const title = titleOf(session);
    if (deleting() !== session.id) return title;
    const confirm = `Press ${shortcut(HOST_COMMANDS.delete, 'ctrl+d')} again to delete`;
    return [confirm, ...title.slice(1).map(() => '')];
  };

  const rowModel = (session: SessionInfo): RowModel => ({
    marker: markerOf(session),
    title: titleLines(session),
    label: matchLabel(reason(session), data.refs[session.id]),
    right: rightOf(session),
    // The row box pads one cell on each side.
    width: listWidth() - 2,
    details: detailsOf(session),
    selected: memory.selected === session.id,
    // Pinned rows show their slot instead of the spinner, but their title still says it runs.
    running: model.running(session.id),
    deleting: deleting() === session.id,
    stripe: (stripes().get(session.id) ?? 0) % 2 === 1 ? stripe() : undefined
  });

  /** One list line. The node is rebuilt only when the line changes kind or session. */
  const renderLine = (line: () => Line) => {
    const key = createMemo(() => {
      const value = line();
      return value.kind === 'header'
        ? `h:${value.title}`
        : value.kind === 'blank'
          ? 'b'
          : value.kind === 'wrap'
            ? `w${value.index}:${value.session.id}`
            : `${value.kind}:${value.session.id}`;
    });
    return createMemo(() => {
      key();
      return untrack(() => {
        const value = line();
        // A text node, because an empty box in this column collapses to zero height.
        if (value.kind === 'blank') return jsx('text', { height: 1, flexShrink: 0, children: ' ' });
        if (value.kind === 'header') {
          return jsx('box', {
            height: 1,
            flexShrink: 0,
            paddingLeft: 1,
            children: jsx('text', {
              attributes: TextAttributes.BOLD,
              // The token the host uses for its select dialog's category headers.
              get fg() {
                return theme().hue.accent[200];
              },
              children: value.title
            })
          });
        }
        const initial = value.session;
        // Reads the latest line, but tolerates the moment before the key memo rebuilds this node.
        const session = () => {
          const current = line();
          return current.kind === 'blank' || current.kind === 'header' ? initial : current.session;
        };
        // A failed memo reads as undefined, and the row's render effects would throw on it again
        // after the crash fallback, outside any boundary. So the first model is read here, where
        // a throw stops this line before any node exists, and a later failure keeps the last one.
        let last = rowModel(initial);
        const row = createMemo(() => {
          try {
            last = rowModel(session());
          } catch (error) {
            props.fail(error);
          }
          return last;
        });
        const events = {
          hover: () => hover(session()),
          leave,
          open: () => open(session().id)
        };
        if (value.kind === 'title') return titleLine(theme, row, events);
        if (value.kind === 'wrap') return wrapLine(value.index, theme, row, events);
        return detailsLine(value.kind, theme, row, events);
      });
    });
  };

  const listMessage = createMemo(() => {
    if (data.search) {
      if (data.search.sessions.length > 0) return undefined;
      if (data.search.status === 'error')
        return { text: 'Could not search sessions. Change the search to try again.', error: true };
      return {
        text: data.search.status === 'searching' ? 'Searching…' : 'No sessions found',
        error: false
      };
    }
    if (data.status === 'loading') return { text: 'Loading sessions…', error: false };
    if (data.status === 'error') return { text: 'Could not load sessions.', error: true };
    return rows().length === 0 ? { text: EMPTY[memory.view], error: false } : undefined;
  });

  const wide = () => panelWidth() >= PREVIEW_MIN_COLUMNS && settings.previewPane();
  const span = (text: string | (() => string), fg: () => unknown, bold = false) =>
    jsx('span', {
      // Text nodes take colors and attributes only through `style`.
      get style() {
        return { fg: fg(), bold };
      },
      get children() {
        return typeof text === 'function' ? text() : text;
      }
    });

  /** The `esc` hint, which closes the browser on click. */
  const closeHint = () =>
    jsx('text', {
      flexShrink: 0,
      wrapMode: 'none',
      get fg() {
        return theme().text.muted;
      },
      onMouseUp: (event: MouseEvent) => {
        event.stopPropagation();
        props.close();
      },
      children: 'esc'
    });

  /** ` for <project>` after "Sessions" while the list shows one project, else nothing. */
  const projectSuffix = () =>
    scope() === 'project' && projectLabel() ? ` for ${projectLabel()}` : '';
  /**
   * The header pieces that fit the left column. They drop in order (the project, then the tab
   * icons, then the counts) instead of the text getting cut mid-word, which happens on narrow
   * terminals and with long project names.
   */
  const headerFit = createMemo((): HeaderFit => {
    const counts = model.counts();
    // Whole cells the header row has for its text, besides the `esc` hint when it sits here.
    const room = leftWidth() - 2 * HEADER_PADDING - (wide() ? 0 : cells('esc') + ESC_GAP);
    const fixed = cells(TITLE) + TABS_INDENT + TAB_GAP * (VIEWS.length - 1);
    /** Cells the header text takes with `fit`'s pieces shown. */
    const size = (fit: HeaderFit) =>
      fixed +
      (fit.project ? cells(projectSuffix()) : 0) +
      VIEWS.reduce(
        (total, view) =>
          total + cells(tabLabel(view, fit.icons)) + (fit.counts ? cells(` ${counts[view]}`) : 0),
        0
      );
    return HEADER_FITS.find((fit) => size(fit) <= room) ?? LABELS_ONLY;
  });

  const titleColors = createMemo(() => titleGradient(TITLE, theme(), context.themeMode));
  const header = jsx('box', {
    flexDirection: 'row',
    height: 1,
    flexShrink: 0,
    paddingLeft: HEADER_PADDING,
    paddingRight: HEADER_PADDING,
    children: [
      jsx('text', {
        flexShrink: 0,
        wrapMode: 'none',
        children: [
          // One span per character, each with its own step of the fade.
          ...Array.from(TITLE).map((character, index) =>
            span(character, () => titleColors()[index] ?? theme().text.base, true)
          ),
          span(
            () => (headerFit().project ? projectSuffix() : ''),
            () => theme().text.muted
          )
        ]
      }),
      jsx('box', {
        flexDirection: 'row',
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        paddingLeft: TABS_INDENT,
        // Clips only when even the bare tab names do not fit, so the cut tabs stop short of `esc`
        // instead of running under it.
        overflow: 'hidden',
        gap: TAB_GAP,
        // One text per tab, since spans take no pointer events: a left click switches the view.
        children: VIEWS.map((view) => {
          const current = () => memory.view === view && !data.search;
          return jsx('text', {
            flexShrink: 0,
            wrapMode: 'none',
            onMouseUp: (event: MouseEvent) => {
              if (event.button !== MouseButton.LEFT) return;
              event.stopPropagation();
              setView(view);
            },
            get children() {
              const fit = headerFit();
              return [
                span(
                  tabLabel(view, fit.icons),
                  () => (current() ? theme().text.base : theme().text.muted),
                  current()
                ),
                // A view with sessions in it reads in the base color, an empty one stays muted.
                ...(fit.counts
                  ? [
                      span(
                        () => ` ${model.counts()[view]}`,
                        () => (model.counts()[view] > 0 ? theme().text.base : theme().text.muted)
                      )
                    ]
                  : [])
              ];
            }
          });
        })
      }),
      // With the preview open, `esc` moves to the top right of the preview column.
      jsx('box', {
        flexShrink: 0,
        paddingLeft: ESC_GAP,
        get visible() {
          return !wide();
        },
        children: closeHint()
      })
    ]
  });

  const search = jsx('box', {
    flexDirection: 'row',
    height: 1,
    flexShrink: 0,
    marginTop: 1,
    marginLeft: 2,
    marginRight: 2,
    children: [
      jsx('input', {
        flexGrow: 1,
        value: memory.query,
        placeholder: 'Search sessions, #numbers, PR and issue titles',
        // The host's search field tokens, so the field reads as the same control.
        get textColor() {
          return theme().text.formfield.focused;
        },
        get focusedTextColor() {
          return theme().text.formfield.focused;
        },
        get placeholderColor() {
          return theme().text.muted;
        },
        get focusedBackgroundColor() {
          return theme().background.formfield.focused;
        },
        get backgroundColor() {
          return theme().background.formfield.focused;
        },
        get cursorColor() {
          return theme().text.formfield.focused;
        },
        ref: (value: InputRenderable) => {
          input = value;
        },
        onInput: setQuery
      }),
      // Local matches are already on screen; this only says more may arrive from the server.
      jsx('text', {
        flexShrink: 0,
        wrapMode: 'none',
        get visible() {
          return data.search?.status === 'searching' && data.search.sessions.length > 0;
        },
        get fg() {
          return theme().text.muted;
        },
        get bg() {
          return theme().background.formfield.focused;
        },
        children: ' searching… '
      })
    ]
  });

  const list = jsx('box', {
    flexDirection: 'column',
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    paddingLeft: 1,
    paddingRight: 1,
    ref: (value: BoxRenderable) => {
      listBox = value;
    },
    onSizeChange: () => {
      setListHeight(listBox?.height ?? 0);
      // Without the list's own padding.
      setListWidth(Math.max(0, (listBox?.width ?? 0) - 2));
    },
    onMouseScroll: (event: MouseEvent) => {
      const direction = event.scroll?.direction;
      if (direction !== 'up' && direction !== 'down') return;
      const max = Math.max(0, lines().length - listHeight());
      const next = Math.min(max, Math.max(0, memory.scroll + (direction === 'up' ? -3 : 3)));
      remember({ scroll: next });
    },
    children: [
      jsx('box', {
        paddingLeft: 1,
        flexShrink: 0,
        get visible() {
          return listMessage() !== undefined;
        },
        children: jsx('text', {
          get fg() {
            return listMessage()?.error ? theme().text.feedback.error.base : theme().text.muted;
          },
          get children() {
            return listMessage()?.text ?? '';
          }
        })
      }),
      createComponent(Index, {
        get each() {
          return visible();
        },
        children: renderLine
      })
    ]
  });

  // The list draws only the lines on screen, so it has no scrollbox to carry a bar. This is the
  // native slider a scrollbox draws, in the colors of the host's session transcript bar
  // (routes/session/index.tsx `verticalScrollbarOptions`), shown under the same setting.
  let slider: SliderRenderable | undefined;
  const listBar = jsx('box', {
    width: 1,
    flexShrink: 0,
    // Only while the list overflows: with nothing to scroll the slider is one solid column.
    get visible() {
      return cli.session.scrollbar && lines().length > listHeight();
    },
    ref: (value: BoxRenderable) => {
      slider = new SliderRenderable(context.renderer, {
        orientation: 'vertical',
        width: 1,
        height: '100%',
        // Dragging or clicking the track scrolls the list.
        onChange: (position) => remember({ scroll: Math.round(position) })
      });
      value.add(slider);
    }
  });
  createEffect(() => {
    if (!slider || slider.isDestroyed) return;
    slider.backgroundColor = theme().decrease(theme().background.raised.base);
    slider.foregroundColor = theme().border.base;
    slider.max = Math.max(0, lines().length - listHeight());
    slider.viewPortSize = Math.max(1, listHeight());
    slider.value = memory.scroll;
  });

  /**
   * The preview's share of the panel; the list column takes the rest. A fixed split, so the
   * columns stay put whatever sessions the list holds.
   */
  const split = (): number => settings.previewWidth();
  /** Cells of the preview column, its blank first cell included. */
  const previewWidth = () => Math.floor(panelWidth() * split());
  const pane = createComponent(Preview, {
    context,
    options: props.options,
    selected: () => (wide() ? memory.selected : undefined),
    // The column's blank first cell plus the pane's padding on each side.
    width: () => previewWidth() - 3,
    session: (sessionID) => {
      const found = rows().find((session) => session.id === sessionID);
      return found ? live(found) : context.data.session.get(sessionID);
    },
    refs: (sessionID) => data.refs[sessionID],
    branch: branchOf,
    project: () => (scope() === 'project' ? projectID() : undefined),
    running: model.running,
    selectedRef: () => {
      const ref = workRef();
      return ref ? refKey(ref) : undefined;
    },
    // The session view's surface, not the dialog's, so the transcript looks as it does there.
    theme: () => context.theme
  });
  // A full-height column beside the list, with `esc` on the line of the browser's header.
  const preview = jsx('box', {
    flexDirection: 'column',
    flexShrink: 0,
    paddingTop: 1,
    paddingBottom: 1,
    get backgroundColor() {
      return sessionBackground(context.theme);
    },
    get visible() {
      return wide();
    },
    get width() {
      return previewWidth();
    },
    // One blank cell where a divider would be: the column's background already sets it apart.
    paddingLeft: 1,
    children: [
      jsx('box', {
        flexDirection: 'row',
        height: 1,
        flexShrink: 0,
        justifyContent: 'flex-end',
        paddingRight: 2,
        children: closeHint()
      }),
      jsx('box', {
        flexDirection: 'row',
        flexGrow: 1,
        flexShrink: 1,
        minHeight: 0,
        children: pane
      })
    ]
  });

  // "key action" pairs like the host's prompt footer (`ctrl+p commands`), actions on the selected
  // session on the left and the list-wide scope toggle on the right.
  const footerItems = createMemo((): Array<[string, string]> => {
    if (focus() === 'work')
      return [
        ['open', 'enter'],
        ['back', 'left']
      ];
    // The same hints in the same places whatever the state, so the eye learns where each key is;
    // the rest of the actions live in the keys dialog.
    return [
      ['peek', 'space'],
      // Same key and place in every view; only the word follows what ctrl+s does there.
      [memory.view === 'archived' ? 'restore' : 'archive', 'ctrl+s'],
      ['done', DONE_KEY],
      ['keys', 'ctrl+/']
    ];
  });
  const scopeHint = (): [string, string] => [
    scope() === 'project' ? 'all projects' : 'this project',
    'ctrl+a'
  ];
  const hint = ([title, key]: [string, string], index: number) => [
    ...(index > 0 ? [span(' '.repeat(HINT_GAP), () => theme().text.muted)] : []),
    span(key, () => theme().text.base),
    span(` ${title}`, () => theme().text.muted)
  ];
  /**
   * The hints in rows across the whole panel, in order. A hint that does not fit starts the next
   * row instead of being dropped, and is never cut in half, which would read as a different key.
   * The first row keeps room for the scope hint at its right end.
   */
  const footerRows = createMemo(() => {
    const width = Math.max(0, panelWidth() - 2 * FOOTER_PADDING);
    const size = ([title, key]: [string, string]) => cells(`${title} ${key}`);
    let room = width - size(scopeHint()) - HINT_GAP;
    const rows: Array<Array<[string, string]>> = [[]];
    for (const item of footerItems()) {
      const row = rows[rows.length - 1] ?? [];
      const needed = size(item) + (row.length > 0 ? HINT_GAP : 0);
      if (row.length > 0 && needed > room) {
        rows.push([item]);
        room = width - size(item);
        continue;
      }
      row.push(item);
      room -= needed;
    }
    return rows;
  });
  // Under both columns, so the preview's height never costs a hint.
  const footer = jsx('box', {
    flexDirection: 'column',
    flexShrink: 0,
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: FOOTER_PADDING,
    paddingRight: FOOTER_PADDING,
    children: createComponent(Index, {
      get each() {
        return footerRows();
      },
      children: (row: () => Array<[string, string]>, index: number) =>
        jsx('box', {
          flexDirection: 'row',
          height: 1,
          flexShrink: 0,
          children: [
            jsx('text', {
              flexGrow: 1,
              flexShrink: 1,
              minWidth: 0,
              wrapMode: 'none',
              get children() {
                return row().flatMap(hint);
              }
            }),
            ...(index === 0
              ? [
                  jsx('text', {
                    flexShrink: 0,
                    wrapMode: 'none',
                    get children() {
                      return hint(scopeHint(), 0);
                    }
                  })
                ]
              : [])
          ]
        })
    })
  });

  // Same dismissal rule as the host's dialog backdrop: a click outside the panel closes it, but
  // releasing a text selection there does not.
  let dismiss = false;
  // The left column: header, search and list. The preview column beside it runs down to the
  // hints, which span both.
  const left = jsx('box', {
    flexDirection: 'column',
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    paddingTop: 1,
    ref: (value: BoxRenderable) => {
      leftBox = value;
    },
    onSizeChange: () => setLeftWidth(leftBox?.width ?? 0),
    children: [
      header,
      search,
      jsx('box', { height: 1, flexShrink: 0 }),
      jsx('box', {
        flexDirection: 'row',
        flexGrow: 1,
        flexShrink: 1,
        minHeight: 0,
        children: [list, listBar]
      })
    ]
  });
  const panel = jsx('box', {
    flexGrow: 1,
    flexDirection: 'column',
    get backgroundColor() {
      return theme().background.base;
    },
    ref: (value: BoxRenderable) => {
      panelBox = value;
    },
    onSizeChange: () => setPanelWidth(panelBox?.width ?? 0),
    onMouseUp: (event: MouseEvent) => {
      if (context.renderer.getSelection()?.getSelectedText()) return;
      dismiss = false;
      event.stopPropagation();
    },
    children: [
      jsx('box', {
        flexDirection: 'row',
        flexGrow: 1,
        flexShrink: 1,
        minHeight: 0,
        children: [left, preview]
      }),
      footer
    ]
  });

  // Absolute inside the host's main column, so it covers the route and the horizontal tabs but
  // leaves the vertical tab rail alone. Host dialogs render in a later layer and draw above it.
  return jsx('box', {
    position: 'absolute',
    left: 0,
    top: 0,
    width: '100%',
    height: '100%',
    zIndex: 1000,
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    paddingRight: 2,
    backgroundColor: DIALOG_BACKDROP,
    onMouseDown: () => {
      dismiss = !!context.renderer.getSelection();
    },
    onMouseUp: () => {
      if (dismiss) {
        dismiss = false;
        return;
      }
      props.close();
    },
    children: panel
  });
}

/**
 * One line above the prompt of a peeked session: where the peek is in the browser's list and
 * the keys that move through it or go back.
 */
export function PeekBanner(props: PeekBannerProps) {
  const theme = () => props.context.theme;
  const span = (text: () => string, fg: (theme: ResolvedTheme) => unknown, bold = false) =>
    jsx('span', {
      get style() {
        return { fg: fg(theme()), bold };
      },
      get children() {
        return text();
      }
    });
  return jsx('box', {
    height: 1,
    flexShrink: 0,
    paddingLeft: 2,
    paddingRight: 2,
    // The warning pair keeps the label readable in dark and light themes (5.8:1 and 5.4:1 in
    // gruvbox, against 3.5:1 on the raised background), so the banner reads as a state.
    get backgroundColor() {
      return theme().background.feedback.warning.base;
    },
    children: jsx('text', {
      wrapMode: 'none',
      children: [
        span(
          () => {
            const position = props.position();
            return position ? `Peeking ${position.index} of ${position.total}` : 'Peeking';
          },
          (value) => value.text.feedback.warning.base,
          true
        ),
        // Key first, then the action muted, like the host's prompt footer.
        span(
          () => '   ↑↓',
          (value) => value.text.base
        ),
        span(
          () => ' switch',
          (value) => value.text.muted
        ),
        span(
          () => '   esc',
          (value) => value.text.base
        ),
        span(
          () => ' back to list',
          (value) => value.text.muted
        )
      ]
    })
  });
}

/** A view tab's name, after its icon when `icons` is set. Active has no icon. */
function tabLabel(view: PageView, icons: boolean): string {
  const icon = view === 'done' ? ICONS.done : view === 'archived' ? ICONS.archived : undefined;
  return icons && icon ? `${icon} ${VIEW_LABELS[view]}` : VIEW_LABELS[view];
}

/** Why a search listed the session, for the muted note on its title line. */
function matchLabel(reason: SearchReason | undefined, refs: Parameters<typeof findRef>[0]): string {
  if (reason === undefined || reason.match === 'title') return '';
  if (reason.match === 'body') return 'in messages';
  const ref = reason.ref === undefined ? undefined : findRef(refs, reason.ref);
  const kind = ref === undefined ? 'ref' : refKind(ref);
  if (reason.match === 'ref-title') return `${kind} title`;
  return ref === undefined ? 'ref number' : `${kind} ${refNumber(ref)}`;
}

/** How a ref's kind reads in a label. GitLab calls its pull requests merge requests. */
function refKind(ref: Ref): string {
  if (ref.kind === 'issue') return 'issue';
  return ref.provider === 'gitlab' ? 'MR' : 'PR';
}

/** Whether a renderable is still in the tree under `root`. */
function attached(root: Renderable, node: Renderable): boolean {
  for (let current: Renderable | null = node; current; current = current.parent) {
    if (current === root) return true;
  }
  return false;
}

/** Turns an RPC `link` failure into a short message. */
function linkError(error: unknown): string {
  const { type, data } = rpcError(error);
  if (type === 'invalid_reference') return 'Not a pull request or issue reference.';
  if (type === 'not_found') return 'Pull request or issue not found.';
  if (type === 'unavailable') {
    const provider =
      typeof data === 'object' && data !== null && 'provider' in data ? data.provider : undefined;
    const forge = provider === 'gitlab' ? 'GitLab' : provider === 'github' ? 'GitHub' : 'The forge';
    return `${forge} is unavailable. Run /super-sessions status for details.`;
  }
  return 'Could not link. Enable the opencode-super-sessions server plugin.';
}
