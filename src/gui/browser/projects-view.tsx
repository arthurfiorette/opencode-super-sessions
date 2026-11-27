import type { SessionInfo } from '@opencode/client';
import { usePlugin } from '@opencode/plugin/gui';
import { For, Show } from 'solid-js';
import { activitySpinner, MACHINE_ICON } from '../../host/gui.js';
import { activityTime } from '../../host/session-info.js';
import { ProjectAvatar } from '../project-avatar.js';
import type { ProjectEntry, ProjectMachine, SessionStatus } from './projects.js';
import { useAge } from './row.js';

// The browser's Projects view: every machine's projects under the machine's name, as the Desktop
// sidebar groups them by server, each with its running and waiting sessions under it as the
// session rows list their pull requests, and the selected project's preview.

/** Whether a project matches the search: its name or its path holds the query. */
export function projectMatches(project: ProjectEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return (
    project.look.name.toLowerCase().includes(needle) ||
    project.look.root.toLowerCase().includes(needle)
  );
}

/** Props of {@link ProjectList}. */
export interface ProjectListProps {
  readonly machines: readonly ProjectMachine[];
  /** Whether the app lists more than one machine, which heads each machine's projects. */
  readonly headed: boolean;
  readonly selected: string | undefined;
  readonly now: number;
  readonly onSelect: (project: ProjectEntry) => void;
  /** Scopes the browser to the project. */
  readonly onOpen: (project: ProjectEntry) => void;
  readonly onSession: (project: ProjectEntry, session: SessionInfo) => void;
  readonly ref: (key: string) => (element: HTMLElement) => void;
}

/** The projects, under each machine's name when the app lists more than one. */
export function ProjectList(props: ProjectListProps) {
  const ctx = usePlugin();
  return (
    <For each={props.machines}>
      {(machine) => (
        <div class="ss-group" data-machine-projects={machine.server.id}>
          <Show when={props.headed}>
            <h3 class="ss-group-title ss-machine-title" data-machine={machine.server.id}>
              <ctx.ui.Icon name={MACHINE_ICON} size="small" />
              <span>{machine.server.name}</span>
            </h3>
          </Show>
          <Show when={!machine.server.connected}>
            <p class="ss-note">
              {ctx.t('browser.machine.offline', { machine: machine.server.name })}
            </p>
          </Show>
          <For each={machine.projects}>
            {(project) => (
              <ProjectRow
                project={project}
                selected={props.selected === project.key}
                now={props.now}
                onSelect={() => props.onSelect(project)}
                onOpen={() => props.onOpen(project)}
                onSession={(session) => props.onSession(project, session)}
                ref={props.ref(project.key)}
              />
            )}
          </For>
        </div>
      )}
    </For>
  );
}

/** Props of {@link ProjectRow}. */
interface ProjectRowProps {
  readonly project: ProjectEntry;
  readonly selected: boolean;
  readonly now: number;
  readonly onSelect: () => void;
  readonly onOpen: () => void;
  readonly onSession: (session: SessionInfo) => void;
  readonly ref: (element: HTMLElement) => void;
}

/** Whether a pointer event started on a control of its own, which the row leaves alone. */
function onControl(event: MouseEvent): boolean {
  return event.target instanceof Element && event.target.closest('a, button') !== null;
}

/**
 * A project: its avatar, name and folder, its active and running sessions at the end, and its
 * running and waiting sessions under it. A click scopes the browser to it; a click on a session
 * opens that session.
 */
function ProjectRow(props: ProjectRowProps) {
  const ctx = usePlugin();
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the list's keys are the browser's, on its root.
    <div
      ref={props.ref}
      class="ss-row ss-project-row"
      classList={{ 'ss-row-selected': props.selected }}
      role="option"
      tabIndex={-1}
      aria-selected={props.selected}
      data-project={props.project.key}
      onPointerMove={(event) => {
        if (event.movementX !== 0 || event.movementY !== 0) props.onSelect();
      }}
      onClick={(event) => {
        if (!onControl(event)) props.onOpen();
      }}
    >
      <div class="ss-row-head">
        <span class="ss-row-project">
          <ProjectAvatar look={props.project.look} />
        </span>
        <span class="ss-row-text">
          <span class="ss-row-title">{props.project.look.name}</span>
          <span class="ss-row-description">{props.project.place}</span>
        </span>
        <span class="ss-row-meta" data-count="active">
          {ctx.plural('browser.projects.active', props.project.active)}
        </span>
        <Show when={props.project.running > 0}>
          <span class="ss-row-meta ss-project-running" data-count="running">
            <span {...activitySpinner(12)} />
            {props.project.running}
          </span>
        </Show>
      </div>
      <Show when={props.project.busy.length > 0}>
        <div class="ss-row-lines">
          <For each={props.project.busy}>
            {(item) => (
              <button
                type="button"
                class="ss-row-line ss-project-session"
                data-session-line={item.session.id}
                onClick={() => props.onSession(item.session)}
              >
                <StatusMark status={item.status} />
                <span class="ss-project-session-title">
                  {item.session.title || ctx.t('browser.untitled')}
                </span>
                <SessionAge session={item.session} now={props.now} />
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/** A session's age as the app's session search writes it. */
function SessionAge(props: { session: SessionInfo; now: number }) {
  const age = useAge();
  return <span class="ss-row-meta">{age(activityTime(props.session), props.now)}</span>;
}

/** The spinner of a running session, or the dot of one that waits or is unread. */
function StatusMark(props: { status: SessionStatus }) {
  const ctx = usePlugin();
  return (
    <span class="ss-row-status">
      <Show
        when={props.status === 'running'}
        fallback={
          <Show when={props.status !== undefined}>
            <span
              class="ss-row-dot"
              role="img"
              aria-label={ctx.t(props.status === 'waiting' ? 'browser.waiting' : 'browser.unread')}
            />
          </Show>
        }
      >
        <span class="ss-row-running" role="img" aria-label={ctx.t('browser.running')}>
          <span {...activitySpinner(12)} />
        </span>
      </Show>
    </span>
  );
}

/** Props of {@link ProjectPreview}. */
export interface ProjectPreviewProps {
  readonly project: ProjectEntry;
  /** Whether the app lists more than one machine, which names the project's. */
  readonly headed: boolean;
  readonly now: number;
  readonly onSession: (session: SessionInfo) => void;
}

/** The selected project: its path, machine and counts, and its most recent sessions. */
export function ProjectPreview(props: ProjectPreviewProps) {
  const ctx = usePlugin();
  return (
    <div class="ss-preview-body">
      <div class="ss-preview-head">
        <h3 class="ss-preview-title">{props.project.look.name}</h3>
      </div>
      <section class="ss-section">
        <div class="ss-context">
          <span class="ss-context-item">{props.project.look.root}</span>
          <Show when={props.headed}>
            <span class="ss-context-item">{props.project.server.name}</span>
          </Show>
          <span class="ss-context-item">
            {ctx.plural('browser.projects.active', props.project.active)}
          </span>
          <Show when={props.project.running > 0}>
            <span class="ss-context-item">
              {ctx.t('browser.projects.running', { count: props.project.running })}
            </span>
          </Show>
        </div>
      </section>
      <section class="ss-section">
        <h4 class="ss-section-title">{ctx.t('browser.projects.recent')}</h4>
        <Show
          when={props.project.recent.length > 0}
          fallback={<p class="ss-note">{ctx.t('browser.empty.active')}</p>}
        >
          <ul class="ss-work-list">
            <For each={props.project.recent}>
              {(session) => (
                <li>
                  <button
                    type="button"
                    class="ss-row-line ss-project-session"
                    onClick={() => props.onSession(session)}
                  >
                    <span class="ss-project-session-title">
                      {session.title || ctx.t('browser.untitled')}
                    </span>
                    <SessionAge session={session} now={props.now} />
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
    </div>
  );
}
