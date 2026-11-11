import path from 'node:path';
import type { LocationPublicInfo, OpenCodeClient, SessionInfo } from '@opencode/client';
import { METADATA_KEY } from '../refs/ref.js';
import type { SearchScope } from '../rpc.js';

// Session API calls whose meaning the types do not carry: which route archives, what an empty
// title does, how a project scope filters. test/contract checks each against a real host. Line
// numbers refer to the OpenCode repository at v2.2.7.

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

/** What the server plugin's `prompt` hook carries that {@link sendsNow} reads. */
export interface PromptEvent {
  readonly sessionID: string;
  readonly delivery: string;
}

/**
 * Whether a notice admitted from the `prompt` hook reaches the model only together with this
 * prompt. The hook runs before the prompt is admitted (packages/core/src/session/prompt.ts:42,
 * session.ts:171), the prompt's admission wakes the session (session.ts:187), and that wake
 * delivers every pending steer at once (packages/core/src/session/inbox.ts:576). So the session
 * must be idle and the prompt a steer:
 * - while a turn runs, a pending steer keeps it going one more step
 *   (packages/core/src/session/runner/llm.ts:178), which could take the notice alone before the
 *   prompt is admitted;
 * - a queued prompt waits for its own turn, and a notice beside it would make a request of its own.
 * A notice left behind by a prompt that then fails to admit waits for the next wake.
 */
export function sendsNow(event: PromptEvent, info: SessionInfo): boolean {
  return event.delivery === 'steer' && !isBusy(info);
}

/** The part of the server plugin's session API {@link postNotice} needs. */
interface SyntheticPoster {
  synthetic(input: {
    sessionID: string;
    text: string;
    description?: string;
    metadata?: Record<string, string>;
    delivery?: 'steer' | 'queue';
    resume?: boolean;
  }): Promise<unknown>;
}

/**
 * Posts a notice the user sees as a `◈ description` row and the model reads as `text`, a user
 * message (packages/core/src/session/runner/to-llm-message.ts:255). It never wakes the session
 * (packages/core/src/session/session.ts:323): the host posts its own `!` command results the
 * same way (session.ts:226).
 */
export function postNotice(
  session: SyntheticPoster,
  sessionID: string,
  notice: { text: string; description: string }
): Promise<unknown> {
  return session.synthetic({
    sessionID,
    text: notice.text,
    description: notice.description,
    metadata: { source: 'super-sessions' },
    delivery: 'steer',
    resume: false
  });
}

/** User messages per `message.list` page when the fork dialog reads a session's prompts. */
const PROMPT_PAGE = 100;

/** A prompt the fork dialog offers to fork before. */
export interface Prompt {
  id: string;
  text: string;
  created: number;
}

/**
 * Every user message of a session, newest first, the list the host's /fork dialog offers
 * (packages/tui/src/routes/session/dialog-fork.tsx:57). The host reads its synced transcript,
 * which starts with the newest 20 messages (packages/client/src/solid/data.ts:1826), so this
 * pages `message.list` instead. The cursor
 * carries the order but not the `type` filter (packages/server/src/handlers/message.ts:24), so
 * every page asks for `type` again, and a cursor comes back even on the last page, so a short
 * page ends the read.
 */
export async function sessionPrompts(
  client: Pick<OpenCodeClient, 'message'>,
  sessionID: string
): Promise<Prompt[]> {
  const prompts: Prompt[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await client.message.list(
      cursor === undefined
        ? { sessionID, type: 'user', order: 'desc', limit: PROMPT_PAGE }
        : { sessionID, type: 'user', cursor, limit: PROMPT_PAGE }
    );
    for (const message of page.data) {
      if (message.type === 'user')
        prompts.push({ id: message.id, text: message.text, created: message.time.created });
    }
    cursor = page.cursor.next ?? undefined;
    if (page.data.length < PROMPT_PAGE || cursor === undefined) return prompts;
  }
}

/**
 * Forks a session into a new one. With `before`, the copy holds the messages older than that
 * message and leaves it and everything after out; without it, the copy runs through the newest
 * message (packages/core/src/session.ts:339). The host's /fork then carries the left-out prompt
 * into the new session's composer through a `prompt` field on its session route
 * (packages/tui/src/routes/session/dialog-fork.tsx:43); the plugin route type has no such field
 * (`Route` in @opencode/plugin/tui), so a fork from the browser opens with an empty composer.
 */
export function forkSession(
  client: Pick<OpenCodeClient, 'session'>,
  sessionID: string,
  before?: string
): Promise<SessionInfo> {
  return client.session.fork(before === undefined ? { sessionID } : { sessionID, before });
}

/**
 * "This project" for a Location, the way the built-in list scopes it
 * (packages/tui/src/component/dialog-session-list.tsx:63): the host's `global` project by
 * directory, any other project by id and the directory's path inside it. In 2.2.7 a directory
 * outside version control gets a project of its own (packages/core/src/project.ts:471), so the
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
 * "This project" for a session, read from what the host stored on it instead of its directory. It
 * gives what {@link projectScope} gives for the session's directory: the host stores the project
 * and the directory's path inside it on creation (packages/core/src/session.ts:308) and reads an
 * empty path back as no `subpath` (packages/core/src/session/info.ts:47). For a directory that is
 * gone, such as a removed worktree, where `location.get` fails with `LocationNotFoundError`
 * (packages/server/src/location.ts:27).
 */
export function sessionScope(info: SessionInfo): Exclude<SearchScope, { type: 'all' }> {
  if (info.projectID === 'global') return { type: 'directory', directory: info.location.directory };
  return { type: 'project', project: info.projectID, subpath: info.subpath ?? '' };
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
 * moves (packages/core/src/session/projector.ts:985), so the plugin's own bookkeeping (the history
 * scan marker, `pushed`, `closes` links, unlinks, Done marks) would read as activity.
 *
 * In 2.2.7, `time.busy` is set when an execution starts (projector.ts:1064) and `time.idle` when
 * it succeeds, fails or is interrupted by the user (projector.ts:857); both keep `time.updated` as it
 * was. Every prompt the TUI sends starts a run (packages/tui/src/component/prompt/index.tsx:1367),
 * and so do compaction (packages/core/src/session/session.ts:275) and a run resumed after a
 * restart. A fork's `time.created` is when it was forked (projector.ts:186). Not counted: a `!`
 * command, which records its messages without a run (session.ts:192) and moves only
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
