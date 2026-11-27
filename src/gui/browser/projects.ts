import type { SessionInfo } from '@opencode/client';
import type { ServerRef } from '@opencode/plugin/gui';
import { createEffect, createMemo, untrack } from 'solid-js';
import { homePath, type ProjectLook } from '../../host/gui.js';
import { activityTime } from '../../host/session-info.js';
import type { SearchScope } from '../../rpc.js';
import type { ProjectLooks } from '../project-looks.js';
import type { MachinePick, Origin } from './machines.js';

// The projects of every machine the browser lists: what the project picker and the Projects view
// show. They come from each machine's loaded lists: every project's active sessions, which the
// browser model holds while it shows all projects and otherwise asks for at most once per open,
// and the archived sessions it listed.

/**
 * What one server's model lists: every project, the routed session's project (resolved from the
 * session as "this project" was, so a removed worktree still lists), or another project or
 * directory.
 */
export type ProjectSelection =
  | { readonly type: 'all' }
  | { readonly type: 'routed' }
  | Exclude<SearchScope, { type: 'all' }>;

/** A session the Projects view lists under its project, with what it is doing. */
export interface ProjectSession {
  readonly session: SessionInfo;
  readonly status: SessionStatus;
}

/** What a session shows at its end: waiting on the user, running, unread, or nothing. */
export type SessionStatus = 'waiting' | 'running' | 'unread' | undefined;

/** One project of one machine. */
export interface ProjectEntry {
  /** The server's id, a newline and the project's key on it ({@link projectKey}). */
  readonly key: string;
  /** The project's key on its server. */
  readonly project: string;
  readonly server: ServerRef;
  readonly selection: MachinePick;
  readonly look: ProjectLook;
  /** The folder the project's root sits in, with `~` for the home directory. */
  readonly place: string;
  /** Active sessions. */
  readonly active: number;
  readonly running: number;
  /** Whether a session is unread or waits on the user. */
  readonly unread: boolean;
  /** Its running and waiting sessions, waiting first, then newest. */
  readonly busy: readonly ProjectSession[];
  /** Its sessions, active and archived, newest first. */
  readonly recent: readonly SessionInfo[];
  readonly latest: number;
}

/** A machine and its projects, newest activity first. */
export interface ProjectMachine {
  readonly server: ServerRef;
  readonly projects: readonly ProjectEntry[];
}

/** The All pick's key. */
export const ALL_KEY = 'all';

/**
 * The project a session belongs to on its server: its project, or its directory for a session
 * outside one, which the host stores under the `global` project.
 */
export function projectKey(session: Pick<SessionInfo, 'projectID' | 'location'>): string {
  return session.projectID === 'global'
    ? `directory:${session.location.directory}`
    : `project:${session.projectID}`;
}

/** A project's key across machines. */
function machineKey(server: string, project: string): string {
  return `${server}\n${project}`;
}

/** The key of a pick, given the routed session's project. */
export function pickKey(selection: MachinePick, routed: string | undefined): string | undefined {
  if (selection.type === 'all') return ALL_KEY;
  if (selection.type === 'routed') return routed;
  return machineKey(
    selection.server,
    selection.type === 'project'
      ? `project:${selection.project}`
      : `directory:${selection.directory}`
  );
}

/** The folder a project's root sits in, as the app's tab preview writes paths. */
export function parentFolder(root: string): string {
  const trimmed = root.replace(/[/\\]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  // A root at the top of its drive, such as `/work`, keeps its separator.
  const parent = cut <= 0 ? trimmed.slice(0, cut + 1) || trimmed : trimmed.slice(0, cut);
  return homePath(/^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent);
}

/** One machine as the projects read it: its server and its browser model's lists. */
export interface ProjectSource {
  readonly server: ServerRef;
  /** Every project's active sessions once known (`everyActive` of the browser model). */
  readonly every: () => readonly SessionInfo[] | undefined;
  /** Asks for {@link every} unless a fresh list is in (`wantEveryActive`). */
  readonly want: () => void;
  /** The machine's listed active sessions once loaded. */
  readonly active: () => readonly SessionInfo[] | undefined;
  /** The machine's listed archived sessions once loaded. */
  readonly archived: () => readonly SessionInfo[] | undefined;
}

/** What {@link createProjects} reads. */
export interface ProjectsInput {
  /** Every machine the app lists, connected or not, the app's own first. */
  readonly machines: () => readonly ProjectSource[];
  /** The routed session; undefined on Home. */
  readonly origin: () => Origin | undefined;
  /** Whether the browser lists every machine's projects now, whose lists are then `every`. */
  readonly all: () => boolean;
  readonly status: (server: ServerRef, session: SessionInfo) => SessionStatus;
  readonly looks: ProjectLooks;
}

/** Sessions the Projects view lists under a project. */
const BUSY_LINES = 3;
/** Sessions the preview lists for a project. */
const RECENT_LINES = 8;

/** A project's sessions as one entry counts them. */
interface Tally {
  sample: SessionInfo | undefined;
  latest: number;
  active: number;
  running: number;
  unread: boolean;
  busy: ProjectSession[];
  recent: SessionInfo[];
}

/** An empty tally. */
function tally(sample: SessionInfo | undefined): Tally {
  return { sample, latest: 0, active: 0, running: 0, unread: false, busy: [], recent: [] };
}

/**
 * Every machine's projects with an active or archived session in the loaded lists, and the
 * routed session's project, newest activity first. Call it under the view's owner.
 */
export function createProjects(input: ProjectsInput) {
  // Every project's active sessions from each machine's model, which keeps them across opens and
  // picks, so a pick never reloads them. While All shows, each machine's own list is that list;
  // otherwise it is asked for once per view and machine, unless the model's is fresh.
  const asked = new Set<string>();
  createEffect(() => {
    if (input.all()) return;
    for (const machine of input.machines()) {
      if (!machine.server.connected || asked.has(machine.server.id)) continue;
      asked.add(machine.server.id);
      untrack(machine.want);
    }
  });

  /** The routed session's project, once its server knows the session. */
  const routedKey = createMemo(() => {
    const origin = input.origin();
    if (origin === undefined) return undefined;
    const machine = input.machines().find((item) => item.server.id === origin.server);
    if (machine === undefined) return undefined;
    const id = origin.id;
    const info =
      machine.server.data.session.get(id) ??
      machine.every()?.find((session) => session.id === id) ??
      machine.active()?.find((session) => session.id === id) ??
      machine.archived()?.find((session) => session.id === id);
    return info === undefined ? undefined : machineKey(origin.server, projectKey(info));
  });

  const machines = createMemo((): ProjectMachine[] => {
    const routed = routedKey();
    const origin = input.origin();
    return input.machines().map((machine) => {
      const server = machine.server;
      const tallies = new Map<string, Tally>();
      const seen = new Set<string>();
      const add = (session: SessionInfo, archived: boolean) => {
        if (seen.has(session.id)) return;
        seen.add(session.id);
        const key = projectKey(session);
        const entry = tallies.get(key) ?? tally(session);
        entry.latest = Math.max(entry.latest, activityTime(session));
        entry.recent.push(session);
        if (!archived) {
          entry.active += 1;
          const status = input.status(server, session);
          if (status === 'running') entry.running += 1;
          if (status === 'waiting' || status === 'unread') entry.unread = true;
          if (status === 'running' || status === 'waiting') entry.busy.push({ session, status });
        }
        tallies.set(key, entry);
      };
      // A machine that is not connected lists nothing, so its projects would pick an empty list.
      if (server.connected) {
        for (const session of machine.every() ?? []) add(session, false);
        for (const session of machine.active() ?? []) add(session, false);
        for (const session of machine.archived() ?? []) add(session, true);
      }
      const routedProject =
        routed !== undefined && origin?.server === server.id
          ? routed.slice(server.id.length + 1)
          : undefined;
      if (routedProject !== undefined && !tallies.has(routedProject)) {
        tallies.set(routedProject, tally(undefined));
      }
      const projects = [...tallies.entries()]
        .sort(([, a], [, b]) => b.latest - a.latest)
        .map(([project, entry]): ProjectEntry => {
          const directory = project.startsWith('directory:')
            ? project.slice('directory:'.length)
            : undefined;
          const id = project.startsWith('project:') ? project.slice('project:'.length) : 'global';
          const selection: MachinePick =
            project === routedProject
              ? { type: 'routed' }
              : directory !== undefined
                ? { type: 'directory', directory, server: server.id }
                : { type: 'project', project: id, subpath: '', server: server.id };
          const look = input.looks.of(
            server,
            id,
            directory ?? entry.sample?.location.directory ?? origin?.directory ?? ''
          );
          return {
            key: machineKey(server.id, project),
            project,
            server,
            selection,
            look,
            place: parentFolder(look.root),
            active: entry.active,
            running: entry.running,
            unread: entry.unread,
            busy: entry.busy
              .sort(
                (a, b) =>
                  Number(b.status === 'waiting') - Number(a.status === 'waiting') ||
                  activityTime(b.session) - activityTime(a.session)
              )
              .slice(0, BUSY_LINES),
            recent: entry.recent
              .sort((a, b) => activityTime(b) - activityTime(a))
              .slice(0, RECENT_LINES),
            latest: entry.latest
          };
        });
      return { server, projects };
    });
  });
  /** Every project in list order, across the machines. */
  const entries = createMemo(() => machines().flatMap((machine) => machine.projects));

  return { machines, entries, routedKey };
}

export type Projects = ReturnType<typeof createProjects>;
