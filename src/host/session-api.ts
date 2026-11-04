import path from 'node:path';
import type { LocationPublicInfo, SessionInfo } from '@opencode/client';
import type { SearchScope } from '../rpc.js';

// Session API calls whose meaning the types do not carry: which route archives, what an empty
// title does, how a project scope filters. test/contract checks each against a real host. Line
// numbers refer to the OpenCode repository at v2.2.5.

/** The part of an HTTP client (the TUI's `context.client`) that updates sessions. */
interface SessionUpdater {
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
 * "This project" for a Location, the way the built-in list scopes it
 * (packages/tui/src/component/dialog-session-list.tsx:63): the host's `global` project by
 * directory, any other project by id and the directory's path inside it. In 2.2.5 a directory
 * outside version control gets a project of its own (packages/core/src/project.ts:453), so the
 * `global` branch is for hosts that still use it.
 */
export function projectScope(info: LocationPublicInfo): Exclude<SearchScope, { type: 'all' }> {
  if (info.project.id === 'global') return { type: 'directory', directory: info.directory };
  return {
    type: 'project',
    project: info.project.id,
    subpath: path.relative(info.project.directory, info.directory).replaceAll('\\', '/')
  };
}

/**
 * `session.list` filters for a scope in the browser's list. The host matches `subpath` exactly
 * (packages/core/src/session/store.ts:154), so an empty subpath lists the project root's sessions
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
 * Whether a session runs now. `time.busy` is the start of the latest execution, and while it runs
 * `time.idle` still holds the end of the one before (packages/schema/src/session.ts:49).
 */
export function isBusy(info: SessionInfo): boolean {
  const busy = info.time.busy;
  return busy !== undefined && (info.time.idle === undefined || busy > info.time.idle);
}
