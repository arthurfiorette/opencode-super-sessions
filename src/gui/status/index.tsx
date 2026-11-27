import {
  type ClosedPanelTab,
  Command,
  ComposerPill,
  type Context,
  MenuItem,
  Panel,
  type PanelTab,
  type SessionRef,
  Slot,
  Style
} from '@opencode/plugin/gui';
import { HEADER_SLOT, PANEL_MENU, panelKey } from '../../host/gui.js';
import { LinkScopeProvider } from '../links.js';
import type { RefsStore, SessionTarget } from '../refs-store.js';
import { createPullDetails } from './details.js';
import { HeaderStatus } from './header.js';
import { mainPull, pillView, type StatusIcons } from './pill.js';
import css from './status.css?inline';
import { WorkList } from './work-list.js';

// A session's pull request status around its timeline: the refs in its title row, the Work side
// panel with its actions, and the main pull request's pill above the composer.

/** The Work panel's id, and its one tab's. */
const WORK = 'work';

/** Where a session's refs are asked for. */
function targetOf(
  session: Pick<SessionRef, 'server' | 'id'> & { directory: string }
): SessionTarget {
  return { server: session.server, sessionID: session.id, directory: session.directory };
}

/**
 * Adds the header slot, the Work panel with its menu item and command, and the composer pill.
 * `icons` are the plugin's declared icons, from `ctx.icons`.
 */
export function addStatus(ctx: Context, refs: RefsStore, icons: StatusIcons): void {
  ctx.add(Style, css);

  const key = panelKey(ctx.id, WORK);
  ctx.add(Slot, {
    at: HEADER_SLOT,
    render: (input) => (
      <LinkScopeProvider scope={{ session: () => input.session }}>
        <HeaderStatus
          refs={refs}
          // A hidden timeline stays mounted; it asks again once it shows.
          target={input.active ? targetOf(input.session) : undefined}
          compact={input.compact}
          workShown={ctx.layout.state(key, input.session) === 'visible'}
          // `toggle` closes the tab when it shows, else opens it, as the panel menu's item does.
          toggleWork={() => ctx.layout.toggle(key, input.session)}
        />
      </LinkScopeProvider>
    )
  });

  // One tab object for every session, so a session switch does not render its trigger again.
  const tab: PanelTab = {
    id: WORK,
    get title() {
      return ctx.t('work.title');
    }
  };
  ctx.add(Panel, {
    id: WORK,
    region: 'side',
    list: (input) => (input.open.includes(WORK) ? [tab] : []),
    closed: (): ClosedPanelTab => ({ icon: icons.pull }),
    render: (props) => (
      <LinkScopeProvider scope={{ session: () => props.session }}>
        <div class="ss-work-panel">
          <WorkList refs={refs} target={targetOf(props.session)} actions />
        </div>
      </LinkScopeProvider>
    )
  });

  /** Opens the routed session's Work tab and selects it. */
  const show = () => {
    const session = ctx.sessions.current();
    if (session !== undefined) ctx.layout.open(key, session, { tab: 'select' });
  };
  ctx.add(
    Command,
    (): Command => ({
      id: WORK,
      title: ctx.t('command.work'),
      enabled: ctx.sessions.current() !== undefined,
      run: show
    })
  );
  ctx.add(MenuItem, (): MenuItem | undefined => {
    const session = ctx.sessions.current();
    if (session === undefined) return undefined;
    return {
      menu: PANEL_MENU,
      id: WORK,
      title: ctx.t('work.title'),
      icon: icons.pull,
      opened: ctx.layout.state(key, session) !== 'closed',
      run: show
    };
  });

  // The pill shows above the routed session's composer, so only its refs are read here. The
  // header of the same session reads the same store entry.
  const routed = () => {
    const session = ctx.sessions.current();
    return session === undefined ? undefined : targetOf(session);
  };
  const state = refs.use(routed);
  const details = createPullDetails({
    target: routed,
    pulls: () => {
      const pull = mainPull(state()?.view);
      return pull?.state.review?.checks === undefined ? [] : [pull];
    }
  });
  ctx.add(ComposerPill, {
    id: 'pull',
    show: (input) => {
      const current = routed();
      if (current === undefined || current.sessionID !== input.session.id) return undefined;
      if (current.server.id !== input.session.server.id) return undefined;
      return pillView(ctx, icons, input.session, state()?.view, details);
    }
  });
}
