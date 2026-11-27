import { type MountedSession, usePlugin } from '@opencode/plugin/gui';
import {
  createEffect,
  createMemo,
  createSelector,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  Show,
  untrack
} from 'solid-js';
import {
  inWorktree,
  MACHINE_ICON,
  machineTag,
  openSessionKeepingTab,
  shelfAge
} from '../../host/gui.js';
import type { Machines } from '../browser/machines.js';
import { RowStatus } from '../browser/row.js';
import { ProjectAvatar } from '../project-avatar.js';
import { createProjectLooks, type ProjectLooks } from '../project-looks.js';
import { createWorking, sameList, type WorkingEntry } from './working.js';

// The bottom of the side tab: the sessions that need the user on every machine, in the app
// sidebar's "Working" shelf (WORKING_SHELF in src/host/gui.ts). It stays mounted across session
// switches, which move only the current mark, and a session event moves only the rows it changed.

/** Props of {@link WorkingSection}. */
export interface WorkingSectionProps {
  /** Every server's browser model, the dialog's own. */
  readonly machines: Machines;
  /** The routed session, whose row is marked current. */
  readonly session: MountedSession;
  /** The side tab's layout key, which a row's open keeps on screen in the opened session. */
  readonly panelKey: string;
  /** The tab is on screen; the section asks the servers for nothing before it first shows. */
  readonly shown: boolean;
  readonly collapsed: boolean;
  readonly setCollapsed: (collapsed: boolean) => void;
  /** Opens the session browser. */
  readonly browse: () => void;
}

/** Whether two times fall in the same minute, the finest unit an age shows. */
function sameMinute(a: number, b: number): boolean {
  return Math.floor(a / 60_000) === Math.floor(b / 60_000);
}

/**
 * The "Working" header, collapsible, with the count while collapsed and "All sessions…" at its
 * end, over the rows. The section takes its rows' height up to 40% of the tab and scrolls past
 * that; with nothing to list it is the header and one muted line.
 */
export function WorkingSection(props: WorkingSectionProps) {
  const ctx = usePlugin();
  const [now, setNow] = createSignal(Date.now(), { equals: sameMinute });
  const ticker = setInterval(() => setNow(Date.now()), 60_000);
  onCleanup(() => clearInterval(ticker));
  // Rows that waited hidden show their ages as of now.
  createEffect(() => {
    if (props.shown) untrack(() => setNow(Date.now()));
  });
  const entries = createWorking(props.machines, { shown: () => props.shown, now });
  // The rows are keyed by session, so a change of order moves them and a change of state updates
  // the one row.
  const keys = createMemo(() => entries().map((entry) => entry.key), [], { equals: sameList });
  const byKey = createMemo(() => new Map(entries().map((entry) => [entry.key, entry])));
  // A string memo, so a route change reaches only the rows that were and become current.
  const routedKey = createMemo(() => `${props.session.server.id}\n${props.session.id}`);
  const isCurrent = createSelector(routedKey);
  // The routed session's project carries the user's local name and icon for it.
  const looks = createProjectLooks(() => {
    const project = props.session.project;
    return project === undefined
      ? undefined
      : { server: props.session.server.id, id: project.id, name: project.name, icon: project.icon };
  });
  /**
   * Opens the session in its tab on its own server, focused, and keeps this tab on screen there
   * when it shows here (openSessionKeepingTab in src/host/gui.ts).
   */
  const open = (entry: WorkingEntry) => {
    const keep = ctx.layout.state(props.panelKey, props.session) === 'visible';
    openSessionKeepingTab(
      ctx,
      props.panelKey,
      { server: entry.server.id, id: entry.session.id },
      keep
    );
  };
  const headerId = `ss-working-${createUniqueId()}`;

  return (
    <section class="ss-working" aria-labelledby={headerId}>
      <span class="ss-working-rule" aria-hidden="true" />
      <div class="ss-working-header">
        <button
          id={headerId}
          type="button"
          class="ss-working-toggle"
          aria-expanded={!props.collapsed}
          onClick={() => props.setCollapsed(!props.collapsed)}
        >
          <span class="ss-working-label">{ctx.t('side.working')}</span>
          <Show when={props.collapsed && keys().length > 0}>
            <span class="ss-working-count">{keys().length}</span>
          </Show>
          <span class="ss-working-caret" data-collapsed={props.collapsed ? '' : undefined}>
            <ctx.ui.Icon name="fill-triangle-down" size="small" />
          </span>
        </button>
        <ctx.ui.Button
          variant="ghost-muted"
          size="small"
          class="ss-working-all"
          onClick={props.browse}
        >
          {ctx.t('side.working.all')}
        </ctx.ui.Button>
      </div>
      <Show when={!props.collapsed}>
        <Show
          when={keys().length > 0}
          fallback={<p class="ss-working-none">{ctx.t('side.working.none')}</p>}
        >
          <div class="ss-working-rows">
            <For each={keys()}>
              {(key) => {
                const entry = createMemo(() => byKey().get(key));
                return (
                  <Show when={entry()}>
                    {(item) => (
                      <WorkingRow
                        entry={item()}
                        current={isCurrent(key)}
                        looks={looks}
                        machine={machineTag(item().server, props.machines.servers().length)}
                        now={now()}
                        onOpen={() => open(item())}
                      />
                    )}
                  </Show>
                );
              }}
            </For>
          </div>
        </Show>
      </Show>
    </section>
  );
}

/** Props of {@link WorkingRow}. */
interface WorkingRowProps {
  readonly entry: WorkingEntry;
  /** The routed session's row. */
  readonly current: boolean;
  readonly looks: ProjectLooks;
  /** The machine's name for a session of another machine, else undefined. */
  readonly machine: string | undefined;
  readonly now: number;
  readonly onOpen: () => void;
}

/**
 * A session as the sidebar's Working shelf draws it: the project avatar and the title, then the
 * server icon for another machine, the project, the worktree and branch icons, the status marker
 * and the age. Two lines, and no pull request lines, so a click anywhere opens the session.
 */
function WorkingRow(props: WorkingRowProps) {
  const ctx = usePlugin();
  const session = () => props.entry.session;
  const look = createMemo(() =>
    props.looks.of(props.entry.server, session().projectID, session().location.directory)
  );
  const title = () => session().title || ctx.t('browser.untitled');
  const worktree = () => inWorktree(look().root, session().location.directory);
  // Read, never loaded: the app's sidebar syncs the branch of every row it shows.
  const branch = () =>
    props.entry.server.data.location.vcs.info({ directory: session().location.directory })?.branch
      .current;
  const age = () =>
    shelfAge(props.entry.at, props.now, {
      now: ctx.t('side.age.now'),
      minutes: (count) => ctx.t('side.age.minutes', { count }),
      hours: (count) => ctx.t('side.age.hours', { count }),
      days: (count) => ctx.t('side.age.days', { count })
    });
  return (
    <button
      type="button"
      class="ss-working-row"
      data-session={session().id}
      data-attention={props.entry.attention}
      data-state={props.current ? 'active' : undefined}
      aria-current={props.current ? 'page' : undefined}
      onClick={() => props.onOpen()}
    >
      <span class="ss-working-line">
        <span class="ss-working-avatar">
          <ProjectAvatar look={look()} />
        </span>
        <span class="ss-working-title" dir="auto">
          {title()}
        </span>
      </span>
      <span class="ss-working-line ss-working-detail">
        <Show when={props.machine}>
          {(name) => (
            <span class="ss-working-machine" role="img" aria-label={name()}>
              <ctx.ui.Tooltip value={name()} placement="right">
                <ctx.ui.Icon name={MACHINE_ICON} />
              </ctx.ui.Tooltip>
            </span>
          )}
        </Show>
        <span class="ss-working-place">
          <span class="ss-working-project" dir="auto">
            {look().name}
          </span>
          <Show when={worktree()}>
            <ctx.ui.Tooltip value={session().location.directory} placement="right">
              <ctx.ui.Icon name="outline-worktree" />
            </ctx.ui.Tooltip>
          </Show>
          <Show when={branch()}>
            {(name) => (
              <ctx.ui.Tooltip value={name()} placement="right">
                <ctx.ui.Icon name="branch" />
              </ctx.ui.Tooltip>
            )}
          </Show>
        </span>
        <span class="ss-working-end">
          <RowStatus
            running={props.entry.attention === 'running'}
            waiting={props.entry.waiting}
            unread={props.entry.attention === 'unread'}
          />
          <span class="ss-working-age">{age()}</span>
        </span>
      </span>
    </button>
  );
}
