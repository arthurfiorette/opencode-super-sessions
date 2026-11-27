import type { OpenCodeEvent } from '@opencode/client';

// Permission requests waiting on the user, seen from the server plugin. `context.permission.list`
// answers only for the plugin's own Location: each Location keeps its pending requests in memory
// (`pending` in packages/core/src/permission.ts:159 at v2.4.2), and the HTTP route for another
// Location boots it, which loads its plugins, MCP servers and file watchers (0.4 s to 1.4 s). The
// events reach every Location's subscriber, so the server follows them instead, as it does forms
// (src/host/forms.ts). A request lives in its Location's memory, so none outlives the daemon.

/** The permission events: a request, then its reply (packages/schema/src/permission.ts:45). */
export const PERMISSION_EVENT_TYPES = ['permission.asked', 'permission.replied'] as const;

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
  /**
   * Forgets the session's requests when its run ends. A request belongs to a tool call of the
   * run, and an interrupted call drops it without a reply event (`Permission.assert` deletes it
   * in its finalizer, packages/core/src/permission.ts:311 at v2.4.2).
   */
  ended(sessionID: string): void;
  /** Whether a permission request waits on the session. */
  has(sessionID: string): boolean;
}

/** Creates an empty {@link PendingPermissions}. */
export function createPendingPermissions(): PendingPermissions {
  // Request id to session id. A reply names the request, so it closes exactly that one; a
  // Location that shuts down replies `reject` to each of its own.
  const open = new Map<string, string>();
  return {
    apply(event) {
      if (event.type === 'permission.asked') open.set(event.data.id, event.data.sessionID);
      else open.delete(event.data.requestID);
    },
    ended(sessionID) {
      for (const [id, owner] of open) if (owner === sessionID) open.delete(id);
    },
    has(sessionID) {
      for (const owner of open.values()) if (owner === sessionID) return true;
      return false;
    }
  };
}
