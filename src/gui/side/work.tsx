import { usePlugin } from '@opencode/plugin/gui';
import { createMemo, Match, Show, Switch } from 'solid-js';
import { pullRequests, trackedRefs, workLinks } from '../../refs/summary.js';
import { workLines } from '../../refs/work.js';
import { useOpenUrl } from '../links.js';
import { RefLine } from '../ref-view.js';
import type { RefsStore, SessionTarget } from '../refs-store.js';
import { workActions } from '../status/actions.js';
import { mainPull } from '../status/pill.js';
import { WorkList } from '../status/work-list.js';

// The top of the side tab: the routed session's work, folded by default into one summary line of
// one height, so switching sessions never moves the session list under it. Unfolded, the Work
// list takes its own height up to half the tab, and scrolls only past that.

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
 * The routed session's work. The summary line names what it tracks (`Work · 1 PR · 1 link`) with
 * the main pull request's state, and folds the list away; a session that tracks nothing reads
 * "Nothing linked" with a link action. Until the first answer for a session with nothing cached
 * the line reads only "Work" over a placeholder of the same height, so the previous session's
 * work never shows under the new one and "Nothing linked" never flashes.
 */
export function WorkSection(props: WorkSectionProps) {
  const ctx = usePlugin();
  const target = () => props.target;
  // The same store entry as the session's header and composer pill, seeded from the browser's
  // cached refs, so a switch shows the session's work at once.
  const state = props.refs.use(target);
  const view = () => {
    const current = state();
    return current?.status === 'ready' ? current.view : undefined;
  };
  const known = () => state()?.status === 'ready';
  const empty = createMemo(() => {
    const current = view();
    return known() && (current === undefined || workLines(current).length === 0);
  });
  /** The summary after "Work": what the session tracks, by kind. */
  const counts = createMemo(() => {
    const current = view();
    if (current === undefined) return [];
    const pulls = pullRequests(current).length;
    const issues = trackedRefs(current).filter((ref) => ref.kind === 'issue').length;
    const links = workLinks(current).length;
    return [
      ...(pulls > 0 ? [ctx.plural('side.work.pulls', pulls)] : []),
      ...(issues > 0 ? [ctx.plural('side.work.issues', issues)] : []),
      ...(links > 0 ? [ctx.plural('side.work.links', links)] : [])
    ];
  });
  const main = () => mainPull(view());
  const actions = workActions(ctx, props.refs, target, useOpenUrl());
  return (
    <section
      ref={props.ref}
      class="ss-side-work"
      data-folded={props.folded ? 'true' : 'false'}
      aria-label={ctx.t('side.work')}
    >
      <div class="ss-side-work-head" data-state={state()?.status ?? 'loading'}>
        <button
          type="button"
          class="ss-side-fold"
          aria-expanded={!props.folded}
          aria-label={ctx.t(props.folded ? 'side.work.unfold' : 'side.work.fold')}
          onClick={() => props.setFolded(!props.folded)}
        >
          <ctx.ui.Icon
            name={props.folded ? 'chevron-right' : 'chevron-down'}
            size="small"
            class="ss-side-fold-icon"
          />
          <Switch>
            <Match when={empty()}>
              <span class="ss-side-work-title">{ctx.t('side.work.none')}</span>
            </Match>
            <Match when={true}>
              <span class="ss-side-work-title">{ctx.t('side.work')}</span>
              <Show
                when={(state()?.status ?? 'loading') !== 'loading'}
                fallback={<span class="ss-side-work-placeholder" aria-hidden="true" />}
              >
                <span class="ss-side-work-count">
                  {counts()
                    .map((count) => ` · ${count}`)
                    .join('')}
                </span>
              </Show>
            </Match>
          </Switch>
        </button>
        <Show when={main()}>
          {(pull) => (
            <span class="ss-side-work-main">
              <RefLine item={pull().ref} state={pull().state} titled={false} counts={false} />
            </span>
          )}
        </Show>
        <Show when={empty()}>
          <ctx.ui.Button
            variant="ghost-muted"
            size="small"
            class="ss-side-link"
            onClick={() => void actions.link()}
          >
            {ctx.t('side.work.link')}
          </ctx.ui.Button>
        </Show>
      </div>
      {/* No body while there is nothing to list, so its padding leaves no empty band. */}
      <Show when={!props.folded && (state()?.status ?? 'loading') !== 'loading' && !empty()}>
        <div class="ss-side-work-body">
          <WorkList refs={props.refs} target={props.target} actions />
        </div>
      </Show>
    </section>
  );
}
