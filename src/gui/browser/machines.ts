import type { Context, ServerRef } from '@opencode/plugin/gui';
import { createMemo, createRoot, createSignal, getOwner, onCleanup } from 'solid-js';
import type { SearchScope } from '../../rpc.js';
import { type BrowserModel, createBrowserModel, type ListTarget } from './model.js';
import type { ProjectSelection } from './projects.js';

// Every server the window lists, each a machine of the browser, with its browser model. The
// Desktop sidebar lists the sessions of every server it is connected to, grouped by machine
// (src/host/gui.ts: MACHINE_ICON), and so do the browser views: All lists every connected
// server's sessions, and the project picker groups each server's projects under its name.

/**
 * What the project picker picks across machines: every machine's sessions, the routed session's
 * project on its own server, or another project or directory on one server.
 */
export type MachinePick =
  | { readonly type: 'all' }
  | { readonly type: 'routed' }
  | (Exclude<SearchScope, { type: 'all' }> & { readonly server: string });

/** The routed session a view opened on, with its server's `ServerRef.id`. */
export interface Origin {
  readonly server: string;
  readonly id: string;
  readonly directory: string;
}

/** What a view lists: a pick over the routed session, if any. */
export interface MachinesTarget {
  readonly origin: Origin | undefined;
  readonly pick: MachinePick;
}

/**
 * Orders the listed servers: the app's own first, then other loopback connections, then the
 * rest as the app lists them, so the picker and All start with this machine's sessions.
 */
function machineOrder(servers: readonly ServerRef[]): ServerRef[] {
  const rank = (server: ServerRef) => (server.builtin ? 0 : server.local ? 1 : 2);
  return [...servers].sort((a, b) => rank(a) - rank(b));
}

/**
 * The window's machines. Call it once in setup, under the plugin's owner: each server's model
 * is made on first use and kept for the window's life, so a reopen draws its cached lists at
 * once. `pick` is the dialog's first project pick.
 */
export function createMachines(ctx: Pick<Context, 'servers'>, pick: MachinePick) {
  // Models are made from reactive reads, outside any owner the window keeps, so each gets a root
  // under setup's owner and ends with setup.
  const owner = getOwner();
  // By server id: each mounted session hands out a ref of its own for its server, which lives
  // with that session's screen, while the app's server list keeps one ref per server for the
  // window (packages/app/src/runtime/plugin/host-apis.tsx:547 at v2.4.2). The model takes the
  // window's, so it outlives the session it first opened over.
  const models = new Map<string, { model: BrowserModel; dispose: () => void }>();
  /** The server's browser model, created on first use. */
  const modelFor = (server: ServerRef): BrowserModel => {
    const known = models.get(server.id);
    if (known !== undefined) return known.model;
    const ref = ctx.servers.get(server.id) ?? server;
    const entry = createRoot((dispose) => ({ model: createBrowserModel(ref), dispose }), owner);
    models.set(server.id, entry);
    return entry.model;
  };
  onCleanup(() => {
    for (const entry of models.values()) entry.dispose();
    models.clear();
  });

  /** Every server the app lists and this window can reach, in {@link machineOrder}. */
  const servers = createMemo(
    () =>
      machineOrder(
        ctx.servers.list().flatMap((id) => {
          const server = ctx.servers.get(id);
          return server === undefined ? [] : [server];
        })
      ),
    undefined,
    {
      equals: (a, b) => a.length === b.length && a.every((server, index) => server === b[index])
    }
  );
  /**
   * The model of every listed server, connected or not. Read only by views, so no model and none
   * of its event listeners exist before the first open.
   */
  const all = () => servers().map(modelFor);

  // The dialog's project pick. The side tab always lists the routed project.
  const [picked, setPicked] = createSignal<MachinePick>(pick);
  // Counts the views that went away. A view that stays syncs and searches again, since the one
  // that left may have listed or searched for something else.
  const [released, setReleased] = createSignal(0);

  /** The model of a server by id, if the app lists it. */
  const byId = (id: string | undefined) =>
    id === undefined ? undefined : all().find((model) => model.server.id === id);

  /**
   * The models a pick lists: every connected machine for All, else the one machine of the picked
   * project. The routed project is on the routed session's server, `routedServer`; on Home it is
   * All.
   */
  const listed = (current: MachinePick, routedServer: string | undefined): BrowserModel[] => {
    if (current.type === 'routed' && routedServer !== undefined) {
      const routed = byId(routedServer);
      return routed === undefined ? [] : [routed];
    }
    if (current.type === 'project' || current.type === 'directory') {
      const owner = byId(current.server);
      return owner === undefined ? [] : [owner];
    }
    return all().filter((model) => model.server.connected);
  };

  /**
   * What one server's model lists for a target: the pick without its server, and the routed
   * session only on its own server, whose Location answers for it.
   */
  const targetFor = (model: BrowserModel, target: MachinesTarget): ListTarget => {
    const { pick: current, origin } = target;
    const selection: ProjectSelection =
      current.type === 'project'
        ? { type: 'project', project: current.project, subpath: current.subpath }
        : current.type === 'directory'
          ? { type: 'directory', directory: current.directory }
          : current;
    return {
      origin:
        origin !== undefined && origin.server === model.server.id
          ? { id: origin.id, directory: origin.directory }
          : undefined,
      selection
    };
  };

  return {
    /** Every listed server, the app's own first. */
    servers,
    /** Every listed server's model, in {@link servers} order. */
    models: all,
    /** The model of a server by its id. */
    model: byId,
    /** The model of a server by its id if a view made it already; never makes one. */
    made: (id: string): BrowserModel | undefined => models.get(id)?.model,
    listed,
    targetFor,
    /** The dialog's project pick. */
    pick: picked,
    /** Picks a project for the dialog. */
    select: (next: MachinePick) => setPicked(next),
    /** Moves each time a view goes away; see `createBrowserView` in ./view.ts. */
    released,
    /**
     * Counts a view on screen until the returned function runs; its end makes the other views
     * sync again (`released`).
     */
    attach(): () => void {
      let done = false;
      return () => {
        if (done) return;
        done = true;
        setReleased((count) => count + 1);
      };
    }
  };
}

export type Machines = ReturnType<typeof createMachines>;
