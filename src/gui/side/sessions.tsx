import type { SessionInfo } from '@opencode/client';
import { type MountedSession, type SessionRef, usePlugin } from '@opencode/plugin/gui';
import {
  createEffect,
  createMemo,
  createSelector,
  createSignal,
  For,
  type JSX,
  Match,
  onCleanup,
  Switch
} from 'solid-js';
import { openSessionKeepingTab } from '../../host/gui.js';
import { activityTime, isUnread } from '../../host/session-info.js';
import { rowsOf } from '../../page/state.js';
import type { SessionRefView } from '../../rpc.js';
import { createRowActions, PluginNote, RowButtons } from '../browser/list.js';
import type { Machines, MachinesTarget, Origin } from '../browser/machines.js';
import { projectKey } from '../browser/projects.js';
import { onControl, RowLines, RowStatus, useAge } from '../browser/row.js';
import { createBrowserView } from '../browser/view.js';
import { type LinkScope, LinkScopeProvider } from '../links.js';
import { createStable } from '../stable.js';

// The side tab's session list: the routed project's active sessions, every worktree of it, in the
// Desktop sidebar's row style, running ones first, then by recency. It never remounts while the
// tab stays listed, and a route change touches only the rows that were and become current.

/** Detail lines a row lists under its title, pull requests first, before the rest fold into +N. */
const ROW_LINES = 2;

/** Props of {@link SideSessions}. */
export interface SideSessionsProps {
  /** Every server's browser model, the dialog's own. */
  readonly machines: Machines;
  /** The routed session. */
  readonly session: MountedSession;
  /** The side tab's layout key, whose state says whether it shows. */
  readonly panelKey: string;
  /** The tab is on screen; the list asks nothing of the servers while it is not. */
  readonly shown: boolean;
  /** Opens the session browser. */
  readonly browse: () => void;
}

/** The key of a session across machines. */
function sessionKey(server: string, id: string): string {
  return `${server}\n${id}`;
}

/**
 * The "Sessions" header with its "All sessions…" action, and the rows. A click on a row opens its
 * session in its tab, on the session's own server. Up, down and enter move and open while the
 * list has the focus, and `alt+s` and `alt+q` archive and mark Done the selected row; the tab
 * takes no key anywhere else.
 */
export function SideSessions(props: SideSessionsProps) {
  const ctx = usePlugin();
  const machines = props.machines;
  // The routed session as plain values, the same object while the route stays, so reads of it
  // do not fire on unrelated updates of the mounted session.
  const origin = createMemo(
    (): Origin => ({
      server: props.session.server.id,
      id: props.session.id,
      directory: props.session.directory
    }),
    undefined,
    {
      equals: (a, b) => a.server === b.server && a.id === b.id && a.directory === b.directory
    }
  );
  const target = createMemo((): MachinesTarget => ({ origin: origin(), pick: { type: 'routed' } }));
  const routedServer = createStable(() => props.session.server.id);
  const browser = createBrowserView(machines, {
    target,
    view: () => 'active',
    query: () => '',
    shown: () => props.shown
  });
  const store = browser.data;
  const row = createRowActions(
    ctx,
    browser,
    () => ctx.servers.get(props.session.server.id) ?? props.session.server
  );

  /**
   * The routed session's project on its server, once known. A string, cut from the route where it
   * holds still (src/gui/stable.ts), so a route to another session of the same project reaches
   * nothing below it.
   */
  const routedProject = createStable(() => {
    const { server, id } = origin();
    const model = machines.model(server);
    const info =
      model?.server.data.session.get(id) ??
      store.active.find((session) => session.id === id) ??
      store.archived.find((session) => session.id === id);
    return info === undefined ? undefined : projectKey(info);
  });
  /**
   * The project's active sessions, as the browser's Active view orders them: running first, then
   * newest. While another view lists another scope on the shared model, only the routed
   * project's rows show.
   */
  const rows = createMemo(
    () => {
      const project = routedProject();
      const server = routedServer();
      return rowsOf(browser.groups()).filter(
        (session) =>
          project === undefined ||
          (browser.serverOf(session.id)?.id === server && projectKey(session) === project)
      );
    },
    [],
    { equals: (a, b) => a.length === b.length && a.every((item, index) => item === b[index]) }
  );
  // Only the rows that were and become current update on a route change.
  const isCurrent = createSelector(() => sessionKey(origin().server, origin().id));
  const [selected, setSelected] = createSignal<string>();
  const isSelected = createSelector(selected);
  const selectedSession = () => rows().find((session) => session.id === selected());

  /** The open session a row's links belong to: its own tab's, else the routed one. */
  const linkScope = (id: string): LinkScope => ({
    session: (): SessionRef | undefined =>
      ctx.sessions
        .list()
        .find((open) => open.server.id === row.serverOf(id).id && open.id === id) ?? props.session
  });
  /**
   * Opens the session in its tab on its own server, focused, and keeps this tab on screen there
   * when it shows here (openSessionKeepingTab in src/host/gui.ts).
   */
  const open = (session: SessionInfo | undefined) => {
    if (session === undefined) return;
    setSelected(session.id);
    const keep = ctx.layout.state(props.panelKey, props.session) === 'visible';
    openSessionKeepingTab(
      ctx,
      props.panelKey,
      { server: row.serverOf(session.id).id, id: session.id },
      keep
    );
  };

  // The selected row scrolls into view as the keys move it.
  const elements = new Map<string, HTMLElement>();
  createEffect(() => {
    const key = selected();
    if (key !== undefined) elements.get(key)?.scrollIntoView?.({ block: 'nearest' });
  });
  /** Remembers a row's element while it is on screen; called from the row's `ref`. */
  const track = (key: string) => (element: HTMLElement) => {
    elements.set(key, element);
    onCleanup(() => {
      if (elements.get(key) === element) elements.delete(key);
    });
  };
  /** Moves the selection by `delta` rows; from none, down starts at the first. */
  const move = (delta: number) => {
    const list = rows();
    const index = list.findIndex((session) => session.id === selected());
    const next = index === -1 ? (delta > 0 ? 0 : list.length - 1) : index + delta;
    setSelected(list[Math.min(list.length - 1, Math.max(0, next))]?.id);
  };

  /**
   * The list's keys, only while the focus is inside it: the app keeps every key elsewhere. Enter
   * on a focused button or link stays that control's. `alt+s` and `alt+q` are matched by physical
   * key, since they type symbols on macOS.
   */
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const onButton = event.target instanceof Element && event.target.closest('button, a');
    if (event.altKey) {
      if (event.code === 'KeyS') void row.archive(selectedSession());
      else if (event.code === 'KeyQ') void row.toggleDone(selectedSession());
      else return;
    } else if (onButton) return;
    else if (event.key === 'ArrowDown') move(1);
    else if (event.key === 'ArrowUp') move(-1);
    else if (event.key === 'Enter') open(selectedSession());
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <section class="ss-side-sessions" aria-label={ctx.t('side.sessions')}>
      <div class="ss-side-header">
        <span class="ss-side-header-title">{ctx.t('side.sessions')}</span>
        <ctx.ui.Button
          variant="ghost-muted"
          size="small"
          class="ss-side-header-action"
          onClick={props.browse}
        >
          {ctx.t('side.sessions.all')}
        </ctx.ui.Button>
      </div>
      <PluginNote browser={browser} machines={machines} />
      <div
        class="ss-side-list"
        role="listbox"
        tabIndex={0}
        aria-label={ctx.t('side.sessions')}
        aria-busy={browser.loading()}
        on:keydown={onKeyDown}
      >
        <Switch>
          <Match when={store.status === 'loading' && rows().length === 0}>
            <div class="ss-state">
              <ctx.ui.Loader />
            </div>
          </Match>
          <Match when={store.status === 'error'}>
            <div class="ss-state">
              <p class="ss-note">{ctx.t('browser.error')}</p>
              <ctx.ui.Button variant="neutral" size="small" onClick={() => void browser.load(true)}>
                {ctx.t('browser.retry')}
              </ctx.ui.Button>
            </div>
          </Match>
          <Match when={rows().length === 0}>
            <p class="ss-note ss-side-empty">{ctx.t('side.sessions.empty')}</p>
          </Match>
          <Match when={true}>
            <For each={rows()}>
              {(item) => (
                <LinkScopeProvider scope={linkScope(item.id)}>
                  <SideRow
                    session={row.live(item)}
                    view={store.refs[item.id]}
                    current={isCurrent(sessionKey(row.serverOf(item.id).id, item.id))}
                    selected={isSelected(item.id)}
                    running={row.running(item)}
                    waiting={row.waiting(item.id)}
                    now={browser.now()}
                    actions={<RowButtons session={item} browser={browser} actions={row} />}
                    ref={track(item.id)}
                    onOpen={() => open(item)}
                  />
                </LinkScopeProvider>
              )}
            </For>
          </Match>
        </Switch>
      </div>
    </section>
  );
}

/** Props of {@link SideRow}. */
interface SideRowProps {
  readonly session: SessionInfo;
  readonly view: SessionRefView | undefined;
  /** The routed session's row. */
  readonly current: boolean;
  readonly selected: boolean;
  readonly running: boolean;
  readonly waiting: 'permission' | 'question' | undefined;
  readonly now: number;
  readonly actions: JSX.Element;
  readonly ref: (element: HTMLElement) => void;
  readonly onOpen: () => void;
}

/**
 * A session as the Desktop sidebar lists it (`SIDEBAR_ROW` in src/host/gui.ts): the 13px title,
 * faint until current, the muted age, the activity ring or the unread dot, which the current row
 * does not show, and at most {@link ROW_LINES} detail lines under it.
 */
function SideRow(props: SideRowProps) {
  const ctx = usePlugin();
  const age = useAge();
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the list's keys are the list's, on its root.
    <div
      ref={props.ref}
      class="ss-side-row"
      role="option"
      tabIndex={-1}
      aria-selected={props.selected}
      aria-current={props.current ? 'page' : undefined}
      data-state={props.current ? 'pressed' : undefined}
      data-selected={props.selected ? '' : undefined}
      data-session={props.session.id}
      title={props.session.title || ctx.t('browser.untitled')}
      onClick={(event) => {
        if (!onControl(event)) props.onOpen();
      }}
    >
      <div class="ss-side-row-head">
        <span class="ss-side-row-title">{props.session.title || ctx.t('browser.untitled')}</span>
        <span class="ss-row-actions">{props.actions}</span>
        <span class="ss-side-row-age">{age(activityTime(props.session), props.now)}</span>
        <RowStatus
          running={props.running}
          waiting={props.waiting}
          unread={!props.current && isUnread(props.session)}
        />
      </div>
      <RowLines view={props.view} limit={ROW_LINES} />
    </div>
  );
}
