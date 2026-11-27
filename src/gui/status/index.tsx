import { ComposerPill, type Context, type SessionRef, Slot, Style } from '@opencode/plugin/gui';
import { HEADER_SLOT } from '../../host/gui.js';
import { LinkScopeProvider } from '../links.js';
import type { RefsStore, SessionTarget } from '../refs-store.js';
import type { SideControls } from '../side/index.js';
import { createPullDetails } from './details.js';
import { HeaderStatus } from './header.js';
import { mainPull, pillView, type StatusIcons } from './pill.js';
import css from './status.css?inline';

// A session's pull request status around its timeline: the refs in its title row, whose `+N`
// shows the side tab's Work section, and the main pull request's pill above the composer.

/** Where a session's refs are asked for. */
function targetOf(
  session: Pick<SessionRef, 'server' | 'id'> & { directory: string }
): SessionTarget {
  return { server: session.server, sessionID: session.id, directory: session.directory };
}

/**
 * Adds the header slot and the composer pill. `icons` are the plugin's declared icons, from
 * `ctx.icons`; `side` is the side tab the header's `+N` shows.
 */
export function addStatus(
  ctx: Context,
  refs: RefsStore,
  icons: StatusIcons,
  side: SideControls
): void {
  ctx.add(Style, css);

  ctx.add(Slot, {
    at: HEADER_SLOT,
    render: (input) => (
      <LinkScopeProvider scope={{ session: () => input.session }}>
        <HeaderStatus
          refs={refs}
          // A hidden timeline stays mounted; it asks again once it shows.
          target={input.active ? targetOf(input.session) : undefined}
          compact={input.compact}
          workShown={side.shown(input.session)}
          toggleWork={() => side.toggleWork(input.session)}
        />
      </LinkScopeProvider>
    )
  });

  // The pill shows above the routed session's composer, so only its refs are read here. The
  // header of the same session reads the same store entry.
  const routed = () => {
    const session = ctx.sessions.current();
    return session === undefined ? undefined : targetOf(session);
  };
  const state = refs.use(routed);
  const details = createPullDetails({
    queue: refs.queue,
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
