import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

/** One session matching a body search, with the creation time of its newest matching entry. */
export interface BodySearchHit {
  sessionID: string;
  created: number;
}

/** Progress of the history backfill for one session. */
export interface BackfillState {
  /** Opaque resume point written by the backfill job. */
  cursor: string | null;
  done: boolean;
}

/** Full-text index over user and assistant message text, one row per message text entry. */
export interface BodyIndex {
  /** False when SQLite or FTS5 is missing or the file could not be opened; every call is then a no-op. */
  readonly enabled: boolean;
  /**
   * Stores `text` under `entryKey` for the session, replacing an earlier entry with the same key.
   * Empty and whitespace-only text is skipped, and text past {@link MAX_ENTRY_LENGTH} is cut.
   */
  add(sessionID: string, entryKey: string, text: string, created: number): void;
  /** Drops every entry and the backfill progress of a session. */
  removeSession(sessionID: string): void;
  /**
   * Sessions whose entries contain every query token, newest hit first, one row per session.
   * Returns nothing when the query has no token of three or more characters.
   */
  search(query: string, options: { limit: number }): BodySearchHit[];
  backfillState(sessionID: string): BackfillState | undefined;
  setBackfillState(sessionID: string, state: BackfillState): void;
  close(): void;
}

/** Longest text stored per entry, in UTF-16 code units (32 KB for ASCII). */
export const MAX_ENTRY_LENGTH = 32 * 1024;

// The newest index hits a search reads. A common word stops here instead of reading every entry,
// so search time stays flat as history grows. Entry ids follow creation time (see `allocateId`),
// so these are also the most recent hits.
const HIT_LIMIT = 5000;

// Ids are `created * IDS_PER_MS + n`, so FTS5 rowid order is creation order.
const IDS_PER_MS = 1000;

const SCHEMA_VERSION = 1;

/**
 * Where the index lives: the plugin's own directory under the XDG data home, next to OpenCode's
 * data but never inside its database. OpenCode gives server plugins no data directory of their own.
 */
export function bodyIndexPath(env: NodeJS.ProcessEnv = process.env): string {
  const data = env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share');
  return path.join(data, 'opencode', 'plugins', 'opencode-super-sessions', 'search.db');
}

/**
 * Opens (and migrates) the index at `file`. Never throws: without `node:sqlite` (Bun before 1.4),
 * FTS5 trigram support or a writable file it reports through `warn` and returns a disabled index,
 * so search falls back to titles and refs.
 */
export async function openBodyIndex(
  file: string,
  warn: (message: string, error?: unknown) => void
): Promise<BodyIndex> {
  let db: DatabaseSync | undefined;
  try {
    const sqlite = await import('node:sqlite');
    mkdirSync(path.dirname(file), { recursive: true });
    db = new sqlite.DatabaseSync(file);
    return createIndex(db);
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Already failing; the first error is the one worth reporting.
    }
    warn('Message search is off because its index could not be opened', error);
    return disabledIndex;
  }
}

/** The index used when message search is turned off or unavailable. */
export const disabledIndex: BodyIndex = {
  enabled: false,
  add() {},
  removeSession() {},
  search: () => [],
  backfillState: () => undefined,
  setBackfillState() {},
  close() {}
};

/** Prepares the schema and statements on an open database. Throws when FTS5 trigram is missing. */
function createIndex(db: DatabaseSync): BodyIndex {
  // WAL keeps the TUI's searches from waiting on a backfill write, and the busy timeout covers a
  // second daemon (another OpenCode build) sharing the same data directory.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 2000;');
  migrate(db);

  const existing = db.prepare(
    `SELECT entry.id AS id, entry.created AS created, entry_text.text AS text
     FROM entry JOIN entry_text ON entry_text.rowid = entry.id
     WHERE entry.session_id = ? AND entry.entry_key = ?`
  );
  const lastId = db.prepare('SELECT max(id) AS id FROM entry WHERE id BETWEEN ? AND ?');
  const insertEntry = db.prepare(
    'INSERT INTO entry (id, session_id, entry_key, created) VALUES (?, ?, ?, ?)'
  );
  const insertText = db.prepare('INSERT INTO entry_text (rowid, text) VALUES (?, ?)');
  const deleteEntry = db.prepare('DELETE FROM entry WHERE id = ?');
  const deleteText = db.prepare('DELETE FROM entry_text WHERE rowid = ?');
  // FTS5 deletes go by rowid, so the session's ids are read first.
  const deleteSessionText = db.prepare(
    'DELETE FROM entry_text WHERE rowid IN (SELECT id FROM entry WHERE session_id = ?)'
  );
  const deleteSession = db.prepare('DELETE FROM entry WHERE session_id = ?');
  const deleteBackfill = db.prepare('DELETE FROM backfill WHERE session_id = ?');
  const readBackfill = db.prepare('SELECT cursor, done FROM backfill WHERE session_id = ?');
  const writeBackfill = db.prepare(
    `INSERT INTO backfill (session_id, cursor, done) VALUES (?, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET cursor = excluded.cursor, done = excluded.done`
  );

  /** Runs `body` in one write transaction, so an entry and its text never exist apart. */
  const transaction = (body: () => void) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      body();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  /**
   * The next free id in the millisecond of `created`. A thousand entries in one millisecond
   * overflow the slot; SQLite then picks an id past every other, which only misorders that entry.
   */
  const allocateId = (created: number): number | null => {
    const base = created * IDS_PER_MS;
    const last = rowNumber(lastId.get(base, base + IDS_PER_MS - 1), 'id');
    if (last === undefined) return base;
    return last + 1 < base + IDS_PER_MS ? last + 1 : null;
  };

  return {
    enabled: true,

    add(sessionID, entryKey, text, created) {
      if (text.trim() === '') return;
      const stored = truncate(text);
      const time = Math.max(0, Math.trunc(created));
      const previous = existing.get(sessionID, entryKey);
      // Backfill revisits entries live indexing already stored; rewriting them would only churn
      // FTS5 segments.
      if (previous?.text === stored && previous.created === time) return;
      transaction(() => {
        const previousId = rowNumber(previous, 'id');
        if (previousId !== undefined) {
          deleteText.run(previousId);
          deleteEntry.run(previousId);
        }
        const id = insertEntry.run(allocateId(time), sessionID, entryKey, time).lastInsertRowid;
        insertText.run(id, stored);
      });
    },

    removeSession(sessionID) {
      transaction(() => {
        deleteSessionText.run(sessionID);
        deleteSession.run(sessionID);
        deleteBackfill.run(sessionID);
      });
    },

    search(query, options) {
      const tokens = queryTokens(query);
      if (tokens === undefined) return [];
      return searchStatement(db, tokens.short.length)
        .all(tokens.match, ...tokens.short, options.limit)
        .map((row) => ({ sessionID: String(row.sessionID), created: Number(row.created) }));
    },

    backfillState(sessionID) {
      const row = readBackfill.get(sessionID);
      if (row === undefined) return undefined;
      return { cursor: row.cursor === null ? null : String(row.cursor), done: row.done === 1 };
    },

    setBackfillState(sessionID, state) {
      writeBackfill.run(sessionID, state.cursor, state.done ? 1 : 0);
    },

    close() {
      db.close();
    }
  };
}

/**
 * Creates the schema on a new file and records its version in `user_version`.
 *
 * The text lives in a regular FTS5 table rather than a contentless one (`content=''`,
 * `contentless_delete=1`). Contentless saves one copy of the text, roughly a quarter of the file
 * next to the trigram index, but it cannot return the text, and short tokens are checked against
 * it with `instr` because trigrams cannot match them.
 *
 * Keys, sessions and times sit in a plain table instead of UNINDEXED FTS5 columns: FTS5 cannot
 * index those, so every keyed upsert and session removal would scan the whole index.
 */
function migrate(db: DatabaseSync): void {
  const version = rowNumber(db.prepare('PRAGMA user_version').get(), 'user_version') ?? 0;
  if (version === SCHEMA_VERSION) return;
  if (version > SCHEMA_VERSION) {
    throw new Error(`search.db has schema ${version}, newer than this plugin understands`);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // The key is unique per session, not globally: a fork may carry its parent's message ids.
    db.exec(`
      CREATE TABLE entry (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        created INTEGER NOT NULL,
        UNIQUE (session_id, entry_key)
      );
      CREATE TABLE backfill (
        session_id TEXT PRIMARY KEY,
        cursor TEXT,
        done INTEGER NOT NULL DEFAULT 0
      );
    `);
    createTextTable(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Creates the trigram table. Trigrams match any 3+ character substring case-insensitively, which
 * suits code identifiers and paths that word tokenizers split badly. `remove_diacritics` needs
 * SQLite 3.45; older builds get plain trigrams, where "resume" stops matching "résumé".
 */
function createTextTable(db: DatabaseSync): void {
  try {
    db.exec(
      `CREATE VIRTUAL TABLE entry_text USING fts5(text, tokenize = 'trigram remove_diacritics 1')`
    );
  } catch {
    db.exec(`CREATE VIRTUAL TABLE entry_text USING fts5(text, tokenize = 'trigram')`);
  }
}

/**
 * The search over the newest {@link HIT_LIMIT} index hits, with one `instr` check per short token.
 * SQLite's `lower` folds ASCII only, so short non-ASCII tokens match their exact case.
 */
function searchStatement(db: DatabaseSync, shortTokens: number): StatementSync {
  const checks = Array.from({ length: shortTokens }, () => 'AND instr(lower(hits.text), ?) > 0');
  return db.prepare(`
    WITH hits AS (
      -- FTS5 walks rowids backwards and stops at the limit, so this reads only the newest hits.
      SELECT rowid AS id, text FROM entry_text
      WHERE entry_text MATCH ?
      ORDER BY rowid DESC
      LIMIT ${HIT_LIMIT}
    )
    SELECT entry.session_id AS sessionID, max(entry.created) AS created
    FROM hits JOIN entry ON entry.id = hits.id
    WHERE 1 ${checks.join(' ')}
    GROUP BY entry.session_id
    ORDER BY created DESC
    LIMIT ?
  `);
}

/**
 * Splits a query on whitespace. Tokens of three or more characters become quoted FTS5 phrases
 * (implicitly ANDed), so operators and punctuation in them match literally. Shorter ones cannot
 * use trigrams and are checked on the text. A query without a long token returns undefined: the
 * short checks alone would scan every entry.
 */
function queryTokens(query: string): { match: string; short: string[] } | undefined {
  const tokens = [...new Set(query.toLowerCase().split(/\s+/u).filter(Boolean))];
  const long = tokens.filter((token) => [...token].length >= 3);
  if (long.length === 0) return undefined;
  return {
    match: long.map((token) => `"${token.replaceAll('"', '""')}"`).join(' '),
    short: tokens.filter((token) => [...token].length < 3)
  };
}

/** Cuts text to {@link MAX_ENTRY_LENGTH} without splitting a surrogate pair. */
function truncate(text: string): string {
  if (text.length <= MAX_ENTRY_LENGTH) return text;
  const code = text.charCodeAt(MAX_ENTRY_LENGTH);
  const end = code >= 0xdc00 && code <= 0xdfff ? MAX_ENTRY_LENGTH - 1 : MAX_ENTRY_LENGTH;
  return text.slice(0, end);
}

/** Reads a numeric column from a row that may be missing or hold NULL. */
function rowNumber(row: Record<string, unknown> | undefined, column: string): number | undefined {
  const value = row?.[column];
  return typeof value === 'number' ? value : undefined;
}
