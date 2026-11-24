import type { Context } from '@opencode/plugin/gui';
import { FORGE_NAMES, linkFailure } from '../../link-failure.js';
import { type Ref, refKind, refNumber } from '../../refs/ref.js';
import { linkLabel } from '../../refs/work-link.js';
import { webUrl } from '../ref-view.js';
import type { RefsStore, SessionTarget } from '../refs-store.js';
import { rpcAt, rpcOn, serverPluginMissing } from '../server.js';

// What the Work list does to a session's work: open, copy, unlink, link and refresh. Mirrors the
// TUI browser's Work keys and link dialog (`src/page/view.ts`), with the app's dialogs and toasts.

/** The parts of the context the actions use. */
export type ActionContext = Pick<Context, 't' | 'system' | 'dialogs' | 'toast'>;

/** One row of the Work list an action applies to. */
export interface WorkItem {
  /** `refKey` of a ref, or a work link's key: what `unlink` takes. */
  readonly key: string;
  readonly url: string;
  /** How the item reads in a dialog or toast, such as `PR #12` or `Linear COR-1466`. */
  readonly label: string;
}

/** The actions of one session's Work list; see {@link workActions}. */
export interface WorkActions {
  open(item: WorkItem): void;
  copy(item: WorkItem): Promise<void>;
  /** Unlinks after the user confirms. Resolves once the list no longer shows the item. */
  unlink(item: WorkItem): Promise<void>;
  /** Asks for a URL, `owner/repo#N` or `#N` and links it. */
  link(): Promise<void>;
  /** Refetches the session's refs from the forges, and its git checkout. */
  refresh(): Promise<void>;
}

/** How a ref reads in a dialog or toast: `PR #12`, `MR !3` or `issue #7`. */
export function refLabel(ref: Ref): string {
  return `${refKind(ref)} ${refNumber(ref)}`;
}

/** The toast for a `link` that failed, by the error the server answered with. */
export function linkError(ctx: Pick<Context, 't'>, error: unknown): string {
  const failure = linkFailure(error);
  switch (failure.reason) {
    case 'invalid':
      return ctx.t('link.invalid');
    case 'not-found':
      return ctx.t('link.notFound');
    case 'disabled':
      return ctx.t('link.disabled', { forge: failure.forge ?? ctx.t('link.forge') });
    case 'unavailable':
      return ctx.t('link.unavailable', { forge: failure.forge ?? ctx.t('link.forge') });
    case 'missing':
      return ctx.t('link.missing');
    default:
      return ctx.t('link.failed');
  }
}

/**
 * The actions on `target()`'s work. Each re-reads the session's refs through `refs` after a
 * change, so every surface that shows them follows at once.
 */
export function workActions(
  ctx: ActionContext,
  refs: RefsStore,
  target: () => SessionTarget | undefined
): WorkActions {
  const error = (title: string) => void ctx.toast.show({ title, variant: 'error' });
  return {
    open(item) {
      if (webUrl(item.url)) ctx.system.openExternal(item.url);
    },
    async copy(item) {
      try {
        await ctx.system.copy(item.url);
        ctx.toast.show({ title: ctx.t('work.copied'), variant: 'success' });
      } catch {
        error(ctx.t('work.copyFailed'));
      }
    },
    async unlink(item) {
      const session = target();
      if (session === undefined) return;
      const confirmed = await ctx.dialogs.confirm({
        title: ctx.t('unlink.title', { label: item.label }),
        description: ctx.t('unlink.description'),
        confirm: ctx.t('unlink.confirm'),
        danger: true
      });
      if (!confirmed) return;
      try {
        await rpcOn(session.server).unlink(
          { sessionID: session.sessionID, key: item.key },
          await rpcAt(session.server, session.directory)
        );
      } catch {
        error(ctx.t('unlink.failed', { label: item.label }));
        return;
      }
      // The cached read, not a forge refresh, so the item leaves the list at once.
      await refs.reload(session);
    },
    async link() {
      const session = target();
      if (session === undefined) return;
      const reference = (
        await ctx.dialogs.prompt({
          title: ctx.t('link.title'),
          placeholder: ctx.t('link.placeholder'),
          submit: ctx.t('link.submit')
        })
      )?.trim();
      if (!reference) return;
      try {
        const linked = await rpcOn(session.server).link(
          { sessionID: session.sessionID, reference },
          await rpcAt(session.server, session.directory)
        );
        ctx.toast.show({
          title: ctx.t('link.done', {
            label: 'ref' in linked ? refLabel(linked.ref) : linkLabel(linked.url)
          }),
          variant: 'success'
        });
      } catch (failure) {
        error(linkError(ctx, failure));
        return;
      }
      await refs.reload(session);
    },
    async refresh() {
      const session = target();
      if (session === undefined) return;
      try {
        const answer = await rpcOn(session.server).refresh(
          { sessionIDs: [session.sessionID], force: true },
          await rpcAt(session.server, session.directory)
        );
        const failed = answer[session.sessionID]?.failed ?? [];
        if (failed.length > 0) {
          error(
            ctx.t('refresh.failed', {
              forges: failed.map((provider) => FORGE_NAMES[provider]).join(' and ')
            })
          );
        }
      } catch (failure) {
        error(ctx.t(serverPluginMissing(failure) ? 'refresh.missing' : 'refresh.error'));
        return;
      }
      await refs.reload(session);
    }
  };
}
