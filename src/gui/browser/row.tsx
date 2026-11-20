import type { SessionInfo } from '@opencode/client';
import { usePlugin } from '@opencode/plugin/gui';
import { createMemo, For, type JSX, Match, Show, Switch } from 'solid-js';
import { activityTime, isUnread } from '../../host/session-info.js';
import { formatAge } from '../../page/age.js';
import type { PullRow } from '../../page/state.js';
import { type Ref, refKey } from '../../refs/ref.js';
import { rowRefs, type ShownLink, workLinks } from '../../refs/summary.js';
import type { SessionRefView } from '../../rpc.js';
import { RefLine, WorkLinkLine } from '../ref-view.js';

// The browser's rows: a session with its pull request, issue and link lines, and a pull request
// of the Pull requests view. The preview's Work list is the Work panel's (src/gui/status).

/**
 * Issue and link lines a row lists before the rest fold into `+N more`, as the TUI's rows do
 * (`ISSUE_LINES` in src/page/row.ts, which loads OpenTUI and so stays out of the bundle).
 */
const ISSUE_LINES = 5;

/** A line under a session's title after its pull requests: an issue or a work link. */
type ItemLine = { kind: 'ref'; ref: Ref } | { kind: 'link'; link: ShownLink };

/**
 * What a row draws under its title, by the TUI's rule (`rowDetails` in src/page/row.ts): the
 * shown pull requests, then issues and work links one per line up to {@link ISSUE_LINES}. The
 * `+N` of refs the row leaves out ends the first pull request line, or the first issue line when
 * there is none.
 */
export function rowLines(view: SessionRefView) {
  const summary = rowRefs(view);
  const items: ItemLine[] = [
    ...summary.issues.map((ref): ItemLine => ({ kind: 'ref', ref })),
    ...workLinks(view).map((link): ItemLine => ({ kind: 'link', link }))
  ];
  const shown = items.slice(0, ISSUE_LINES);
  return {
    prs: summary.prs,
    items: shown,
    extra: summary.extra,
    hidden: items.length - shown.length,
    empty: summary.prs.length === 0 && shown.length === 0
  };
}

/** Props of {@link Marker}. */
interface MarkerProps {
  readonly running: boolean;
  readonly waiting: 'permission' | 'question' | undefined;
  readonly unread: boolean;
}

/**
 * The narrow mark before a title, by the TUI's rule (`markerOf` in src/page/view.ts): `!` for a
 * permission or `?` for a question the session waits on, a spinner while it runs, `●` when it is
 * unread, else a muted `-`, so each session's start shows at a glance. The TUI's pin numbers have
 * no source in the window: pins live in the TUI's own storage.
 */
function Marker(props: MarkerProps) {
  const ctx = usePlugin();
  return (
    <span class="ss-row-marker">
      <Switch fallback={<span class="ss-tone-muted">-</span>}>
        <Match when={props.waiting}>
          {(waiting) => (
            <span
              class="ss-marker-waiting"
              title={ctx.t(
                waiting() === 'permission'
                  ? 'browser.waiting.permission'
                  : 'browser.waiting.question'
              )}
            >
              {waiting() === 'permission' ? '!' : '?'}
            </span>
          )}
        </Match>
        <Match when={props.running}>
          <span class="ss-running" title={ctx.t('browser.running')} data-marker="running">
            <ctx.ui.Loader size="small" />
          </span>
        </Match>
        <Match when={props.unread}>
          <span class="ss-tone-info" title={ctx.t('browser.unread')} data-marker="unread">
            ●
          </span>
        </Match>
      </Switch>
    </span>
  );
}

/** The muted `+N` after a line. */
function Extra(props: { count: number }) {
  return (
    <Show when={props.count > 0}>
      <span class="ss-row-extra">{`+${props.count}`}</span>
    </Show>
  );
}

/** Props of {@link SessionRow}. */
export interface SessionRowProps {
  readonly session: SessionInfo;
  readonly view: SessionRefView | undefined;
  readonly selected: boolean;
  readonly running: boolean;
  /** What the session waits on the user for, if anything. */
  readonly waiting: 'permission' | 'question' | undefined;
  readonly now: number;
  /** Shows the archive age instead of the activity age, in the Archived view. */
  readonly archivedAge: boolean;
  /** The row's hover buttons. */
  readonly actions: JSX.Element;
  readonly onSelect: () => void;
  readonly onOpen: () => void;
  readonly ref: (element: HTMLElement) => void;
}

/** Whether a pointer event started on a control of its own, which the row leaves alone. */
function onControl(event: MouseEvent): boolean {
  return event.target instanceof Element && event.target.closest('a, button') !== null;
}

/**
 * One session: its running or unread marker, title and age, and under it the lines of
 * {@link rowLines}. A click selects the row, a double click opens it; a click on a ref line opens
 * the ref's page instead.
 */
export function SessionRow(props: SessionRowProps) {
  const ctx = usePlugin();
  const lines = createMemo(() => (props.view === undefined ? undefined : rowLines(props.view)));
  const age = () => {
    const archived = props.archivedAge ? props.session.time.archived : undefined;
    return formatAge(props.now - (archived ?? activityTime(props.session)));
  };
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the list's keys are the browser's, on its root.
    <div
      ref={props.ref}
      class="ss-row"
      classList={{ 'ss-row-selected': props.selected }}
      role="option"
      tabIndex={-1}
      aria-selected={props.selected}
      data-session={props.session.id}
      onClick={(event) => {
        if (!onControl(event)) props.onSelect();
      }}
      onDblClick={(event) => {
        if (!onControl(event)) props.onOpen();
      }}
    >
      <div class="ss-row-head">
        <Marker running={props.running} waiting={props.waiting} unread={isUnread(props.session)} />
        <span class="ss-row-title">{props.session.title || ctx.t('browser.untitled')}</span>
        <span class="ss-row-actions">{props.actions}</span>
        <span class="ss-row-age">{age()}</span>
      </div>
      {/* A row without refs or links is its title line alone, with no empty block under it. */}
      <Show when={lines()?.empty === false ? lines() : undefined}>
        {(shown) => (
          <div class="ss-row-lines">
            <For each={shown().prs}>
              {(ref, index) => (
                <div class="ss-row-line">
                  <RefLine item={ref} state={props.view?.states[refKey(ref)]} />
                  <Show when={index() === 0}>
                    <Extra count={shown().extra} />
                  </Show>
                </div>
              )}
            </For>
            <For each={shown().items}>
              {(item, index) => (
                <div class="ss-row-line">
                  {item.kind === 'ref' ? (
                    <RefLine item={item.ref} state={props.view?.states[refKey(item.ref)]} />
                  ) : (
                    <WorkLinkLine link={item.link} />
                  )}
                  <Show when={index() === 0 && shown().prs.length === 0}>
                    <Extra count={shown().extra} />
                  </Show>
                </div>
              )}
            </For>
            <Show when={shown().hidden > 0}>
              <div class="ss-row-line ss-row-extra">
                {ctx.t('browser.more', { count: shown().hidden })}
              </div>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}

/** Props of {@link PullItem}. */
export interface PullItemProps {
  readonly pull: PullRow;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onOpen: () => void;
  readonly ref: (element: HTMLElement) => void;
}

/**
 * A pull request of the Pull requests view in one line, as in the TUI (`pullLine` in
 * src/page/row.ts): the muted mark, its state, number, badges and title, and the number of
 * sessions that worked on it. The preview shows its newest session, which double click opens.
 */
export function PullItem(props: PullItemProps) {
  const ctx = usePlugin();
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the list's keys are the browser's, on its root.
    <div
      ref={props.ref}
      class="ss-row"
      classList={{ 'ss-row-selected': props.selected }}
      role="option"
      tabIndex={-1}
      aria-selected={props.selected}
      data-pull={props.pull.key}
      onClick={(event) => {
        if (!onControl(event)) props.onSelect();
      }}
      onDblClick={(event) => {
        if (!onControl(event)) props.onOpen();
      }}
    >
      <div class="ss-row-head">
        <span class="ss-row-marker ss-tone-muted">-</span>
        <span class="ss-row-pull">
          <RefLine item={props.pull.ref} state={props.pull.state} />
        </span>
        <span class="ss-row-age">{ctx.plural('browser.sessions', props.pull.sessions.length)}</span>
      </div>
    </div>
  );
}
