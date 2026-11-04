import { spawn } from 'node:child_process';
import path from 'node:path';
import type { LocationPublicInfo, SessionInfo } from '@opencode/client';
import type { KeymapCommand } from '@opencode/plugin/tui/context';
import {
  type BoxRenderable,
  type InputRenderable,
  type MouseEvent,
  TextAttributes
} from '@opentui/core';
import { useTerminalDimensions } from '@opentui/solid';
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
import { createStore, reconcile } from 'solid-js/store';
import { refKey } from '../refs/ref.js';
import { rowRefs } from '../refs/summary.js';
import { type SearchScope, SuperSessions } from '../rpc.js';
import { ICONS } from './icons.js';
import { PAGE, type PageProps } from './page.js';
import { firstLine, Preview } from './preview.js';
import {
  cells,
  detailLine,
  detailSegments,
  formatAge,
  formatCost,
  type RowModel,
  rightColumn,
  titleLine
} from './row.js';
import {
  createPageController,
  groupSessions,
  keepSelection,
  type Line,
  layoutLines,
  moveSelection,
  type PageData,
  type PageMemory,
  type PageScope,
  type PageView,
  rowsOf,
  scrollFor,
  VIEWS
} from './state.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
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

/** Full-page session browser: header, search, grouped list, preview and key hints. */
export default function SessionPage(props: PageProps) {
  const context = props.context;
  const theme = () => context.theme;
  const client = context.client;
  const dimensions = useTerminalDimensions();
  const [memory, setMemory] = context.storage.memory<PageMemory>('page', {
    initial: { query: '', view: 'active', selected: undefined, scroll: 0 }
  });
  const [prefs, setPrefs] = context.storage.store('page-prefs', {
    initial: { allProjects: false }
  });
  const remember = (patch: Partial<PageMemory>) =>
    setMemory((draft) => {
      Object.assign(draft, patch);
    });
  const scope = (): PageScope => (prefs.allProjects ? 'all' : 'project');
  const [listHeight, setListHeight] = createSignal(0);
  const [listWidth, setListWidth] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  const [frame, setFrame] = createSignal(0);
  const [deleting, setDeleting] = createSignal<string>();
  let input: InputRenderable | undefined;
  let listBox: BoxRenderable | undefined;

  // The page opens from a session, from home or from another plugin page; "this project" means
  // the project of the session it was opened from, like the built-in list.
  const location = () => {
    const back = props.data?.returnRoute;
    const from = back?.type === 'session' ? context.data.session.get(back.sessionID) : undefined;
    return from?.location ?? context.location ?? context.data.location.default();
  };
  let locationInfo: Promise<LocationPublicInfo> | undefined;
  const resolveLocation = () => {
    locationInfo ??= client.location.get({ location: { directory: location().directory } });
    return locationInfo;
  };
  const [projectLabel, setProjectLabel] = createSignal('');
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
      },
      async lastAssistantText(sessionID) {
        // A few messages, because the latest one may hold only tool calls.
        const page = await client.message.list({
          sessionID,
          order: 'desc',
          limit: 5,
          type: 'assistant'
        });
        for (const message of page.data) {
          if (message.type !== 'assistant') continue;
          const text = message.content.findLast((part) => part.type === 'text' && part.text.trim());
          if (text?.type === 'text') return firstLine(text.text);
        }
        return undefined;
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
      pins: props.pins.ids(),
      now: now()
    });
  const activeGroups = createMemo(() => groupsFor('active'));
  const doneGroups = createMemo(() => groupsFor('done'));
  const archivedGroups = createMemo(() => groupsFor('archived'));
  const counts = createMemo(() => ({
    active: rowsOf(activeGroups()).length,
    done: rowsOf(doneGroups()).length,
    archived: rowsOf(archivedGroups()).length
  }));
  const groups = createMemo(() => {
    if (data.search)
      return data.search.sessions.length > 0 ? [{ sessions: data.search.sessions }] : [];
    if (memory.view === 'done') return doneGroups();
    if (memory.view === 'archived') return archivedGroups();
    return activeGroups();
  });
  const rows = createMemo(() => rowsOf(groups()));
  const lines = createMemo(() => layoutLines(groups()));
  const visible = createMemo(() => lines().slice(memory.scroll, memory.scroll + listHeight()));
  const selected = () => rows().find((session) => session.id === memory.selected);
  const live = (session: SessionInfo) => context.data.session.get(session.id) ?? session;
  const slots = createMemo(() => new Map(props.pins.slots().map((id, index) => [id, index + 1])));

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

  const branchOf = (session: SessionInfo) => {
    const view = data.refs[session.id];
    const vcs = context.data.location.vcs.info(session.location)?.branch;
    const current = view?.branch ?? vcs?.current;
    const fallback = view?.defaultBranch ?? vcs?.default;
    return current && current !== fallback ? current : undefined;
  };
  const synced = new Set<string>();
  createEffect(() => {
    const sessions = visible().flatMap((line) => (line.kind === 'title' ? [line.session] : []));
    const needLast = sessions.filter((session) => {
      const view = data.refs[session.id];
      const refs = view ? rowRefs(view) : { extra: 0 };
      return (
        !branchOf(session) &&
        refs.primary === undefined &&
        refs.extra === 0 &&
        data.last[session.id] === undefined
      );
    });
    void controller.requestLast(needLast.map((session) => session.id));
    for (const session of sessions) {
      const directory = session.location.directory;
      if (synced.has(directory) || data.refs[session.id]?.branch !== undefined) continue;
      synced.add(directory);
      void context.data.location.vcs.sync({ directory }).catch(() => {});
    }
  });

  const visibleIDs = () =>
    untrack(() => visible().flatMap((line) => (line.kind === 'title' ? [line.session.id] : [])));
  const reload = () => controller.load(scope()).then(() => controller.refresh(visibleIDs()));
  createEffect(on(scope, () => void reload()));
  createEffect(() => controller.search(memory.query, memory.view === 'archived', scope()));
  onMount(() => {
    input?.focus();
    void resolveLocation()
      .then((info) => {
        const project = context.data.project.get(info.project.id);
        const root = project?.canonical ?? info.project.directory;
        setProjectLabel(info.project.id === 'global' ? '' : project?.name || path.basename(root));
      })
      .catch(() => {});
  });

  const timers = [
    setInterval(() => {
      setNow(Date.now());
      void controller.refresh(visibleIDs());
    }, REFRESH_INTERVAL),
    setInterval(() => {
      if (untrack(() => rows().some((session) => running(session.id))))
        setFrame((value) => value + 1);
    }, 80)
  ];
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleReload = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void controller.load(scope()), 500);
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
    ).map((type) => context.data.on(type, scheduleReload)),
    ...(
      [
        'session.execution.started',
        'session.execution.succeeded',
        'session.execution.failed',
        'session.execution.interrupted',
        'session.text.ended'
      ] as const
    ).map((type) =>
      context.data.on(type, (event) => {
        controller.invalidate(event.data.sessionID);
        if (type !== 'session.text.ended') scheduleReload();
      })
    )
  ];
  onCleanup(() => {
    for (const timer of timers) clearInterval(timer);
    clearTimeout(reloadTimer);
    for (const off of offs) off();
    controller.dispose();
  });

  const shortcut = (id: string, fallback: string) => context.keymap.shortcuts(id)[0] ?? fallback;
  const toast = (message: string, variant: 'info' | 'success' | 'warning' | 'error' = 'info') =>
    context.ui.toast.show({ message, variant });

  const select = (sessionID: string | undefined) => remember({ selected: sessionID });
  const move = (delta: number) => select(moveSelection(rows(), memory.selected, delta));
  const pageRows = () => Math.max(1, Math.floor(listHeight() / 2) - 1);
  const open = (sessionID = memory.selected) => {
    if (sessionID === undefined) return;
    context.ui.router.navigate({ type: 'session', sessionID });
  };
  const back = () => context.ui.router.navigate(props.data?.returnRoute ?? { type: 'home' });
  const setView = (view: PageView) =>
    setMemory((draft) => {
      draft.view = view;
      draft.selected = undefined;
      draft.scroll = 0;
    });

  const archive = async () => {
    const session = selected();
    if (!session) return;
    const archived = live(session).time.archived === undefined;
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
    // A dialog can leave the router elsewhere; come back with the same return route and state.
    const route = context.ui.router.current();
    if (route.type !== 'plugin' || route.name !== PAGE) {
      context.ui.router.navigate({ type: 'plugin', name: PAGE, data: { ...props.data } });
    }
    input?.focus();
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
    input?.focus();
    if (!reference?.trim()) return;
    try {
      const linked = await rpc().link(
        { sessionID: session.id, reference: reference.trim() },
        rpcOptions()
      );
      toast(`Linked ${linked.ref.kind === 'pr' ? 'PR' : 'issue'} #${linked.ref.number}`, 'success');
      void controller.refresh([session.id]);
    } catch (error) {
      toast(linkError(error), 'error');
    }
  };
  const archiveDone = async () => {
    const done = rowsOf(doneGroups());
    if (done.length === 0) return;
    const confirmed = await context.ui.dialog.confirm({
      title: 'Archive done sessions?',
      message: `Archive ${done.length} done ${done.length === 1 ? 'session' : 'sessions'}.`,
      label: { confirm: 'Archive' }
    });
    input?.focus();
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
    const url =
      view.states[refKey(primary)]?.url ??
      `https://${primary.host}/${primary.repo}/${primary.kind === 'pr' ? 'pull' : 'issues'}/${primary.number}`;
    if (!openUrl(url)) toast('Could not open the browser.', 'error');
  };

  // Base mode (the default) turns the layer off while a dialog is open, so prompts and confirms
  // get their keys. Created inside the component, so the layer goes away with the page.
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
    { bind: 'space', title: 'Peek session', run: () => (memory.query.length > 0 ? false : open()) },
    { bind: 'escape', title: 'Back', run: back },
    {
      bind: 'tab',
      title: 'Next view',
      run: () => setView(VIEWS[(VIEWS.indexOf(memory.view) + 1) % VIEWS.length] ?? 'active')
    },
    {
      bind: 'ctrl+a',
      title: 'Toggle all projects',
      run: () =>
        void setPrefs((draft) => {
          draft.allProjects = !draft.allProjects;
        }).catch(() => {})
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
    // Last on purpose: the host binds ctrl+d and ctrl+c to app.exit, and quitting OpenCode from
    // a list is never what the user meant. The specific bindings above win on shared keys.
    { id: 'app.exit', title: 'Back', run: back }
  ];
  context.keymap.layer(() => ({ commands }));

  const rowModel = (session: SessionInfo): RowModel => {
    const info = live(session);
    const slot = slots().get(session.id);
    const isRunning = running(session.id);
    const unread =
      info.time.idle !== undefined &&
      (info.time.viewed === undefined || info.time.idle > info.time.viewed);
    const marker =
      slot !== undefined
        ? { text: String(slot), fg: theme().text.formfield.focused }
        : isRunning
          ? { text: SPINNER[frame() % SPINNER.length] ?? '', fg: theme().text.feedback.info.base }
          : unread
            ? { text: '●', fg: theme().text.feedback.info.base }
            : undefined;
    const archivedAt = memory.view === 'archived' && !data.search ? info.time.archived : undefined;
    return {
      marker,
      title:
        deleting() === session.id
          ? `Press ${shortcut('session.delete', 'ctrl+d')} again to delete`
          : info.title || 'Untitled session',
      right: rightColumn(formatAge(now() - info.time.updated), formatCost(info.cost)),
      // The row box pads one cell on each side.
      width: listWidth() - 2,
      detail: detailSegments({
        options: props.options,
        theme: theme(),
        mode: context.themeMode,
        now: now(),
        branch: branchOf(session),
        refs: data.refs[session.id],
        last: data.last[session.id],
        archived:
          archivedAt === undefined ? undefined : { at: archivedAt, updated: info.time.updated }
      }),
      selected: memory.selected === session.id,
      deleting: deleting() === session.id
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
              get fg() {
                return theme().text.muted;
              },
              children: value.title
            })
          });
        }
        const initial = value.session;
        // Reads the latest line, but tolerates the moment before the key memo rebuilds this node.
        const session = () => {
          const current = line();
          return current.kind === 'title' || current.kind === 'detail' ? current.session : initial;
        };
        const model = createMemo(() => rowModel(session()));
        const events = { hover: () => select(session().id), open: () => open(session().id) };
        return value.kind === 'title'
          ? titleLine(theme, model, events)
          : detailLine(theme, model, events);
      });
    });
  };

  const listMessage = createMemo(() => {
    if (data.search) {
      if (data.search.status === 'error')
        return { text: 'Could not search sessions. Change the search to try again.', error: true };
      if (data.search.sessions.length > 0) return undefined;
      return {
        text: data.search.status === 'searching' ? 'Searching…' : 'No sessions found',
        error: false
      };
    }
    if (data.status === 'loading') return { text: 'Loading sessions…', error: false };
    if (data.status === 'error') return { text: 'Could not load sessions.', error: true };
    return rows().length === 0 ? { text: EMPTY[memory.view], error: false } : undefined;
  });

  const wide = () => dimensions().width >= PREVIEW_MIN_COLUMNS;
  const span = (text: string | (() => string), fg: () => unknown, bold = false) =>
    jsx('span', {
      get style() {
        return { fg: fg(), ...(bold ? { attributes: TextAttributes.BOLD } : {}) };
      },
      get children() {
        return typeof text === 'function' ? text() : text;
      }
    });

  const header = jsx('box', {
    flexDirection: 'row',
    height: 1,
    flexShrink: 0,
    paddingLeft: 1,
    paddingRight: 1,
    children: [
      jsx('text', {
        flexShrink: 0,
        wrapMode: 'none',
        children: [
          span('Sessions', () => theme().text.base, true),
          span(
            () => (scope() === 'project' && projectLabel() ? `  ${projectLabel()}` : ''),
            () => theme().text.muted
          )
        ]
      }),
      jsx('box', {
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        paddingLeft: 4,
        children: jsx('text', {
          wrapMode: 'none',
          get children() {
            return VIEWS.flatMap((view, index) => {
              const current = memory.view === view && !data.search;
              const icon =
                view === 'done'
                  ? `${ICONS.done} `
                  : view === 'archived'
                    ? `${ICONS.archived} `
                    : '';
              return [
                ...(index > 0 ? [span('    ', () => theme().text.muted)] : []),
                span(
                  `${icon}${VIEW_LABELS[view]} ${counts()[view]}`,
                  () => (current ? theme().text.base : theme().text.muted),
                  current
                )
              ];
            });
          }
        })
      }),
      jsx('text', {
        flexShrink: 0,
        wrapMode: 'none',
        get children() {
          return [
            span(
              scope() === 'project' ? 'this project ' : 'all projects ',
              () => theme().text.muted
            ),
            span('ctrl+a', () => theme().text.base),
            span('    ', () => theme().text.muted),
            span('esc', () => theme().text.base)
          ];
        }
      })
    ]
  });

  const search = jsx('box', {
    flexDirection: 'row',
    height: 1,
    flexShrink: 0,
    paddingLeft: 1,
    paddingRight: 1,
    children: [
      jsx('text', {
        flexShrink: 0,
        get fg() {
          return theme().text.muted;
        },
        children: '> '
      }),
      jsx('input', {
        flexGrow: 1,
        value: memory.query,
        placeholder: 'Search sessions, #numbers, PR and issue titles',
        get textColor() {
          return theme().text.base;
        },
        get focusedTextColor() {
          return theme().text.base;
        },
        get placeholderColor() {
          return theme().text.muted;
        },
        get backgroundColor() {
          return theme().background.base;
        },
        get focusedBackgroundColor() {
          return theme().background.base;
        },
        get cursorColor() {
          return theme().text.base;
        },
        ref: (value: InputRenderable) => {
          input = value;
        },
        onInput: (value: string) =>
          setMemory((draft) => {
            draft.query = value;
            draft.selected = undefined;
            draft.scroll = 0;
          })
      })
    ]
  });

  const list = jsx('box', {
    flexDirection: 'column',
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    ref: (value: BoxRenderable) => {
      listBox = value;
    },
    onSizeChange: () => {
      setListHeight(listBox?.height ?? 0);
      setListWidth(listBox?.width ?? 0);
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

  const previewWidth = () => Math.floor(dimensions().width * props.options.previewWidth);
  const preview = jsx('box', {
    flexDirection: 'row',
    flexShrink: 0,
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
    children: createComponent(Preview, {
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
      running
    })
  });

  const footerItems = createMemo(() => {
    const current = selected();
    const items: Array<[string, string]> = [
      ['↵', 'open'],
      ['space', 'peek'],
      ['ctrl+s', memory.view === 'archived' ? 'restore' : 'archive'],
      [shortcut('session.rename', 'ctrl+r'), 'rename'],
      [shortcut('super-sessions.retitle', 'ctrl+t'), 'retitle'],
      [
        shortcut('session.pin.toggle', 'ctrl+f'),
        current && props.pins.has(current.id) ? 'unpin' : 'pin'
      ],
      [shortcut('session.delete', 'ctrl+d'), 'delete'],
      ['tab', 'view']
    ];
    if (memory.view === 'done' && !data.search)
      items.push([shortcut('super-sessions.archive.done', 'ctrl+y'), 'archive all']);
    items.push(
      [shortcut('super-sessions.link', 'ctrl+l'), 'link'],
      [shortcut('super-sessions.open.ref', 'ctrl+g'), 'open PR']
    );
    return items;
  });
  const footer = jsx('box', {
    height: 1,
    flexShrink: 0,
    paddingLeft: 1,
    paddingRight: 1,
    children: jsx('text', {
      wrapMode: 'none',
      get children() {
        // Whole hints only: a hint cut in half reads as a different key.
        let room = dimensions().width - 2;
        const shown = footerItems().filter(([key, label], index) => {
          const size = cells(`${index > 0 ? '  ' : ''}${key} ${label}`);
          if (size > room) {
            room = -1;
            return false;
          }
          room -= size;
          return true;
        });
        return shown.flatMap(([key, label], index) => [
          ...(index > 0 ? [span('  ', () => theme().text.muted)] : []),
          span(key, () => theme().text.base),
          span(` ${label}`, () => theme().text.muted)
        ]);
      }
    })
  });

  return jsx('box', {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    get backgroundColor() {
      return theme().background.base;
    },
    children: [
      header,
      search,
      jsx('box', { height: 1, flexShrink: 0 }),
      jsx('box', {
        flexDirection: 'row',
        flexGrow: 1,
        flexShrink: 1,
        minHeight: 0,
        children: [list, preview]
      }),
      jsx('box', { height: 1, flexShrink: 0 }),
      footer
    ]
  });
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

/**
 * Opens a web URL with the OS opener. No shell is involved, and only http(s) URLs are passed,
 * so a crafted ref URL cannot run a command.
 */
function openUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  // `start` is a cmd.exe builtin and would need a shell; explorer.exe opens URLs directly.
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'explorer.exe'
        : 'xdg-open';
  try {
    const child = spawn(command, [parsed.href], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
