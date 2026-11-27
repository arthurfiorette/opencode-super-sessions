import type { SessionInfo } from '@opencode/client';
import {
  type MountedSession,
  type Persisted,
  type SessionRef,
  usePlugin
} from '@opencode/plugin/gui';
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import { openSessionKeepingTab, type ProjectLook } from '../../host/gui.js';
import { type PageView, VIEWS } from '../../page/state.js';
import { TAB_ICONS } from '../browser/dialog.js';
import {
  createListState,
  createRailPick,
  createRowActions,
  ListBody,
  PluginNote,
  RowButtons,
  railSources
} from '../browser/list.js';
import type { Machines, Origin } from '../browser/machines.js';
import type { BrowserPrefs } from '../browser/prefs.js';
import { createRail } from '../browser/rail.js';
import { ProjectRail } from '../browser/rail-view.js';
import { PullItem, SessionRow } from '../browser/row.js';
import { createBrowserView } from '../browser/view.js';
import { type LinkScope, LinkScopeProvider } from '../links.js';
import { Octicon } from '../octicons.js';
import { sessionProjectLook } from '../project-avatar.js';

// The side tab's session list: the browser's rows, views, search and project rail over every
// machine's browser model, without the preview. It never remounts while the tab stays listed, so
// the selection, the scroll and the search survive session switches.

/** Props of {@link SideSessions}. */
export interface SideSessionsProps {
  /** Every server's browser model, the dialog's own. */
  readonly machines: Machines;
  /** The routed session. */
  readonly session: MountedSession;
  readonly prefs: Persisted<BrowserPrefs, BrowserPrefs>;
  /** The side tab's layout key, whose state says whether it shows. */
  readonly panelKey: string;
  /** The tab is on screen; the list asks nothing of the servers while it is not. */
  readonly shown: boolean;
}

/**
 * The views as a segmented control with their counts, the search field, the rail down the left
 * edge and the rows. A click on a row opens its session in its tab, on the session's own server.
 * Up, down and enter move and open while the list has the focus; the tab takes no key of its own
 * anywhere else.
 */
export function SideSessions(props: SideSessionsProps) {
  const ctx = usePlugin();
  const machines = props.machines;
  const [view, setView] = createSignal<PageView>('active');
  const [query, setQuery] = createSignal('');
  /** The routed session, read where used, as the panel's session getter changes on a switch. */
  const origin = (): Origin => ({
    server: props.session.server.id,
    id: props.session.id,
    directory: props.session.directory
  });
  /** The routed session's server, as the window's server list holds it. */
  const routedServer = () => ctx.servers.get(props.session.server.id) ?? props.session.server;
  const browser = createBrowserView(machines, {
    target: () => ({ origin: origin(), pick: machines.pick() }),
    view,
    query,
    shown: () => props.shown
  });
  const store = browser.data;
  const list = createListState(browser, view);
  const row = createRowActions(ctx, browser, routedServer);
  const allProjects = () => machines.pick().type === 'all';

  const rail = createRail({
    ...railSources(machines),
    origin,
    local: () => {
      const project = props.session.project;
      return project === undefined
        ? undefined
        : { id: project.id, name: project.name, icon: project.icon };
    },
    all: allProjects
  });
  let listElement: HTMLDivElement | undefined;
  const { pickedTile, pickTile } = createRailPick(machines, rail, props.prefs, () => {
    list.setSelected(undefined);
    list.setPull(undefined);
    listElement?.scrollTo?.({ top: 0 });
  });

  /** The open session a row's links belong to: its own tab's, else the routed one. */
  const linkScope = (id: () => string | undefined): LinkScope => ({
    session: (): SessionRef | undefined => {
      const sessionID = id();
      return (
        ctx.sessions
          .list()
          .find(
            (open) =>
              sessionID !== undefined &&
              open.server.id === row.serverOf(sessionID).id &&
              open.id === sessionID
          ) ?? props.session
      );
    }
  });
  /** The row's project avatar in the all-projects list, as in the dialog. */
  const projectOf = (session: SessionInfo): ProjectLook | undefined => {
    if (!allProjects()) return undefined;
    const server = row.serverOf(session.id);
    const local = server.id === props.session.server.id ? props.session.project : undefined;
    return sessionProjectLook(
      server,
      session.projectID,
      session.location.directory,
      local === undefined ? undefined : { id: local.id, name: local.name, icon: local.icon }
    );
  };
  /**
   * Opens the session in its tab on its own server, focused, and keeps this tab on screen there
   * when it shows here (openSessionKeepingTab in src/host/gui.ts).
   */
  const open = (session: SessionInfo | undefined) => {
    if (session === undefined) return;
    list.setSelected(session.id);
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
    const key = view() === 'pulls' ? list.pull() : list.selected();
    if (key !== undefined) elements.get(key)?.scrollIntoView?.({ block: 'nearest' });
  });
  /** Remembers a row's element while it is on screen; called from the row's `ref`. */
  const track = (key: string) => (element: HTMLElement) => {
    elements.set(key, element);
    onCleanup(() => {
      if (elements.get(key) === element) elements.delete(key);
    });
  };

  /** The list's keys, only while it has the focus: the app keeps every other key. */
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) {
      return;
    }
    if (event.target instanceof Element && event.target.closest('button, a')) return;
    if (event.key === 'ArrowDown') list.move(1);
    else if (event.key === 'ArrowUp') list.move(-1);
    else if (event.key === 'Enter') open(list.current());
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const switchView = (to: PageView) => {
    setView(to);
    list.setSelected(undefined);
    list.setPull(undefined);
  };

  return (
    <div class="ss-side-sessions">
      <ProjectRail sections={rail.sections()} picked={pickedTile()} onPick={pickTile} />
      <div class="ss-side-main">
        <div class="ss-seg" role="tablist" aria-label={ctx.t('browser.views')}>
          <For each={VIEWS}>
            {(item) => (
              <button
                type="button"
                role="tab"
                class="ss-seg-item"
                aria-selected={view() === item}
                data-view={item}
                title={ctx.t(`browser.view.${item}`)}
                onClick={() => switchView(item)}
              >
                <Show
                  when={TAB_ICONS[item]}
                  fallback={<span class="ss-seg-label">{ctx.t(`browser.view.${item}`)}</span>}
                >
                  {(icon) => (
                    <>
                      <Octicon name={icon()} size={12} />
                      <span class="ss-visually-hidden">{ctx.t(`browser.view.${item}`)}</span>
                    </>
                  )}
                </Show>
                <span class="ss-tab-count">{browser.counts()[item]}</span>
              </button>
            )}
          </For>
        </div>
        <ctx.ui.TextInput
          type="search"
          size="normal"
          label={ctx.t('browser.search')}
          placeholder={ctx.t('browser.search')}
          value={query()}
          onInput={(value) => {
            setQuery(value);
            list.setSelected(undefined);
            list.setPull(undefined);
          }}
        />
        <PluginNote browser={browser} machines={machines} />
        <div
          ref={listElement}
          class="ss-list"
          role="listbox"
          tabIndex={0}
          aria-label={ctx.t(`browser.view.${view()}`)}
          aria-busy={browser.loading()}
          on:keydown={onKeyDown}
        >
          <ListBody
            browser={browser}
            list={list}
            view={view()}
            pull={(item) => (
              <LinkScopeProvider scope={linkScope(() => item.sessions[0]?.id)}>
                <PullItem
                  pull={item}
                  selected={list.pull() === item.key}
                  ref={track(item.key)}
                  onSelect={() => {
                    list.setPull(item.key);
                    open(item.sessions[0]);
                  }}
                  onOpen={() => open(item.sessions[0])}
                />
              </LinkScopeProvider>
            )}
            session={(item) => (
              <LinkScopeProvider scope={linkScope(() => item.id)}>
                <SessionRow
                  session={row.live(item)}
                  view={store.refs[item.id]}
                  selected={list.selected() === item.id}
                  current={
                    item.id === props.session.id &&
                    row.serverOf(item.id).id === props.session.server.id
                  }
                  running={row.running(item)}
                  waiting={row.waiting(item.id)}
                  now={browser.now()}
                  archivedAge={view() === 'archived' && store.search === undefined}
                  actions={<RowButtons session={item} browser={browser} actions={row} />}
                  project={projectOf(row.live(item))}
                  machine={browser.machine(item.id)}
                  ref={track(item.id)}
                  onSelect={() => open(item)}
                  onOpen={() => open(item)}
                />
              </LinkScopeProvider>
            )}
          />
        </div>
      </div>
    </div>
  );
}
