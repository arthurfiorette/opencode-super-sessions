import type { OpenCodeEvent } from '@opencode/client';

// Permission requests waiting on the user, seen from the server plugin. `context.permission.list`
// answers only for the plugin's own Location: each Location keeps its pending requests in memory
// (`pending` in packages/core/src/permission.ts:159 at v2.4.2), and the HTTP route for another
// Location boots it, which loads its plugins, MCP servers and file watchers (0.4 s to 1.4 s). The
// events reach every Location's subscriber, so the server follows them instead, as it does forms
// (src/host/forms.ts). A request lives in its Location's memory, so none outlives the daemon.

/** The permission events: a request, then its reply (packages/schema/src/permission.ts:45). */
export const PERMISSION_EVENT_TYPES = ['permission.asked', 'permission.replied'] as const;

/**
 * The start of a session's run, which the tracker needs to tell a run's requests from requests
 * made outside any run (packages/schema/src/session-event.ts:245 at v2.4.2). The events carry no
 * run id, so the tracker numbers the runs it sees start.
 */
export const RUN_START_TYPE = 'session.execution.started' as const;

export type PermissionEvent = Extract<
  OpenCodeEvent,
  { type: (typeof PERMISSION_EVENT_TYPES)[number] }
>;

const permissionTypes: ReadonlySet<string> = new Set(PERMISSION_EVENT_TYPES);

/** Whether an event is one of the {@link PERMISSION_EVENT_TYPES}. */
export function isPermissionEvent(event: { type: string }): event is PermissionEvent {
  return permissionTypes.has(event.type);
}

/** Open permission requests by session, kept up to date from the permission events. */
export interface PendingPermissions {
  apply(event: PermissionEvent): void;
  /** Records that a run of the session started, on {@link RUN_START_TYPE}. */
  started(sessionID: string): void;
  /**
   * Forgets the requests asked during the session's run when that run ends. A tool call's request
   * belongs to its run, and an interrupted call drops it without a reply event (`Permission.assert`
   * deletes it in its finalizer, packages/core/src/permission.ts:311 at v2.4.2). A request asked
   * outside a run, through the public `session.permission.create` route
   * (packages/server/src/handlers/permission.ts:45), waits for its reply.
   */
  ended(sessionID: string): void;
  /** Drops everything known about a deleted session. */
  forget(sessionID: string): void;
  /** Whether a permission request waits on the session. */
  has(sessionID: string): boolean;
}

/** Creates an empty {@link PendingPermissions}. */
export function createPendingPermissions(): PendingPermissions {
  // Request id to its session and the run it was asked in, undefined outside a run. A reply names
  // the request, so it closes exactly that one; a Location that shuts down replies `reject` to
  // each of its own.
  const open = new Map<string, { session: string; run: number | undefined }>();
  // The running run of each session, numbered in the order runs started.
  const runs = new Map<string, number>();
  let counter = 0;
  return {
    apply(event) {
      if (event.type === 'permission.asked') {
        const session = event.data.sessionID;
        open.set(event.data.id, { session, run: runs.get(session) });
      } else open.delete(event.data.requestID);
    },
    started(sessionID) {
      runs.set(sessionID, ++counter);
    },
    ended(sessionID) {
      const run = runs.get(sessionID);
      runs.delete(sessionID);
      if (run === undefined) return;
      for (const [id, entry] of open) {
        if (entry.session === sessionID && entry.run === run) open.delete(id);
      }
    },
    forget(sessionID) {
      runs.delete(sessionID);
      for (const [id, entry] of open) if (entry.session === sessionID) open.delete(id);
    },
    has(sessionID) {
      for (const entry of open.values()) if (entry.session === sessionID) return true;
      return false;
    }
  };
}
