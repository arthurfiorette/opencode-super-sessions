import {
  type Context,
  MenuItem,
  Panel,
  type PanelProps,
  type PanelTab,
  type Persisted,
  type SessionRef,
  Style,
  usePlugin
} from '@opencode/plugin/gui';
import { createEffect, createMemo, createSignal, on, untrack } from 'solid-js';
import { PANEL_MENU, panelKey, togglePinnedTab } from '../../host/gui.js';
import type { Machines } from '../browser/machines.js';
import { LinkScopeProvider } from '../links.js';
import { Octicon } from '../octicons.js';
import type { RefsStore, SessionTarget } from '../refs-store.js';
import type { StatusIcons } from '../status/pill.js';
import { listsAllProjects, type SidePrefs, workFolded } from './prefs.js';
import { SideSessions } from './sessions.js';
import css from './side.css?inline';
import { WorkSection } from './work.js';

// The Super Sessions side tab: the routed session's work above the active sessions of its project
// or of every project, in a tab pinned to every session's strip. It can stand in for the app's sidebar while in a session.

/** The panel's id, and its one tab's. */
const SIDE = 'sessions';

/** The side region's width for the tab until the user drags it, in CSS pixels. */
const WIDTH = 360;

/** What the session header reads and does with the side tab. */
export interface SideControls {
  /** Whether the tab is on screen in the session. */
  shown(session: SessionRef): boolean;
  /**
   * Shows the tab in the session with its Work section unfolded and scrolled into view, or hides
   * the side region while the tab shows there.
   */
  toggleWork(session: SessionRef): void;
}

/** What {@link addSidePanel} needs from the rest of the GUI. */
export interface SideDeps {
  readonly refs: RefsStore;
  readonly icons: StatusIcons;
  /** Every server's browser model, the dialog's own. */
  readonly machines: Machines;
  readonly sidePrefs: Persisted<SidePrefs, SidePrefs>;
  /** Opens the session browser, as `cmd+shift+s` does. */
  readonly browse: () => void;
}

/** Where a session's refs are asked for. */
function targetOf(session: SessionRef & { directory: string }): SessionTarget {
  return { server: session.server, sessionID: session.id, directory: session.directory };
}

/** Adds the side tab and its `+` menu item, and returns what the session header uses. */
export function addSidePanel(ctx: Context, deps: SideDeps): SideControls {
  ctx.add(Style, css);
  const key = panelKey(ctx.id, SIDE);
  // Moves each time the header asks for the Work section; the render scrolls to it.
  const [revealed, setRevealed] = createSignal(0);
  const folded = () => workFolded(deps.sidePrefs.value);
  /** Folds or unfolds the Work section in every session. */
  const setFolded = (next: boolean) =>
    deps.sidePrefs.update((draft) => {
      if (next) delete draft.workFolded;
      else draft.workFolded = false;
      return undefined;
    });

  // One tab object for every session, so a session switch does not render its trigger again.
  // Pinned, the host lists it in every strip without storing it, and keeps it across switches.
  const tab: PanelTab = {
    id: SIDE,
    get title() {
      return ctx.t('side.title');
    },
    label: () => (
      <span class="ss-side-label">
        <Octicon name="git-pull-request" size={14} />
        <span>{ctx.t('side.title')}</span>
      </span>
    ),
    pinned: true,
    closable: false,
    draggable: false
  };
  ctx.add(Panel, {
    id: SIDE,
    region: 'side',
    width: WIDTH,
    mobile: { title: ctx.t('side.title'), order: 50, kind: 'menu', icon: deps.icons.pull },
    list: () => [tab],
    render: (props) => (
      <SidePanel
        {...props}
        deps={deps}
        panelKey={key}
        folded={folded()}
        setFolded={setFolded}
        revealed={revealed()}
      />
    )
  });

  // The `+` menu opens the tab in the routed session; launchers that skip open tabs leave it out.
  ctx.add(MenuItem, (): MenuItem | undefined => {
    const session = ctx.sessions.current();
    if (session === undefined) return undefined;
    return {
      menu: PANEL_MENU,
      id: SIDE,
      title: ctx.t('side.title'),
      icon: deps.icons.pull,
      opened: ctx.layout.state(key, session) !== 'closed',
      run: () => ctx.layout.open(key, session)
    };
  });

  return {
    shown: (session) => ctx.layout.state(key, session) === 'visible',
    toggleWork(session) {
      if (ctx.layout.state(key, session) !== 'visible') {
        setFolded(false);
        setRevealed((count) => count + 1);
      }
      togglePinnedTab(ctx.layout, key, session);
    }
  };
}

/** Props of {@link SidePanel}. */
interface SidePanelProps extends PanelProps {
  readonly deps: SideDeps;
  readonly panelKey: string;
  readonly folded: boolean;
  readonly setFolded: (folded: boolean) => void;
  /** Moves each time the header asks for the Work section. */
  readonly revealed: number;
}

/**
 * The tab's content. It renders once and follows the routed session through `props.session`,
 * across servers too, since its list covers every machine.
 */
function SidePanel(props: SidePanelProps) {
  const ctx = usePlugin();
  const deps = untrack(() => props.deps);
  let work: HTMLElement | undefined;
  createEffect(
    on(
      () => props.revealed,
      () => work?.scrollIntoView?.({ block: 'start' }),
      { defer: true }
    )
  );
  // A memo, so a route change that keeps the tab visible changes nothing that reads it.
  const shown = createMemo(() => ctx.layout.state(props.panelKey, props.session) === 'visible');
  /** Lists every project's sessions, or the routed project's again, and keeps the choice. */
  const setAllProjects = (all: boolean) =>
    deps.sidePrefs.update((draft) => {
      if (all) draft.scope = 'all';
      else delete draft.scope;
      return undefined;
    });
  return (
    <LinkScopeProvider scope={{ session: () => props.session }}>
      <div class="ss-side">
        <WorkSection
          refs={deps.refs}
          target={targetOf(props.session)}
          folded={props.folded}
          setFolded={props.setFolded}
          ref={(element) => {
            work = element;
          }}
        />
        <SideSessions
          machines={deps.machines}
          session={props.session}
          panelKey={props.panelKey}
          shown={shown()}
          allProjects={listsAllProjects(deps.sidePrefs.value)}
          setAllProjects={setAllProjects}
          browse={deps.browse}
        />
      </div>
    </LinkScopeProvider>
  );
}
