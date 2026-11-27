import type { SessionInfo } from '@opencode/client';
import { METADATA_KEY } from '../refs/ref.js';
import type { SearchScope } from '../rpc.js';

// The session API helpers that need no Node.js module, so the Desktop GUI bundle can import them:
// a window turns `node:*` imports into inert placeholders. `session-api.ts` re-exports them for
// the server plugin and the TUI. test/contract checks each against a real host. Line numbers
// refer to the OpenCode repository at v2.4.0.

/** The part of an HTTP client (the TUI's `context.client`) that updates sessions. */
export interface SessionUpdater {
  session: {
    update(input: { sessionID: string; title?: string; archived?: boolean }): Promise<void>;
  };
}

/**
 * Archives or restores a session, optionally setting its title in the same update. Only the HTTP
 * route archives (packages/server/src/handlers/session.ts:258); the server plugin's
 * `context.session.update` ignores `archived`, so this takes the TUI's client.
 */
export function setArchived(
  client: SessionUpdater,
  sessionID: string,
  archived: boolean,
  title?: string
): Promise<void> {
  return client.session.update({ sessionID, archived, ...(title === undefined ? {} : { title }) });
}

/**
 * Asks the host's title agent for a new title: an empty title over HTTP regenerates it from the
 * conversation (packages/server/src/handlers/session.ts:243). A session with no messages keeps its
 * title.
 */
export function regenerateTitle(client: SessionUpdater, sessionID: string): Promise<void> {
  return client.session.update({ sessionID, title: '' });
}

/**
 * "This project" for a session, read from what the host stored on it instead of its directory. It
 * gives what `projectScope` gives for the session's directory: the host stores the project and
 * the directory's path inside it on creation (packages/core/src/session.ts:312) and reads an
 * empty path back as no `subpath` (packages/core/src/session/info.ts:47). For a directory that is
 * gone, such as a removed worktree, where `location.get` fails with `LocationNotFoundError`
 * (packages/server/src/location.ts:26).
 */
export function sessionScope(info: SessionInfo): Exclude<SearchScope, { type: 'all' }> {
  if (info.projectID === 'global') return { type: 'directory', directory: info.location.directory };
  return { type: 'project', project: info.projectID, subpath: info.subpath ?? '' };
}

/**
 * `session.list` filters for a scope in the browser's list. The host matches `subpath` exactly
 * (packages/core/src/session/store.ts:162), so an empty subpath lists the project root's sessions
 * only, like the built-in list.
 */
export function listFilters(
  scope: SearchScope
): { directory: string } | { project: string; subpath: string } | Record<string, never> {
  if (scope.type === 'project') return { project: scope.project, subpath: scope.subpath };
  if (scope.type === 'directory') return { directory: scope.directory };
  return {};
}

/**
 * A scope widened to its whole project: a project scope with an empty subpath. The Desktop
 * browser's project rail lists a project as the app sidebar's project group does, with the
 * sessions of all its worktrees and subfolders (`sandboxes` on the project, and
 * packages/app/src/shell/titlebar/sidebar-customized.tsx at v2.4.2). Other scopes stay as they
 * are.
 */
export function wholeProject(scope: SearchScope): SearchScope {
  return scope.type === 'project'
    ? { type: 'project', project: scope.project, subpath: '' }
    : scope;
}

/**
 * `session.list` filters for the Desktop browser's scope, where a project scope with an empty
 * subpath is the whole project (see {@link wholeProject}), as the `search` RPC reads it
 * (`listScope` in src/server/views.ts). The host filters on `subpath` only when one is given
 * (packages/core/src/session/store.ts:162 at v2.4.2), so a project alone lists every session
 * stored under the project's id, in any worktree or subfolder.
 */
export function projectListFilters(
  scope: SearchScope
):
  | { directory: string }
  | { project: string }
  | { project: string; subpath: string }
  | Record<string, never> {
  if (scope.type === 'project' && scope.subpath === '') return { project: scope.project };
  return listFilters(scope);
}

/**
 * Whether a session finished a run the user has not looked at since: the host's own unread rule
 * for tabs (packages/tui/src/context/session-tabs.tsx:125). `time.viewed` has no doc comment in
 * the schema, so this follows the host's reading of it.
 */
export function isUnread(info: SessionInfo): boolean {
  return (
    info.time.idle !== undefined &&
    (info.time.viewed === undefined || info.time.idle > info.time.viewed)
  );
}

/**
 * Whether a session runs now. `time.busy` is the start of the latest execution, and while it runs
 * `time.idle` still holds the end of the one before (packages/schema/src/session.ts:49).
 */
export function isBusy(info: SessionInfo): boolean {
  const busy = info.time.busy;
  return busy !== undefined && (info.time.idle === undefined || busy > info.time.idle);
}

/**
 * When the session's latest run started, or undefined when it never ran. Read while the session
 * is idle, that is the run the previous user message started, if one did.
 */
export function latestRunStart(info: Pick<SessionInfo, 'time'>): number | undefined {
  return info.time.busy;
}

/** Field of this plugin's metadata value that holds a stamped activity time; see {@link activityStamp}. */
const ACTIVE_AT = 'activeAt';

/** The session fields {@link activityTime} reads. */
export type ActivityInfo = Pick<SessionInfo, 'time' | 'metadata'>;

/**
 * When the user or the agent last worked in a session: its creation, or the start or end of its
 * latest run, whichever is newest. The list, its day groups and ages, search ties and the cleanup
 * inactivity rule use it instead of `time.updated`, which every `session.update({ metadata })`
 * moves (packages/core/src/session/projector.ts:988), so the plugin's own bookkeeping (the history
 * scan marker, `pushed`, `closes` links, unlinks, Done marks) would read as activity.
 *
 * `time.busy` is set when an execution starts (projector.ts:1067) and `time.idle` when it
 * succeeds, fails or is interrupted by the user (projector.ts:860); both keep `time.updated` as it
 * was. Every prompt the TUI sends starts a run (packages/tui/src/component/prompt/index.tsx:1371),
 * and so do compaction (packages/core/src/session/session.ts:276) and a run resumed after a
 * restart. A fork's `time.created` is when it was forked (projector.ts:186). Not counted: a `!`
 * command, which records its messages without a run (session.ts:193) and moves only
 * `time.updated`, and a prompt sent with `resume: false`, until the next run; renames, moves,
 * archiving, agent and model picks, permission changes and reverts, which are not work in the
 * session.
 *
 * `time.idle` exists since host migration 20260819222447 and `time.busy` since 20261029073502,
 * with no backfill, so sessions that last ran on an older host, V1 sessions migrated to V2
 * included, have neither. For those `time.updated` is the only activity record, so this reads it,
 * unless the write queue stamped the value it had before the plugin first wrote the session
 * ({@link activityStamp}).
 */
export function activityTime(info: ActivityInfo): number {
  const { busy, idle, created } = info.time;
  if (busy === undefined && idle === undefined) {
    return Math.max(created, stampedActivity(info) ?? info.time.updated);
  }
  return Math.max(created, busy ?? created, idle ?? created);
}

/**
 * What the write queue adds as `activeAt` to this plugin's metadata value before a write: the
 * session's activity time so far, for a session without run times whose value has no stamp yet.
 * Once the write moves `time.updated`, {@link activityTime} reads the stamp instead. Undefined
 * when no stamp is needed: the session has run times, or the value already holds one.
 */
export function activityStamp(info: ActivityInfo): number | undefined {
  if (info.time.busy !== undefined || info.time.idle !== undefined) return undefined;
  if (stampedActivity(info) !== undefined) return undefined;
  return info.time.updated;
}

/**
 * The `activeAt` stamp in this plugin's metadata value. Read without the full schema, since the
 * list sorts by it on every render.
 */
function stampedActivity(info: ActivityInfo): number | undefined {
  const value: unknown = info.metadata?.[METADATA_KEY];
  if (typeof value !== 'object' || value === null) return undefined;
  const at: unknown = (value as Record<string, unknown>)[ACTIVE_AT];
  return typeof at === 'number' ? at : undefined;
}
