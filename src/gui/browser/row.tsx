import type { SessionInfo } from '@opencode/client';
import { usePlugin } from '@opencode/plugin/gui';
import { createMemo, For, type JSX, Match, Show, Switch } from 'solid-js';
import { activitySpinner, type ProjectLook } from '../../host/gui.js';
import { activityTime, isUnread } from '../../host/session-info.js';
import { formatAge } from '../../page/age.js';
import type { PullRow } from '../../page/state.js';
import { type Ref, refKey } from '../../refs/ref.js';
import { rowRefs, type ShownLink, workLinks } from '../../refs/summary.js';
import type { SessionRefView } from '../../rpc.js';
import { ProjectAvatar } from '../project-avatar.js';
import { RefLine, WorkLinkLine } from '../ref-view.js';

// The browser's rows: a session with its pull request, issue and link lines, and a pull request
// of the Pull requests view. The preview's Work list is the side tab's (src/gui/status).

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

/** Props of {@link RowStatus}. */
interface RowStatusProps {
  readonly running: boolean;
  readonly waiting: 'permission' | 'question' | undefined;
  readonly unread: boolean;
}

/**
 * The status at a row's end, as the app's sidebar draws it beside a session
 * (packages/app/src/shell/titlebar/project-session-row.tsx:163 at v2.4.2): its dot while the
 * session waits on the user, which also hides the spinner, else the activity spinner while it
 * runs, else the dot while it is unread, else nothing. The tooltip says which. The TUI's pin
 * numbers have no source in the window: pins live in the TUI's own storage.
 */
function RowStatus(props: RowStatusProps) {
  const ctx = usePlugin();
  return (
    <span class="ss-row-status">
      <Switch>
        <Match when={props.waiting}>
          {(waiting) => (
            <span
              class="ss-row-dot"
              data-marker="waiting"
              role="img"
              aria-label={ctx.t(`browser.waiting.${waiting()}`)}
              title={ctx.t(`browser.waiting.${waiting()}`)}
            />
          )}
        </Match>
        <Match when={props.running}>
          <span
            class="ss-row-running"
            data-marker="running"
            role="img"
            aria-label={ctx.t('browser.running')}
            title={ctx.t('browser.running')}
          >
            <span {...activitySpinner(14)} />
          </span>
        </Match>
        <Match when={props.unread}>
          <span
            class="ss-row-dot"
            data-marker="unread"
            role="img"
            aria-label={ctx.t('browser.unread')}
            title={ctx.t('browser.unread')}
          />
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
  /**
   * The session's project, drawn before the title where no project names the list, as the
   * sidebar's flat lists do. Undefined in a one-project list.
   */
  readonly project?: ProjectLook | undefined;
  /**
   * The name of the machine the session runs on, muted at the row's end as the sidebar labels a
   * row of another server. Undefined for this machine's sessions and with one machine.
   */
  readonly machine?: string | undefined;
  /** The session the window routes, which the side tab's list marks. Defaults to false. */
  readonly current?: boolean;
  readonly onSelect: () => void;
  readonly onOpen: () => void;
  readonly ref: (element: HTMLElement) => void;
}

/** Whether a pointer event started on a control of its own, which the row leaves alone. */
function onControl(event: MouseEvent): boolean {
  return event.target instanceof Element && event.target.closest('a, button') !== null;
}

/**
 * One session: its project in a list of every project, its title, machine, age and status, and
 * under it the lines of {@link rowLines}. A click selects the row, a double click opens it; a click on a ref line opens
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
      classList={{
        'ss-row-selected': props.selected,
        'ss-row-avatared': !!props.project,
        'ss-row-current': props.current === true
      }}
      role="option"
      tabIndex={-1}
      aria-selected={props.selected}
      aria-current={props.current === true ? 'true' : undefined}
      data-session={props.session.id}
      onClick={(event) => {
        if (!onControl(event)) props.onSelect();
      }}
      onDblClick={(event) => {
        if (!onControl(event)) props.onOpen();
      }}
    >
      <div class="ss-row-head">
        <Show when={props.project}>
          {(look) => (
            <span class="ss-row-project" title={look().name}>
              <ProjectAvatar look={look()} />
            </span>
          )}
        </Show>
        <span class="ss-row-title">{props.session.title || ctx.t('browser.untitled')}</span>
        <Show when={props.current === true}>
          <span class="ss-visually-hidden">{ctx.t('side.current')}</span>
        </Show>
        <span class="ss-row-actions">{props.actions}</span>
        <Show when={props.machine}>
          {(machine) => (
            <span class="ss-row-machine" title={machine()}>
              {machine()}
            </span>
          )}
        </Show>
        <span class="ss-row-age">{age()}</span>
        <RowStatus
          running={props.running}
          waiting={props.waiting}
          unread={isUnread(props.session)}
        />
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
 * src/page/row.ts): its state, number, badges and title, and the number of
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
        <span class="ss-row-pull">
          <RefLine item={props.pull.ref} state={props.pull.state} />
        </span>
        <span class="ss-row-age">{ctx.plural('browser.sessions', props.pull.sessions.length)}</span>
      </div>
    </div>
  );
}
