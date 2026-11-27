import type { SessionInfo } from '@opencode/client';
import type { ServerRef } from '@opencode/plugin/gui';
import { createEffect, createMemo, untrack } from 'solid-js';
import type { ProjectLook } from '../../host/gui.js';
import { activityTime } from '../../host/session-info.js';
import type { SearchScope } from '../../rpc.js';
import { type LocalProject, sessionProjectLook } from '../project-avatar.js';

// The browser's project rail: a tile for every project, then one for all of them, with each
// project's running and unread sessions. The tiles come from one list of every project's active
// sessions, which the browser model holds while it shows all projects and otherwise asks for at
// most once per open, beside its own load.

/**
 * What the rail selects: every project, the routed session's project (resolved from the session
 * as "this project" was, so a removed worktree still lists), or another project or directory.
 */
export type RailSelection =
  | { readonly type: 'all' }
  | { readonly type: 'routed' }
  | Exclude<SearchScope, { type: 'all' }>;

/** One tile of the rail. */
export interface RailTile {
  /** `all`, `project:<id>` or `directory:<path>`. */
  readonly key: string;
  readonly selection: RailSelection;
  /** The project's avatar; undefined for the All tile. */
  readonly look: ProjectLook | undefined;
  /** The tile's running sessions. */
  readonly running: number;
  /** Whether one of the tile's sessions is unread or waits on the user. */
  readonly unread: boolean;
}

/** The All tile's key. */
export const ALL_KEY = 'all';

/**
 * The tile a session belongs to: its project, or its directory for a session outside one, which
 * the host stores under the `global` project.
 */
export function tileKey(session: Pick<SessionInfo, 'projectID' | 'location'>): string {
  return session.projectID === 'global'
    ? `directory:${session.location.directory}`
    : `project:${session.projectID}`;
}

/** The rail's key of a selection, given the routed session's tile. */
export function selectionKey(
  selection: RailSelection,
  routed: string | undefined
): string | undefined {
  if (selection.type === 'all') return ALL_KEY;
  if (selection.type === 'routed') return routed;
  return selection.type === 'project'
    ? `project:${selection.project}`
    : `directory:${selection.directory}`;
}

/** What {@link createRail} reads. */
export interface RailInput {
  readonly server: ServerRef;
  /** The routed session; undefined on Home. The side tab's follows the route. */
  readonly origin: () => { readonly id: string; readonly directory: string } | undefined;
  /** The routed session's project with the user's local name and icon, when the app has it. */
  readonly local: () => LocalProject | undefined;
  /** Every project's active sessions once known (`everyActive` of the browser model). */
  readonly every: () => readonly SessionInfo[] | undefined;
  /** Asks for {@link every} unless a fresh list is in (`wantEveryActive`). */
  readonly want: () => void;
  /** Whether the browser lists every project now, whose list is then {@link every} too. */
  readonly all: () => boolean;
  /** The browser's active sessions once loaded. */
  readonly active: () => readonly SessionInfo[] | undefined;
  readonly running: (session: SessionInfo) => boolean;
  /** Whether the session is unread or waits on the user. */
  readonly unread: (session: SessionInfo) => boolean;
}

/**
 * The rail's tiles: All first, then a tile for every project with an active session and for the
 * routed session's project, newest activity first. Call it under the view's owner.
 */
export function createRail(input: RailInput) {
  // Every project's active sessions from the model, which keeps them across opens and rail picks,
  // so a pick never reloads the tiles. While All shows, its own list is that list; otherwise it
  // is asked for once per view, unless the model's is fresh.
  let asked = false;
  createEffect(() => {
    if (asked || input.all()) return;
    asked = true;
    untrack(input.want);
  });
  const sessions = (): readonly SessionInfo[] => input.every() ?? [];

  /** The routed session's tile, once its project is known. */
  const routedKey = createMemo(() => {
    const origin = input.origin();
    if (origin === undefined) return undefined;
    const id = origin.id;
    const info =
      input.server.data.session.get(id) ??
      sessions().find((session) => session.id === id) ??
      input.active()?.find((session) => session.id === id);
    if (info !== undefined) return tileKey(info);
    const local = input.local();
    return local === undefined ? undefined : `project:${local.id}`;
  });

  const tiles = createMemo((): RailTile[] => {
    const groups = new Map<
      string,
      { sample: SessionInfo | undefined; latest: number; running: number; unread: boolean }
    >();
    let running = 0;
    let unread = false;
    for (const session of sessions()) {
      const key = tileKey(session);
      const group = groups.get(key) ?? { sample: session, latest: 0, running: 0, unread: false };
      group.latest = Math.max(group.latest, activityTime(session));
      if (input.running(session)) {
        group.running += 1;
        running += 1;
      }
      if (input.unread(session)) {
        group.unread = true;
        unread = true;
      }
      groups.set(key, group);
    }
    const routed = routedKey();
    if (routed !== undefined && !groups.has(routed)) {
      groups.set(routed, { sample: undefined, latest: 0, running: 0, unread: false });
    }
    const local = input.local();
    const projects = [...groups.entries()]
      .sort(([, a], [, b]) => b.latest - a.latest)
      .map(([key, group]): RailTile => {
        const directory = key.startsWith('directory:') ? key.slice('directory:'.length) : undefined;
        const project = key.startsWith('project:') ? key.slice('project:'.length) : 'global';
        const selection: RailSelection =
          key === routed
            ? { type: 'routed' }
            : directory !== undefined
              ? { type: 'directory', directory }
              : { type: 'project', project, subpath: '' };
        return {
          key,
          selection,
          look: sessionProjectLook(
            input.server,
            project,
            directory ?? group.sample?.location.directory ?? input.origin()?.directory ?? '',
            local
          ),
          running: group.running,
          unread: group.unread
        };
      });
    return [
      { key: ALL_KEY, selection: { type: 'all' }, look: undefined, running, unread },
      ...projects
    ];
  });

  return { tiles, routedKey };
}

export type Rail = ReturnType<typeof createRail>;
