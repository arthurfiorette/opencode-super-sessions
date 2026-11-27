import type { SessionInfo } from '@opencode/client';
import type { ServerRef } from '@opencode/plugin/gui';
import { createEffect, createMemo, untrack } from 'solid-js';
import { homePath, type ProjectLook } from '../../host/gui.js';
import { activityTime } from '../../host/session-info.js';
import type { SearchScope } from '../../rpc.js';
import { type LocalProject, sessionProjectLook } from '../project-avatar.js';
import type { MachinePick, Origin } from './machines.js';

// The browser's project rail: a tile for all projects, then each machine's projects under its
// name, with each project's running and unread sessions. With one machine there is no name,
// as in the app's sidebar. The tiles come from each machine's list of every project's active
// sessions, which its browser model holds while it shows all projects and otherwise asks for at
// most once per open, beside its own load.

/**
 * What one server's model lists: every project, the routed session's project (resolved from the
 * session as "this project" was, so a removed worktree still lists), or another project or
 * directory.
 */
export type RailSelection =
  | { readonly type: 'all' }
  | { readonly type: 'routed' }
  | Exclude<SearchScope, { type: 'all' }>;

/** One tile of the rail. */
export interface RailTile {
  /** `all`, or the server's id, a newline and the tile's key on it ({@link tileKey}). */
  readonly key: string;
  /** The tile's key on its server ({@link tileKey}), or `all`. */
  readonly tile: string;
  /** The tile's server; undefined for the All tile. */
  readonly server: string | undefined;
  readonly selection: MachinePick;
  /** The project's avatar; undefined for the All tile. */
  readonly look: ProjectLook | undefined;
  /**
   * The project's parent folder, when another project on the rail has the same name, so the
   * tooltips tell them apart.
   */
  readonly place: string | undefined;
  /** The tile's running sessions. */
  readonly running: number;
  /** Whether one of the tile's sessions is unread or waits on the user. */
  readonly unread: boolean;
}

/** A machine's header on the rail. */
export interface RailMachineInfo {
  readonly id: string;
  /** `ServerRef.name`, what the app's sidebar calls the machine. */
  readonly name: string;
  readonly connected: boolean;
}

/** The rail's tiles under one machine's header; no header for All and with one machine. */
export interface RailSection {
  readonly machine: RailMachineInfo | undefined;
  readonly tiles: readonly RailTile[];
}

/** The All tile's key. */
export const ALL_KEY = 'all';

/**
 * The tile a session belongs to on its server: its project, or its directory for a session
 * outside one, which the host stores under the `global` project.
 */
export function tileKey(session: Pick<SessionInfo, 'projectID' | 'location'>): string {
  return session.projectID === 'global'
    ? `directory:${session.location.directory}`
    : `project:${session.projectID}`;
}

/** A tile's key across machines. */
function machineKey(server: string, tile: string): string {
  return `${server}\n${tile}`;
}

/** The rail's key of a pick, given the routed session's tile. */
export function selectionKey(
  selection: MachinePick,
  routed: string | undefined
): string | undefined {
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
function parentFolder(root: string): string {
  const trimmed = root.replace(/[/\\]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  // A root at the top of its drive, such as `/work`, keeps its separator.
  const parent = cut <= 0 ? trimmed.slice(0, cut + 1) || trimmed : trimmed.slice(0, cut);
  return homePath(/^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent);
}

/** One machine as the rail reads it: its server and its browser model's lists. */
export interface RailMachine {
  readonly server: ServerRef;
  /** Every project's active sessions once known (`everyActive` of the browser model). */
  readonly every: () => readonly SessionInfo[] | undefined;
  /** Asks for {@link every} unless a fresh list is in (`wantEveryActive`). */
  readonly want: () => void;
  /** The machine's listed active sessions once loaded. */
  readonly active: () => readonly SessionInfo[] | undefined;
}

/** What {@link createRail} reads. */
export interface RailInput {
  /** Every machine the app lists, connected or not, the app's own first. */
  readonly machines: () => readonly RailMachine[];
  /** The routed session; undefined on Home. The side tab's follows the route. */
  readonly origin: () => Origin | undefined;
  /** The routed session's project with the user's local name and icon, when the app has it. */
  readonly local: () => LocalProject | undefined;
  /** Whether the browser lists every machine's projects now, whose lists are then `every`. */
  readonly all: () => boolean;
  readonly running: (server: ServerRef, session: SessionInfo) => boolean;
  /** Whether the session is unread or waits on the user. */
  readonly unread: (server: ServerRef, session: SessionInfo) => boolean;
}

/** A project's sessions as one tile counts them. */
interface TileGroup {
  sample: SessionInfo | undefined;
  latest: number;
  running: number;
  unread: boolean;
}

/**
 * The rail's tiles: All first, then each connected machine's projects with an active session,
 * and the routed session's project, newest activity first. Call it under the view's owner.
 */
export function createRail(input: RailInput) {
  // Every project's active sessions from each machine's model, which keeps them across opens and
  // rail picks, so a pick never reloads the tiles. While All shows, each machine's own list is
  // that list; otherwise it is asked for once per view and machine, unless the model's is fresh.
  const asked = new Set<string>();
  createEffect(() => {
    if (input.all()) return;
    for (const machine of input.machines()) {
      if (!machine.server.connected || asked.has(machine.server.id)) continue;
      asked.add(machine.server.id);
      untrack(machine.want);
    }
  });

  /** The routed session's tile, once its project is known. */
  const routedKey = createMemo(() => {
    const origin = input.origin();
    if (origin === undefined) return undefined;
    const machine = input.machines().find((item) => item.server.id === origin.server);
    if (machine === undefined) return undefined;
    const id = origin.id;
    const info =
      machine.server.data.session.get(id) ??
      machine.every()?.find((session) => session.id === id) ??
      machine.active()?.find((session) => session.id === id);
    if (info !== undefined) return machineKey(origin.server, tileKey(info));
    const local = input.local();
    return local === undefined ? undefined : machineKey(origin.server, `project:${local.id}`);
  });

  const sections = createMemo((): RailSection[] => {
    const routed = routedKey();
    const local = input.local();
    const origin = input.origin();
    let running = 0;
    let unread = false;
    const machines = input.machines().map((machine) => {
      const server = machine.server;
      const groups = new Map<string, TileGroup>();
      // A machine that is not connected lists nothing, so its tiles would pick an empty list.
      for (const session of server.connected ? (machine.every() ?? []) : []) {
        const key = tileKey(session);
        const group = groups.get(key) ?? { sample: session, latest: 0, running: 0, unread: false };
        group.latest = Math.max(group.latest, activityTime(session));
        if (input.running(server, session)) {
          group.running += 1;
          running += 1;
        }
        if (input.unread(server, session)) {
          group.unread = true;
          unread = true;
        }
        groups.set(key, group);
      }
      const routedTile =
        routed !== undefined && origin?.server === server.id
          ? routed.slice(server.id.length + 1)
          : undefined;
      if (routedTile !== undefined && !groups.has(routedTile)) {
        groups.set(routedTile, { sample: undefined, latest: 0, running: 0, unread: false });
      }
      const tiles = [...groups.entries()]
        .sort(([, a], [, b]) => b.latest - a.latest)
        .map(([tile, group]) => {
          const directory = tile.startsWith('directory:')
            ? tile.slice('directory:'.length)
            : undefined;
          const project = tile.startsWith('project:') ? tile.slice('project:'.length) : 'global';
          const selection: MachinePick =
            tile === routedTile
              ? { type: 'routed' }
              : directory !== undefined
                ? { type: 'directory', directory, server: server.id }
                : { type: 'project', project, subpath: '', server: server.id };
          return {
            key: machineKey(server.id, tile),
            tile,
            server: server.id,
            selection,
            look: sessionProjectLook(
              server,
              project,
              directory ?? group.sample?.location.directory ?? origin?.directory ?? '',
              origin?.server === server.id ? local : undefined
            ),
            place: undefined as string | undefined,
            running: group.running,
            unread: group.unread
          };
        });
      return { server, tiles };
    });
    // Two projects of one name, on one machine or two, read apart by their folders.
    const names = new Map<string, number>();
    for (const { tiles } of machines) {
      for (const tile of tiles) names.set(tile.look.name, (names.get(tile.look.name) ?? 0) + 1);
    }
    for (const { tiles } of machines) {
      for (const tile of tiles) {
        if ((names.get(tile.look.name) ?? 0) > 1) tile.place = parentFolder(tile.look.root);
      }
    }
    const all: RailTile = {
      key: ALL_KEY,
      tile: ALL_KEY,
      server: undefined,
      selection: { type: 'all' },
      look: undefined,
      place: undefined,
      running,
      unread
    };
    // One machine reads as today's rail: no header, since every project is on it.
    if (machines.length <= 1) {
      return [{ machine: undefined, tiles: [all, ...(machines[0]?.tiles ?? [])] }];
    }
    return [
      { machine: undefined, tiles: [all] },
      ...machines.map(({ server, tiles }) => ({
        machine: { id: server.id, name: server.name, connected: server.connected },
        tiles
      }))
    ];
  });
  /** Every tile in rail order, across the machines, for the keys that move along it. */
  const tiles = createMemo(() => sections().flatMap((section) => section.tiles));

  return { sections, tiles, routedKey };
}

export type Rail = ReturnType<typeof createRail>;
