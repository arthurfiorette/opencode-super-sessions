import { usePlugin } from '@opencode/plugin/gui';
import { createMemo, createSignal, For, type JSX, Match, Show, Switch } from 'solid-js';
import { checkMark, hasListedChecks, listedChecks, openBadges, refUrl } from '../../refs/look.js';
import { type Ref, refKey } from '../../refs/ref.js';
import { checksPage, openReview, type WorkLine, workLines } from '../../refs/work.js';
import { linkLabel } from '../../refs/work-link.js';
import type { SessionRefView } from '../../rpc.js';
import { useOpenUrl } from '../links.js';
import { Octicon } from '../octicons.js';
import {
  ExternalLink,
  octiconOf,
  RefBadges,
  RefLine,
  toneClass,
  WorkLinkLine
} from '../ref-view.js';
import type { RefsStore, SessionTarget } from '../refs-store.js';
import { refLabel, type WorkActions, type WorkItem, workActions } from './actions.js';
import { createPullDetails } from './details.js';

// A session's linked work as one list, like the TUI's Work rows: the Work side panel draws it with
// its actions, and the session browser's preview can draw it without them.

/** Failed checks listed under a pull request before the rest fold into `+N more`, as in the TUI. */
const FAILED_SHOWN = 5;

/** Props of {@link WorkList}. */
export interface WorkListProps {
  /** The plugin's refs store, which the list reads through and reloads after a change. */
  readonly refs: RefsStore;
  /** The session whose work to list; undefined lists nothing. */
  readonly target: SessionTarget | undefined;
  /**
   * Draws the actions: open, copy and unlink on each row, link and refresh above the list.
   * Defaults to false.
   */
  readonly actions?: boolean;
}

/**
 * A session's pull requests, each with its review and CI badges and the checks that failed or
 * wait for an action, the issues they close under them, then the other issues, the work links
 * and the mentioned refs (`workLines`). Says so when the session tracks nothing, while it loads,
 * when the first load failed, and when the session's server runs no server half of this plugin.
 */
export function WorkList(props: WorkListProps) {
  const ctx = usePlugin();
  const target = () => props.target;
  const state = props.refs.use(target);
  const view = () => state()?.view;
  const lines = createMemo(() => {
    const current = view();
    return current === undefined ? [] : workLines(current);
  });
  const stateOf = (ref: Ref) => view()?.states[refKey(ref)];
  /** Open pull requests with checks to list by name, whose details are worth loading. */
  const failing = () =>
    lines().flatMap((line) =>
      line.kind === 'status' && hasListedChecks(openReview(stateOf(line.ref)))
        ? [{ ref: line.ref, state: stateOf(line.ref) }]
        : []
    );
  const details = createPullDetails({ target, pulls: failing, queue: props.refs.queue });
  const actions = workActions(ctx, props.refs, target, useOpenUrl());
  const shown = () => (props.actions ?? false) && state() !== undefined;

  return (
    <div class="ss-work">
      <Show when={shown() && state()?.status !== 'unavailable'}>
        <Toolbar actions={actions} />
      </Show>
      <Switch>
        <Match when={state() === undefined}>
          <p class="ss-note">{ctx.t('refs.none')}</p>
        </Match>
        <Match when={state()?.status === 'unavailable'}>
          <p class="ss-note">{ctx.t('refs.unavailable')}</p>
        </Match>
        <Match when={state()?.status === 'loading'}>
          <ctx.ui.Loader />
        </Match>
        <Match when={state()?.status === 'error'}>
          <p class="ss-note">{ctx.t('refs.error')}</p>
        </Match>
        <Match when={lines().length === 0}>
          <p class="ss-note">{ctx.t('refs.empty')}</p>
        </Match>
        <Match when={true}>
          <ul class="ss-work-list">
            <For each={lines()}>
              {(line) => (
                <Line
                  line={line}
                  view={view()}
                  details={details}
                  actions={props.actions === true ? actions : undefined}
                />
              )}
            </For>
          </ul>
        </Match>
      </Switch>
    </div>
  );
}

/** Props of {@link Line}. */
interface LineProps {
  readonly line: WorkLine;
  readonly view: SessionRefView | undefined;
  readonly details: ReturnType<typeof createPullDetails>;
  readonly actions: WorkActions | undefined;
}

/**
 * One line of the list: a ref with its status line and failed checks, a work link, or a label,
 * each with its actions.
 */
function Line(props: LineProps): JSX.Element {
  const ctx = usePlugin();
  const line = props.line;
  if (line.kind === 'label') {
    return <li class="ss-work-label">{ctx.t('work.mentioned')}</li>;
  }
  if (line.kind === 'link') {
    const item: WorkItem = {
      key: line.link.key,
      url: line.link.url,
      label: linkLabel(line.link.url)
    };
    return (
      <li class="ss-work-item">
        <WorkLinkLine link={line.link} wrap />
        <Show when={props.actions}>
          {(actions) => <RowActions item={item} actions={actions()} />}
        </Show>
      </li>
    );
  }
  // A pull request's status and failed checks draw under its own line, in its block, below.
  if (line.kind === 'status') return null;
  const ref = line.ref;
  const state = () => props.view?.states[refKey(ref)];
  /** Whether the line has its second, status line: an open or draft one with any to show. */
  const status = () => {
    const current = state();
    if (current?.status !== 'open' && current?.status !== 'draft') return false;
    return current.stack !== undefined || openBadges(current, true).length > 0;
  };
  const failed = () =>
    hasListedChecks(openReview(state())) ? listedChecks(props.details(refKey(ref))?.checks) : [];
  const item = (): WorkItem => ({
    key: refKey(ref),
    url: refUrl(ref, state()),
    label: refLabel(ref)
  });
  // The glyph and number take the first column; the title, the status line and the failed checks
  // share the second, so each starts where the title does (status.css).
  return (
    <li class="ss-work-item ss-work-ref">
      <RefLine item={ref} state={state()} wrap badged={false} stacked={false} />
      <Show when={status()}>
        <div class="ss-work-status" data-work-status={refKey(ref)}>
          <RefBadges state={state()} stacked badged counts />
        </div>
      </Show>
      <Show when={failed().length > 0}>
        <ul class="ss-work-checks">
          <For each={failed().slice(0, FAILED_SHOWN)}>
            {(check) => {
              const mark = checkMark(check.status);
              return (
                <li>
                  <ExternalLink class="ss-check" url={check.url ?? checksPage(ref, state())}>
                    <Octicon name={octiconOf(mark.icon)} size={12} class={toneClass(mark.tone)} />
                    <span class="ss-check-name">{check.name}</span>
                  </ExternalLink>
                </li>
              );
            }}
          </For>
          <Show when={failed().length > FAILED_SHOWN}>
            <li>
              <ExternalLink class="ss-check ss-tone-muted" url={checksPage(ref, state())}>
                {ctx.t('work.more', { count: failed().length - FAILED_SHOWN })}
              </ExternalLink>
            </li>
          </Show>
        </ul>
      </Show>
      <Show when={props.actions}>
        {(actions) => <RowActions item={item()} actions={actions()} />}
      </Show>
    </li>
  );
}

/** Props of {@link RowActions}. */
interface RowActionsProps {
  readonly item: WorkItem;
  readonly actions: WorkActions;
}

/** A row's buttons, shown while the row is hovered or focused: open, copy the link, unlink. */
function RowActions(props: RowActionsProps) {
  const ctx = usePlugin();
  return (
    <span class="ss-work-actions">
      <ctx.ui.IconButton
        icon="square-arrow-top-right"
        label={ctx.t('work.open')}
        size="small"
        variant="ghost"
        onClick={() => props.actions.open(props.item)}
      />
      <ctx.ui.IconButton
        icon="copy"
        label={ctx.t('work.copy')}
        size="small"
        variant="ghost"
        onClick={() => void props.actions.copy(props.item)}
      />
      <ctx.ui.IconButton
        icon="xmark-small"
        label={ctx.t('work.unlink')}
        size="small"
        variant="ghost"
        onClick={() => void props.actions.unlink(props.item)}
      />
    </span>
  );
}

/** Props of {@link Toolbar}. */
interface ToolbarProps {
  readonly actions: WorkActions;
}

/** The list's own actions: link something to the session, and refresh it from the forges. */
function Toolbar(props: ToolbarProps) {
  const ctx = usePlugin();
  const [refreshing, setRefreshing] = createSignal(false);
  /** Refreshes once at a time; the button shows it is busy meanwhile. */
  const refresh = async () => {
    if (refreshing()) return;
    setRefreshing(true);
    try {
      await props.actions.refresh();
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <div class="ss-work-toolbar">
      <ctx.ui.Button
        icon="link"
        size="small"
        variant="ghost"
        onClick={() => void props.actions.link()}
      >
        {ctx.t('work.link')}
      </ctx.ui.Button>
      <ctx.ui.IconButton
        icon="refresh"
        label={ctx.t('work.refresh')}
        size="small"
        variant="ghost"
        busy={refreshing()}
        onClick={() => void refresh()}
      />
    </div>
  );
}
