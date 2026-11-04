import { setTimeout as sleep } from 'node:timers/promises';
import type { BodyIndex } from './body-index.js';
import type { EventContext } from './events.js';

/** Indexes messages written before the plugin was installed, or while it was not running. */
export interface Backfill {
  /**
   * Starts the job unless it is running or already finished in this process. Call it whenever a
   * Location comes up: a job stopped because every Location detached resumes from the index.
   */
  start(): void;
}

export interface BackfillOptions {
  index(): Promise<BodyIndex>;
  /** A live Location context, or undefined when none is left and the job must stop. */
  context(): EventContext | undefined;
  warn(message: string, error?: unknown): void;
}

// Sessions per `session.list` page.
const PAGE_SIZE = 50;
// Rest between sessions and between batches of entries, so the backfill never competes with the
// daemon's own work for long: index writes run on its event loop.
const SESSION_PAUSE_MS = 200;
const BATCH_PAUSE_MS = 10;
const BATCH_SIZE = 25;

/**
 * Creates the backfill job. It walks every session, root and child, archived or not, most
 * recently updated first so recent work becomes searchable soonest, and indexes one session at a
 * time. Each finished session records its `time.updated` as the cursor; a restart skips sessions
 * that have not changed since, and anything newer than the cursor is covered by live indexing or
 * the next run.
 *
 * Messages come from `session.context`, the only message read a server plugin has. It returns
 * messages after the last compaction, so text before a session's latest compaction is only
 * searchable when live indexing saw it.
 */
export function createBackfill(options: BackfillOptions): Backfill {
  let running = false;
  let finished = false;

  /** Walks every session page. Resolves false when it stopped early because no Location is left. */
  const run = async (): Promise<boolean> => {
    const index = await options.index();
    if (!index.enabled) return true;
    let failed = false;
    let cursor: string | undefined;
    do {
      const context = options.context();
      if (context === undefined) return false;
      const page = await context.session.list({
        order: 'desc',
        limit: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor })
      });
      for (const info of page.data) {
        const current = options.context();
        if (current === undefined) return false;
        const state = index.backfillState(info.id);
        if (state?.done && Number(state.cursor) >= info.time.updated) continue;
        try {
          await indexSession(current, index, info.id);
          index.setBackfillState(info.id, { cursor: String(info.time.updated), done: true });
        } catch (error) {
          // A session deleted mid-walk fails here too; one warning per run is enough, and the
          // session is retried on the next start because it was not marked done.
          if (!failed) options.warn(`Indexing older messages of ${info.id} failed`, error);
          failed = true;
        }
        await sleep(SESSION_PAUSE_MS, undefined, { ref: false });
      }
      cursor = page.cursor.next ?? undefined;
    } while (cursor !== undefined);
    return true;
  };

  return {
    start() {
      if (running || finished) return;
      running = true;
      run()
        .then((completed) => {
          finished = completed;
        })
        .catch((error: unknown) => options.warn('Indexing older messages for search failed', error))
        .finally(() => {
          running = false;
        });
    }
  };
}

/**
 * Indexes the user and assistant text of one session with the keys live indexing uses: the user
 * message id (its inbox id) and `<assistant message id>:<text ordinal>`, where the ordinal counts
 * only text parts, as `session.text.ended` does.
 */
async function indexSession(
  context: EventContext,
  index: BodyIndex,
  sessionID: string
): Promise<void> {
  const messages = await context.session.context({ sessionID });
  let written = 0;
  for (const message of messages) {
    if (message.type === 'user') {
      index.add(sessionID, message.id, message.text, message.time.created);
      written++;
    }
    if (message.type === 'assistant') {
      let ordinal = 0;
      for (const part of message.content) {
        if (part.type !== 'text') continue;
        index.add(sessionID, `${message.id}:${ordinal}`, part.text, message.time.created);
        ordinal++;
        written++;
      }
    }
    if (written >= BATCH_SIZE) {
      written = 0;
      await sleep(BATCH_PAUSE_MS, undefined, { ref: false });
    }
  }
}
