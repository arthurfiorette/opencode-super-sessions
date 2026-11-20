import path from 'node:path';
import type { LocationPublicInfo, OpenCodeClient, SessionInfo } from '@opencode/client';
import type { SearchScope } from '../rpc.js';
import { isBusy } from './session-info.js';

// Session API calls whose meaning the types do not carry: which route archives, what an empty
// title does, how a project scope filters. test/contract checks each against a real host. Line
// numbers refer to the OpenCode repository at v2.2.7. The helpers without a Node.js import live in
// `session-info.ts`, which the Desktop GUI bundle imports, and are re-exported here.

export {
  type ActivityInfo,
  activityStamp,
  activityTime,
  isBusy,
  isUnread,
  latestRunStart,
  listFilters,
  regenerateTitle,
  type SessionUpdater,
  sessionScope,
  setArchived
} from './session-info.js';

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
