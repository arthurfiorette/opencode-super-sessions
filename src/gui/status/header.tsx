import { usePlugin } from '@opencode/plugin/gui';
import { createMemo, For, Show } from 'solid-js';
import { type Ref, refKey } from '../../refs/ref.js';
import { rowRefs } from '../../refs/summary.js';
import { RefLine } from '../ref-view.js';
import type { RefsStore, SessionTarget } from '../refs-store.js';

// The session's pull requests and issues in its title row, as a session row in the TUI browser
// draws them.

/** Props of {@link HeaderStatus}. */
export interface HeaderStatusProps {
  readonly refs: RefsStore;
  /** The header's session, or undefined while its timeline is hidden. */
  readonly target: SessionTarget | undefined;
  /** The title needs the room: only the first ref's glyph and number, and `+N` for the rest. */
  readonly compact: boolean;
  /** The session's Work tab is on screen. */
  readonly workShown: boolean;
  /** Shows the session's Work tab, or closes it while it shows. */
  readonly toggleWork: () => void;
}

/**
 * Up to three tracked pull requests with their stack place, review and CI badges, then the
 * tracked issues, then `+N` for the others and the mentions (`rowRefs`), which toggles the Work
 * panel that lists them all. Each ref opens its page.
 * Nothing while the refs load, when the session tracks nothing, or when its server runs no server
 * half of this plugin.
 */
export function HeaderStatus(props: HeaderStatusProps) {
  const ctx = usePlugin();
  const state = props.refs.use(() => props.target);
  const row = createMemo(() => {
    const current = state();
    return current?.status === 'ready' && current.view !== undefined
      ? rowRefs(current.view)
      : undefined;
  });
  const stateOf = (ref: Ref) => state()?.view?.states[refKey(ref)];
  /** The ref the compact form keeps: the first pull request, else the first issue. */
  const first = () => {
    const current = row();
    return current?.prs[0] ?? current?.issues[0];
  };
  /** What `+N` counts: everything the current form leaves out. */
  const more = () => {
    const current = row();
    if (current === undefined) return 0;
    const drawn = props.compact ? 1 : current.prs.length + current.issues.length;
    return current.prs.length + current.issues.length + current.extra - drawn;
  };
  /** What `+N` does, as its tooltip and accessible name say. */
  const label = () =>
    ctx.t(props.workShown ? 'header.hideWork' : 'header.showWork', { count: more() });
  return (
    <Show when={first()}>
      {(ref) => (
        <span class="ss-header" classList={{ 'ss-header-compact': props.compact }}>
          <Show
            when={!props.compact}
            fallback={
              <RefLine
                item={ref()}
                state={stateOf(ref())}
                titled={false}
                badged={false}
                stacked={false}
              />
            }
          >
            <For each={row()?.prs}>
              {(pr) => <RefLine item={pr} state={stateOf(pr)} titled={false} counts={false} />}
            </For>
            <For each={row()?.issues}>
              {(issue) => (
                <RefLine item={issue} state={stateOf(issue)} titled={false} badged={false} />
              )}
            </For>
          </Show>
          <Show when={more() > 0}>
            <ctx.ui.Tooltip value={label()}>
              <button
                type="button"
                class="ss-header-more"
                aria-label={label()}
                aria-pressed={props.workShown}
                onClick={(event) => {
                  // The title row under it renames on click.
                  event.stopPropagation();
                  props.toggleWork();
                }}
              >{`+${more()}`}</button>
            </ctx.ui.Tooltip>
          </Show>
        </span>
      )}
    </Show>
  );
}
