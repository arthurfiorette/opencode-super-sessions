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
  RGBA,
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
import { createMarquee } from '../marquee.js';
import { type Ref, refKey, refNumber } from '../refs/ref.js';
import { rowRefs } from '../refs/summary.js';
import { ICONS } from './icons.js';
import { type PageProps, type PeekBannerProps, routeKey } from './page.js';
import { Preview } from './preview.js';
import {
  branchLine,
  cells,
  findRef,
  formatAge,
  type RowModel,
  refSegments,
  refsLine,
  type Segment,
  titleLine,
  titleRoom
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
// The host dialog's backdrop color.
const BACKDROP = RGBA.fromInts(0, 0, 0, 150);
const PREVIEW_MIN_COLUMNS = 120;
const REFRESH_INTERVAL = 60_000;
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
  const theme = () => context.theme.surface('dialog');
  const client = context.client;
  const [panelWidth, setPanelWidth] = createSignal(0);
  const [leftWidth, setLeftWidth] = createSignal(0);
  const [listHeight, setListHeight] = createSignal(0);
  const [listWidth, setListWidth] = createSignal(0);
  const [frame, setFrame] = createSignal(0);
  const [deleting, setDeleting] = createSignal<string>();
  const [projectLabel, setProjectLabel] = createSignal('');
  const settings = useCliSettings();
  const marquee = createMarquee({ animated: () => settings.animations });
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
  const refsOf = (session: SessionInfo): Segment[] =>
    refSegments({
      options: props.options,
      theme: theme(),
      mode: context.themeMode,
      refs: data.refs[session.id],
      matched: reason(session)?.ref
    });
  const lines = createMemo(() =>
    layoutLines(model.groups(), (session) => ({
      branch: branchOf(session) !== undefined,
      refs: refsOf(session).length > 0
    }))
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

  // Branch lines need each directory's VCS info, which the host fetches only on request.
  const synced = new Set<string>();
  createEffect(() => {
    for (const line of visible()) {
      if (line.kind !== 'title') continue;
      const directory = line.session.location.directory;
      if (synced.has(directory) || data.refs[line.session.id]?.branch !== undefined) continue;
      synced.add(directory);
      void context.data.location.vcs.sync({ directory }).catch(() => {});
    }
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
  createEffect(on(scope, sync, { defer: true }));
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
      if (!untrack(() => settings.animations)) return;
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
  // Rows take one to three lines; counting three per row keeps the jump on screen.
  const pageRows = () => Math.max(1, Math.floor(listHeight() / 3));
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
      await client.session.update({ sessionID: session.id, archived });
    } catch {
      toast(
        archived ? 'Could not archive the session.' : 'Could not restore the session.',
        'error'
      );
      return;
    }
    controller.archived(session.id, archived, Date.now());
    if (archived && props.options.closeTabOnArchive) context.ui.tabs.close(session.id);
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
      // An empty title asks the server to generate a new one.
      await client.session.update({ sessionID: session.id, title: '' });
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
        await client.session.update({ sessionID: session.id, archived: true });
        controller.archived(session.id, true, Date.now());
        if (props.options.closeTabOnArchive) context.ui.tabs.close(session.id);
      } catch {
        failed++;
      }
    }
    if (failed > 0) toast(`${failed} could not be archived.`, 'warning');
  };
  const openRef = () => {
    const session = selected();
    const view = session ? data.refs[session.id] : undefined;
    const primary = view ? rowRefs(view).primary : undefined;
    if (!view || !primary) {
      toast('No pull request or issue on this session.');
      return;
    }
    if (!openUrl(refUrl(primary, view.states[refKey(primary)])))
      toast('Could not open the browser.', 'error');
  };

  // Host dialogs push the "modal" mode above this one, which turns this layer off while a rename
  // prompt or confirm is open and back on when it closes. Created inside the component, so the
  // layer goes away with the browser.
  const commands: KeymapCommand[] = [
    { bind: 'up', title: 'Previous session', run: () => move(-1) },
    { bind: 'down', title: 'Next session', run: () => move(1) },
    { bind: 'pageup', title: 'Page up', run: () => move(-pageRows()) },
    { bind: 'pagedown', title: 'Page down', run: () => move(pageRows()) },
    { bind: 'home', title: 'First session', run: () => move(-rows().length) },
    { bind: 'end', title: 'Last session', run: () => move(rows().length) },
    { bind: 'return', title: 'Open session', run: () => open() },
    // Space also types into the search box. Returning false lets the key fall through to the
    // focused input, so peeking only takes the key while the search is empty.
    {
      bind: 'space',
      title: 'Peek session',
      run: () => {
        if (memory.query.length > 0) return false;
        if (memory.selected !== undefined) props.peek(memory.selected);
      }
    },
    { bind: 'escape', title: 'Close', run: props.close },
    {
      bind: 'tab',
      title: 'Next view',
      run: () => setView(VIEWS[(VIEWS.indexOf(memory.view) + 1) % VIEWS.length] ?? 'active')
    },
    // The host binds shift+tab to agent.cycle; this layer's mode is on top while the browser is
    // open, so the key cycles views here and agents everywhere else.
    {
      bind: 'shift+tab',
      title: 'Previous view',
      run: () =>
        setView(
          VIEWS[(VIEWS.indexOf(memory.view) + VIEWS.length - 1) % VIEWS.length] ?? 'active'
        )
    },
    {
      bind: 'ctrl+a',
      title: 'Toggle all projects',
      run: () =>
        void model
          .setPrefs((draft) => {
            draft.allProjects = !draft.allProjects;
          })
          .catch(() => {})
    },
    { bind: 'ctrl+s', title: 'Archive or restore', run: () => void archive() },
    { id: 'session.rename', title: 'Rename session', run: () => void rename() },
    { id: 'session.delete', title: 'Delete session', run: () => void remove() },
    {
      id: 'session.pin.toggle',
      title: 'Pin or unpin session',
      run: () => {
        const session = selected();
        if (session)
          void props.pins.toggle(session.id).catch(() => toast('Could not save pins.', 'error'));
      }
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
      id: 'app.exit',
      title: 'Close',
      run: () => {
        if (memory.query.length === 0) return props.close();
        if (input) input.value = '';
        setQuery('');
      }
    }
  ];
  context.keymap.layer(() => ({ mode: MODE, priority: 1, commands }));

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

  // The pointer leaves one line of a row and enters the next in two events; leaving waits a tick
  // so moving within a row does not restart its marquee.
  let hovered: string | undefined;
  const hover = (session: SessionInfo) => {
    hovered = session.id;
    select(session.id);
    const current = rowModel(session);
    marquee.enter(session.id, current.title, titleRoom(current));
  };
  const leave = (session: SessionInfo) => {
    if (hovered === session.id) hovered = undefined;
    setTimeout(() => {
      if (hovered !== session.id) marquee.leave(session.id);
    }, 0);
  };

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
      const text = settings.animations ? (SPINNER[frame() % SPINNER.length] ?? '') : '⋯';
      return { text, fg: theme().text.muted };
    }
    const info = live(session);
    const unread =
      info.time.idle !== undefined &&
      (info.time.viewed === undefined || info.time.idle > info.time.viewed);
    return unread ? { text: '●', fg: theme().text.feedback.info.base } : undefined;
  };

  const rowModel = (session: SessionInfo): RowModel => {
    const info = live(session);
    const now = model.now();
    const archivedAt =
      memory.view === 'archived' && !data.search
        ? (session.time.archived ?? info.time.archived)
        : undefined;
    return {
      marker: markerOf(session),
      title:
        deleting() === session.id
          ? `Press ${shortcut('session.delete', 'ctrl+d')} again to delete`
          : info.title || 'Untitled session',
      label: matchLabel(reason(session), data.refs[session.id]),
      right:
        archivedAt === undefined
          ? // Padded to the widest age (`11mo`), so labels before it line up down the list.
            formatAge(now - info.time.updated).padStart(4)
          : `archived ${formatAge(now - archivedAt)} · updated ${formatAge(now - info.time.updated)}`,
      // The row box pads one cell on each side.
      width: listWidth() - 2,
      branch: branchOf(session),
      refs: refsOf(session),
      selected: memory.selected === session.id,
      deleting: deleting() === session.id,
      scroll: marquee.active() === session.id ? marquee.offset() : undefined
    };
  };

  /** One list line. The node is rebuilt only when the line changes kind or session. */
  const renderLine = (line: () => Line) => {
    const key = createMemo(() => {
      const value = line();
      return value.kind === 'header'
        ? `h:${value.title}`
        : value.kind === 'blank'
          ? 'b'
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
        const row = createMemo(() => rowModel(session()));
        const events = {
          hover: () => hover(session()),
          leave: () => leave(session()),
          open: () => open(session().id)
        };
        if (value.kind === 'title') return titleLine(theme, row, events);
        if (value.kind === 'branch') return branchLine(theme, row, events);
        return refsLine(theme, row, events);
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

  const wide = () => panelWidth() >= PREVIEW_MIN_COLUMNS;
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
  const closeHint = (visible: () => boolean) =>
    jsx('text', {
      flexShrink: 0,
      wrapMode: 'none',
      get visible() {
        return visible();
      },
      get fg() {
        return theme().text.muted;
      },
      onMouseUp: (event: MouseEvent) => {
        event.stopPropagation();
        props.close();
      },
      children: 'esc'
    });

  const header = jsx('box', {
    flexDirection: 'row',
    height: 1,
    flexShrink: 0,
    paddingLeft: 2,
    paddingRight: 2,
    children: [
      jsx('text', {
        flexShrink: 0,
        wrapMode: 'none',
        children: [
          span('Sessions', () => theme().text.base, true),
          span(
            () => (scope() === 'project' && projectLabel() ? ` for ${projectLabel()}` : ''),
            () => theme().text.muted
          )
        ]
      }),
      jsx('box', {
        flexDirection: 'row',
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        paddingLeft: 4,
        gap: 3,
        // One text per tab, since spans take no pointer events: a left click switches the view.
        children: VIEWS.map((view) => {
          const current = () => memory.view === view && !data.search;
          const icon =
            view === 'done' ? `${ICONS.done} ` : view === 'archived' ? `${ICONS.archived} ` : '';
          return jsx('text', {
            flexShrink: 0,
            wrapMode: 'none',
            onMouseUp: (event: MouseEvent) => {
              if (event.button !== MouseButton.LEFT) return;
              event.stopPropagation();
              setView(view);
            },
            get children() {
              return [
                span(
                  `${icon}${VIEW_LABELS[view]}`,
                  () => (current() ? theme().text.base : theme().text.muted),
                  current()
                ),
                span(` ${model.counts()[view]}`, () => theme().text.muted)
              ];
            }
          });
        })
      }),
      // With the preview open, `esc` moves to the top right of the preview column.
      closeHint(() => !wide())
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
    get visible() {
      return settings.session.scrollbar;
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

  const previewWidth = () => Math.floor(panelWidth() * props.options.previewWidth);
  const pane = createComponent(Preview, {
    context,
    options: props.options,
    selected: () => (wide() ? memory.selected : undefined),
    // Left border plus one cell of padding on each side.
    width: () => previewWidth() - 3,
    session: (sessionID) => {
      const found = rows().find((session) => session.id === sessionID);
      return found ? live(found) : context.data.session.get(sessionID);
    },
    refs: (sessionID) => data.refs[sessionID],
    branch: branchOf,
    running: model.running,
    theme
  });
  // A full-height column beside the list, with `esc` on the line of the browser's header.
  const preview = jsx('box', {
    flexDirection: 'column',
    flexShrink: 0,
    paddingTop: 1,
    paddingBottom: 1,
    get visible() {
      return wide();
    },
    get width() {
      return previewWidth();
    },
    border: ['left'],
    get borderColor() {
      return theme().border.base;
    },
    children: [
      jsx('box', {
        flexDirection: 'row',
        height: 1,
        flexShrink: 0,
        justifyContent: 'flex-end',
        paddingRight: 2,
        children: closeHint(() => true)
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

  // Same shape as the host's dialog footer: "title key" pairs, actions on the selected session
  // on the left and the list-wide scope toggle on the right.
  const footerItems = createMemo(() => {
    const current = selected();
    const items: Array<[string, string]> = [
      ['peek', 'space'],
      [memory.view === 'archived' ? 'restore' : 'archive', 'ctrl+s'],
      // Before the session actions: on narrow terminals the hints that do not fit are dropped,
      // and switching views is how the Done and Archived views are found at all.
      ['view', 'tab/shift+tab'],
      ['rename', shortcut('session.rename', 'ctrl+r')],
      ['retitle', shortcut('super-sessions.retitle', 'ctrl+t')],
      [
        current && props.pins.has(current.id) ? 'unpin' : 'pin',
        shortcut('session.pin.toggle', 'ctrl+f')
      ],
      ['delete', shortcut('session.delete', 'ctrl+d')]
    ];
    if (memory.view === 'done' && !data.search)
      items.push(['archive all', shortcut('super-sessions.archive.done', 'ctrl+y')]);
    items.push(
      ['link', shortcut('super-sessions.link', 'ctrl+l')],
      ['open PR', shortcut('super-sessions.open.ref', 'ctrl+g')]
    );
    return items;
  });
  const scopeHint = (): [string, string] => [
    scope() === 'project' ? 'all projects' : 'this project',
    'ctrl+a'
  ];
  const hint = ([title, key]: [string, string], index: number) => [
    ...(index > 0 ? [span('  ', () => theme().text.muted)] : []),
    span(title, () => theme().text.base),
    span(` ${key}`, () => theme().text.muted)
  ];
  const footer = jsx('box', {
    flexDirection: 'row',
    height: 1,
    flexShrink: 0,
    paddingLeft: 2,
    paddingRight: 2,
    children: [
      jsx('text', {
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        wrapMode: 'none',
        get children() {
          // Whole hints only: a hint cut in half reads as a different key.
          const [title, key] = scopeHint();
          let room = leftWidth() - 4 - cells(`${title} ${key}`) - 2;
          const shown = footerItems().filter(([itemTitle, itemKey], index) => {
            const size = cells(`${index > 0 ? '  ' : ''}${itemTitle} ${itemKey}`);
            if (size > room) {
              room = -1;
              return false;
            }
            room -= size;
            return true;
          });
          return shown.flatMap(hint);
        }
      }),
      jsx('text', {
        flexShrink: 0,
        wrapMode: 'none',
        get children() {
          return hint(scopeHint(), 0);
        }
      })
    ]
  });

  // Same dismissal rule as the host's dialog backdrop: a click outside the panel closes it, but
  // releasing a text selection there does not.
  let dismiss = false;
  // The left column: header, search, list and hints. The preview column beside it runs the
  // panel's full height.
  const left = jsx('box', {
    flexDirection: 'column',
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    paddingTop: 1,
    paddingBottom: 1,
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
      }),
      jsx('box', { height: 1, flexShrink: 0 }),
      footer
    ]
  });
  const panel = jsx('box', {
    flexGrow: 1,
    flexDirection: 'row',
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
    children: [left, preview]
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
    backgroundColor: BACKDROP,
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
    get backgroundColor() {
      return theme().background.raised.high;
    },
    children: jsx('text', {
      wrapMode: 'none',
      children: [
        span(
          () => {
            const position = props.position();
            return position ? `Peeking ${position.index} of ${position.total}` : 'Peeking';
          },
          (value) => value.text.base,
          true
        ),
        span(
          () => '   switch',
          (value) => value.text.base
        ),
        span(
          () => ' ↑↓',
          (value) => value.text.muted
        ),
        span(
          () => '   back to list',
          (value) => value.text.base
        ),
        span(
          () => ' esc',
          (value) => value.text.muted
        )
      ]
    })
  });
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
  const type =
    typeof error === 'object' && error !== null && 'type' in error ? error.type : undefined;
  if (type === 'invalid_reference') return 'Not a pull request or issue reference.';
  if (type === 'not_found') return 'Pull request or issue not found.';
  if (type === 'unavailable') return 'GitHub is unavailable. Run /super-sessions for details.';
  return 'Could not link. Enable the opencode-super-sessions server plugin.';
}
