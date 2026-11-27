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
import { createMemo, untrack } from 'solid-js';
import { PANEL_MENU, panelKey, togglePinnedTab } from '../../host/gui.js';
import type { Machines } from '../browser/machines.js';
import { LinkScopeProvider } from '../links.js';
import { Octicon } from '../octicons.js';
import type { RefsStore, SessionTarget } from '../refs-store.js';
import type { StatusIcons } from '../status/pill.js';
import { type SidePrefs, workingCollapsed } from './prefs.js';
import css from './side.css?inline';
import { WorkSection } from './work.js';
import { WorkingSection } from './working-section.js';

// The Super Sessions side tab: the routed session's work, and under it the sessions that need the
// user on every machine, in a tab pinned to every session's strip.

/** The panel's id, and its one tab's. */
const SIDE = 'sessions';

/** The side region's width for the tab until the user drags it, in CSS pixels. */
const WIDTH = 360;

/** What the session header reads and does with the side tab. */
export interface SideControls {
  /** Whether the tab is on screen in the session. */
  shown(session: SessionRef): boolean;
  /** Shows the tab in the session, whose Work is always listed, or hides the side region while it shows. */
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
    render: (props) => <SidePanel {...props} deps={deps} panelKey={key} />
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
    toggleWork: (session) => togglePinnedTab(ctx.layout, key, session)
  };
}

/** Props of {@link SidePanel}. */
interface SidePanelProps extends PanelProps {
  readonly deps: SideDeps;
  readonly panelKey: string;
}

/**
 * The tab's content. It renders once and follows the routed session through `props.session`,
 * across servers too, since the Working section covers every machine.
 */
function SidePanel(props: SidePanelProps) {
  const ctx = usePlugin();
  const deps = untrack(() => props.deps);
  // A memo, so a route change that keeps the tab visible changes nothing that reads it.
  const shown = createMemo(() => ctx.layout.state(props.panelKey, props.session) === 'visible');
  /** Collapses or expands the Working section in every session, and keeps the choice. */
  const setCollapsed = (collapsed: boolean) =>
    deps.sidePrefs.update((draft) => {
      if (collapsed) draft.workingCollapsed = true;
      else delete draft.workingCollapsed;
      return undefined;
    });
  return (
    <LinkScopeProvider scope={{ session: () => props.session }}>
      <div class="ss-side">
        <WorkSection refs={deps.refs} target={targetOf(props.session)} />
        <WorkingSection
          machines={deps.machines}
          session={props.session}
          panelKey={props.panelKey}
          shown={shown()}
          collapsed={workingCollapsed(deps.sidePrefs.value)}
          setCollapsed={setCollapsed}
          browse={deps.browse}
        />
      </div>
    </LinkScopeProvider>
  );
}
