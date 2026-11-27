import { usePlugin } from '@opencode/plugin/gui';
import { createMemo, Show } from 'solid-js';
import { pullRequests } from '../../refs/summary.js';
import { workLines } from '../../refs/work.js';
import { useOpenUrl } from '../links.js';
import { RefLine } from '../ref-view.js';
import type { RefsStore, SessionTarget } from '../refs-store.js';
import { workActions } from '../status/actions.js';
import { mainPull } from '../status/pill.js';
import { WorkList } from '../status/work-list.js';

// The top of the side tab: the routed session's work, the Work list with its actions under a
// header that folds it to one line.

/** Props of {@link WorkSection}. */
export interface WorkSectionProps {
  readonly refs: RefsStore;
  /** The routed session. */
  readonly target: SessionTarget | undefined;
  readonly folded: boolean;
  readonly setFolded: (folded: boolean) => void;
  /** Receives the section's element, which the header's `+N` scrolls into view. */
  readonly ref: (element: HTMLElement) => void;
}

/**
 * The routed session's work. Its header names the count of pull requests and the main one's
 * state, and folds the list away. A session that tracks nothing shows one line with a link
 * action instead of an empty block.
 */
export function WorkSection(props: WorkSectionProps) {
  const ctx = usePlugin();
  const target = () => props.target;
  // The same store entry as the session's header and composer pill, so no other fetch.
  const state = props.refs.use(target);
  const view = () => state()?.view;
  const empty = createMemo(() => {
    const current = state();
    return current?.status === 'ready' && current.view !== undefined
      ? workLines(current.view).length === 0
      : false;
  });
  const pulls = () => {
    const current = view();
    return current === undefined ? 0 : pullRequests(current).length;
  };
  const main = () => mainPull(view());
  const actions = workActions(ctx, props.refs, target, useOpenUrl());
  return (
    <section
      ref={props.ref}
      class="ss-side-work"
      classList={{ 'ss-side-work-folded': props.folded && !empty() }}
      aria-label={ctx.t('side.work')}
    >
      <Show
        when={!empty()}
        fallback={
          <p class="ss-side-work-none">
            <span>{ctx.t('side.work.none')}</span>
            <button type="button" class="ss-side-link" onClick={() => void actions.link()}>
              {ctx.t('side.work.link')}
            </button>
          </p>
        }
      >
        <div class="ss-side-work-head">
          <button
            type="button"
            class="ss-side-fold"
            aria-expanded={!props.folded}
            aria-label={ctx.t(props.folded ? 'side.work.unfold' : 'side.work.fold')}
            onClick={() => props.setFolded(!props.folded)}
          >
            <ctx.ui.Icon name={props.folded ? 'chevron-right' : 'chevron-down'} />
            <span class="ss-side-work-title">{ctx.t('side.work')}</span>
            <Show when={pulls() > 0}>
              <span class="ss-side-work-count">{ctx.plural('side.work.pulls', pulls())}</span>
            </Show>
          </button>
          <Show when={main()}>
            {(pull) => (
              <span class="ss-side-work-main">
                <RefLine item={pull().ref} state={pull().state} titled={false} counts={false} />
              </span>
            )}
          </Show>
        </div>
        <Show when={!props.folded}>
          <div class="ss-side-work-body">
            <WorkList refs={props.refs} target={props.target} actions />
          </div>
        </Show>
      </Show>
    </section>
  );
}
