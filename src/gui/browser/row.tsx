import type { SessionInfo } from '@opencode/client';
import { usePlugin } from '@opencode/plugin/gui';
import { createMemo, For, type JSX, Show } from 'solid-js';
import { activityTime, isUnread } from '../../host/session-info.js';
import { formatAge } from '../../page/age.js';
import type { PullRow } from '../../page/state.js';
import { type Ref, refKey } from '../../refs/ref.js';
import { rowRefs, type ShownLink, sidebarRefs, workLinks } from '../../refs/summary.js';
import type { SessionRefView } from '../../rpc.js';
import { Octicon } from '../octicons.js';
import { RefLine, WorkLinkLine } from '../ref-view.js';

// The browser's rows: a session with its pull request, issue and link lines, a pull request of
// the Pull requests view, and the preview's Work list.

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
    hidden: items.length - shown.length
  };
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
        <span class="ss-row-marker">
          <Show
            when={props.running}
            fallback={
              <Show when={isUnread(props.session)}>
                <span class="ss-tone-info" title={ctx.t('browser.unread')}>
                  <Octicon name="dot-fill" size={12} />
                </span>
              </Show>
            }
          >
            <span class="ss-running" title={ctx.t('browser.running')}>
              <ctx.ui.Loader size="small" />
            </span>
          </Show>
        </span>
        <span class="ss-row-title">{props.session.title || ctx.t('browser.untitled')}</span>
        <span class="ss-row-actions">{props.actions}</span>
        <span class="ss-row-age">{age()}</span>
      </div>
      <Show when={lines()}>
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
  readonly now: number;
  readonly onSelect: () => void;
  readonly onOpen: () => void;
  readonly ref: (element: HTMLElement) => void;
}

/**
 * A pull request of the Pull requests view: its line, and under it its newest session with the
 * number of sessions that worked on it. Double click opens that session.
 */
export function PullItem(props: PullItemProps) {
  const ctx = usePlugin();
  const newest = () => props.pull.sessions[0];
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
        <RefLine item={props.pull.ref} state={props.pull.state} />
        <span class="ss-row-age">{ctx.plural('browser.sessions', props.pull.sessions.length)}</span>
      </div>
      <Show when={newest()}>
        {(session) => (
          <div class="ss-row-lines">
            <div class="ss-row-line ss-row-session">
              <span class="ss-row-title">{session().title || ctx.t('browser.untitled')}</span>
              <span class="ss-row-age">{formatAge(props.now - activityTime(session()))}</span>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}

/** Props of {@link WorkList}. */
export interface WorkListProps {
  readonly view: SessionRefView | undefined;
}

/**
 * A session's pull requests, issues and work links, read-only, in the order the TUI's sidebar
 * lists them.
 */
export function WorkList(props: WorkListProps) {
  const ctx = usePlugin();
  const refs = createMemo(() => (props.view === undefined ? [] : sidebarRefs(props.view).refs));
  const links = createMemo(() => (props.view === undefined ? [] : workLinks(props.view)));
  return (
    <Show
      when={refs().length > 0 || links().length > 0}
      fallback={<p class="ss-note">{ctx.t('browser.preview.none')}</p>}
    >
      <ul class="ss-work-list">
        <For each={refs()}>
          {(ref) => (
            <li>
              <RefLine item={ref} state={props.view?.states[refKey(ref)]} />
            </li>
          )}
        </For>
        <For each={links()}>
          {(link) => (
            <li>
              <WorkLinkLine link={link} />
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
