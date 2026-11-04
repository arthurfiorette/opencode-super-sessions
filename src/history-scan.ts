import type { SessionInfo, SessionMessageInfo } from '@opencode/client';
import type { Plugin } from '@opencode/plugin/tui';
import { type HistoryEntry, storedHistory } from './host/events.js';
import { readSessionRefs } from './refs/ref.js';
import { HISTORY_ITEMS_MAX, HISTORY_TEXT_MAX, type HistoryItem, SuperSessions } from './rpc.js';

// Reads the stored history of sessions the plugin never saw live and hands it to the server's
// `history.scan`. No OpenTUI imports: `./tui` loads this from Node, and the integration test
// drives `scanSession` against an SDK host.

/** Messages per `message.list` page. */
const PAGE_SIZE = 100;
/** Text per `history.scan` call, next to the item cap in `HISTORY_ITEMS_MAX`. */
const CHUNK_TEXT = 256 * 1024;
/** Rest between two pages of one session, so a long history never floods the daemon. */
const PAGE_PAUSE_MS = 100;
/** Rest between two sessions. */
const SESSION_PAUSE_MS = 250;
/** Least time between two progress toasts of "Scan all sessions now". */
const PROGRESS_EVERY_MS = 1000;

/** A page of messages and the cursor to the older ones, as `message.list` returned them. */
export interface HistoryPage {
  messages: readonly SessionMessageInfo[];
  cursor: string | undefined;
}

/** The part of an HTTP client (the TUI's `context.client`, or an SDK host) a scan uses. */
export type HistoryClient = Pick<Plugin.Context['client'], 'message' | 'rpc'>;

/** Where a scan reads pages and sends chunks. */
export interface HistorySource {
  /** The newest page without a cursor, else the page after `cursor`. */
  page(sessionID: string, cursor: string | undefined): Promise<HistoryPage>;
  send(input: {
    sessionID: string;
    items: HistoryItem[];
    done: boolean;
    lastMessageID?: string;
  }): Promise<{ skipped: boolean }>;
}

/** How a scan of one session ended. */
export type ScanResult = 'scanned' | 'skipped' | 'cancelled';

/** Reads pages through `client.message.list` and sends chunks to the server plugin. */
export function historySource(
  client: HistoryClient,
  location: () => { directory: string }
): HistorySource {
  return {
    async page(sessionID, cursor) {
      // The cursor carries the first page's order; the API rejects `order` next to it.
      const page = await client.message.list(
        cursor === undefined
          ? { sessionID, order: 'desc', limit: PAGE_SIZE }
          : { sessionID, cursor, limit: PAGE_SIZE }
      );
      return { messages: page.data, cursor: page.cursor.next ?? undefined };
    },
    send: (input) => client.rpc(SuperSessions)['history.scan'](input, { location: location() })
  };
}

/**
 * Scans one session's whole history, newest page first. `first` is a page the caller already
 * loaded, such as the preview's, so it is not fetched again. Items go out in chunks of at most
 * `HISTORY_ITEMS_MAX` items and {@link CHUNK_TEXT} of text; the last call sets `done`, which
 * records the scan marker. Stops early when the server says the session was already scanned, or
 * when `cancelled` turns true between pages.
 */
export async function scanSession(
  source: HistorySource,
  sessionID: string,
  options: {
    first?: HistoryPage | undefined;
    cancelled?: () => boolean;
    pause?: (ms: number) => Promise<void>;
  } = {}
): Promise<ScanResult> {
  const cancelled = options.cancelled ?? (() => false);
  const pause = options.pause ?? sleep;
  let page = options.first ?? (await source.page(sessionID, undefined));
  const lastMessageID = newestID(page.messages);
  const pending: HistoryItem[] = [];
  for (;;) {
    if (cancelled()) return 'cancelled';
    pending.push(...historyItems(page.messages));
    const last = page.cursor === undefined;
    for (;;) {
      const size = chunkSize(pending);
      // A chunk that is not full yet waits for the next page. The last page sends the rest, and
      // an empty `done` call when nothing is left, so a session without items gets its marker.
      if (!last && size === pending.length && size < HISTORY_ITEMS_MAX) break;
      const items = pending.splice(0, size);
      const done = last && pending.length === 0;
      const result = await source.send({
        sessionID,
        items,
        done,
        ...(done && lastMessageID !== undefined ? { lastMessageID } : {})
      });
      if (result.skipped) return 'skipped';
      if (done) return 'scanned';
    }
    await pause(PAGE_PAUSE_MS);
    if (cancelled()) return 'cancelled';
    page = await source.page(sessionID, page.cursor);
  }
}

/** How many of the first items fit in one call. Always at least one. */
function chunkSize(items: readonly HistoryItem[]): number {
  let text = 0;
  let count = 0;
  for (const item of items) {
    text += item.type === 'shell' ? item.command.length + item.output.length : item.text.length;
    if (count > 0 && (count === HISTORY_ITEMS_MAX || text > CHUNK_TEXT)) break;
    count++;
  }
  return count;
}

/** Id of the newest message on a page, whatever order the page is in. */
function newestID(messages: readonly SessionMessageInfo[]): string | undefined {
  let newest: SessionMessageInfo | undefined;
  for (const message of messages) {
    if (newest === undefined || message.time.created > newest.time.created) newest = message;
  }
  return newest?.id;
}

/**
 * The items of a page the server can use. Shell output is cut to the lines that hold a URL:
 * `gh pr create` and the like print the new URL alone on a line, and the other lines can be
 * megabytes of build output. A command without such a line can create nothing and is dropped.
 */
export function historyItems(messages: readonly SessionMessageInfo[]): HistoryItem[] {
  return storedHistory(messages).flatMap((entry: HistoryEntry): HistoryItem[] => {
    if (entry.type !== 'shell') {
      if (entry.text.trim() === '') return [];
      return [{ ...entry, text: entry.text.slice(0, HISTORY_TEXT_MAX) }];
    }
    const urls = entry.output.split('\n').filter((line) => line.includes('://'));
    if (urls.length === 0) return [];
    return [
      {
        type: 'shell',
        command: entry.command.slice(0, HISTORY_TEXT_MAX),
        output: urls.join('\n').slice(0, HISTORY_TEXT_MAX),
        created: entry.created
      }
    ];
  });
}

/**
 * Every root session `filters` select, archived ones included, following list cursors. Subagent
 * sessions are left out like in the browser's lists.
 */
export async function listSessions(
  client: Pick<Plugin.Context['client'], 'session'>,
  filters: { directory: string } | { project: string; subpath: string } | Record<string, never>
): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.session.list({
      ...filters,
      parentID: null,
      limit: 200,
      order: 'desc',
      ...(cursor === undefined ? {} : { cursor })
    });
    sessions.push(...page.data);
    cursor = page.cursor.next ?? undefined;
  } while (cursor !== undefined);
  return sessions;
}

/** Resolves after `ms` without keeping the process alive. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

/** Why a session is scanned, which decides what cancels it and what runs first. */
type ScanReason = 'open' | 'preview' | 'all';

interface Job {
  sessionID: string;
  reason: ScanReason;
  first?: HistoryPage | undefined;
  cancelled: boolean;
  finished(result: ScanResult | 'failed'): void;
}

/** One-session-at-a-time history scans for the TUI. */
export interface HistoryScanner {
  /**
   * Scans a session the browser's preview shows, starting from the page the preview loaded.
   * Replaces an earlier preview scan that has not started; the browser closing cancels it.
   */
  preview(sessionID: string, first?: HistoryPage): void;
  /** Scans a session the user peeked or opened. Closing the browser does not stop it. */
  open(sessionID: string): void;
  /** Drops preview scans: the queued one, and the running one at its next page. */
  cancelPreviews(): void;
  /**
   * Scans each session, oldest request last, with progress in a toast. Sessions the user
   * previews or opens meanwhile go first.
   */
  scanAll(sessions: readonly SessionInfo[]): Promise<void>;
  /** Called after a scan finished, so views refetch the session's refs. */
  onScanned(listener: (sessionID: string) => void): () => void;
  dispose(): void;
}

/**
 * Creates the scanner. Nothing runs until a session is previewed, opened or "Scan all sessions
 * now" asks for it. Sessions with a scan marker in their synced metadata, and sessions this
 * process already scanned or failed to scan, are skipped without a request.
 */
export function createHistoryScanner(context: Plugin.Context): HistoryScanner {
  const source = historySource(
    context.client,
    () => context.location ?? context.data.location.default()
  );
  const finished = new Set<string>();
  const listeners = new Set<(sessionID: string) => void>();
  let queue: Job[] = [];
  let running: Job | undefined;
  let disposed = false;

  const marked = (sessionID: string, info?: SessionInfo) =>
    readSessionRefs((context.data.session.get(sessionID) ?? info)?.metadata).scanned !== undefined;
  const known = (sessionID: string) =>
    finished.has(sessionID) ||
    running?.sessionID === sessionID ||
    queue.some((job) => job.sessionID === sessionID);
  const rank: Record<ScanReason, number> = { open: 0, preview: 1, all: 2 };

  /** Queues a job behind the jobs of the same or a more urgent reason. */
  const enqueue = (job: Job) => {
    const index = queue.findIndex((queued) => rank[queued.reason] > rank[job.reason]);
    if (index === -1) queue.push(job);
    else queue.splice(index, 0, job);
    void drain();
  };

  let draining = false;
  /** Runs queued jobs one at a time until the queue is empty. */
  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      for (let job = queue.shift(); job !== undefined && !disposed; job = queue.shift()) {
        running = job;
        const result = await scanSession(source, job.sessionID, {
          first: job.first,
          cancelled: () => job.cancelled || disposed
        }).catch((): 'failed' => 'failed');
        running = undefined;
        // A failed scan, often a server plugin that is missing, is not retried in this process.
        if (result !== 'cancelled') finished.add(job.sessionID);
        if (result === 'scanned') for (const listener of listeners) listener(job.sessionID);
        job.finished(result);
        if (queue.length > 0) await sleep(SESSION_PAUSE_MS);
      }
    } finally {
      draining = false;
      running = undefined;
    }
  };

  /** Moves an existing job for the session up to `open`, so closing the browser keeps it. */
  const promote = (sessionID: string): boolean => {
    const job =
      running?.sessionID === sessionID
        ? running
        : queue.find((queued) => queued.sessionID === sessionID);
    if (job === undefined) return false;
    job.reason = 'open';
    job.cancelled = false;
    queue = queue.filter((queued) => queued !== job);
    if (job !== running) queue.unshift(job);
    return true;
  };

  return {
    preview(sessionID, first) {
      if (disposed || known(sessionID) || marked(sessionID)) return;
      queue = queue.filter((job) => job.reason !== 'preview');
      enqueue({ sessionID, reason: 'preview', first, cancelled: false, finished: () => {} });
    },
    open(sessionID) {
      if (disposed || finished.has(sessionID) || promote(sessionID) || marked(sessionID)) return;
      enqueue({ sessionID, reason: 'open', cancelled: false, finished: () => {} });
    },
    cancelPreviews() {
      queue = queue.filter((job) => job.reason !== 'preview');
      if (running?.reason === 'preview') running.cancelled = true;
    },
    async scanAll(sessions) {
      const todo = sessions.filter(
        (session) => !finished.has(session.id) && !marked(session.id, session)
      );
      const skipped = sessions.length - todo.length;
      if (todo.length === 0) {
        context.ui.toast.show({
          message: `All ${count(sessions.length, 'session')} were already scanned.`,
          variant: 'success'
        });
        return;
      }
      let done = 0;
      let failed = 0;
      let shownAt = 0;
      const progress = () => {
        const now = Date.now();
        if (now - shownAt < PROGRESS_EVERY_MS) return;
        shownAt = now;
        context.ui.toast.show({
          message: `Scanning session history: ${done} of ${todo.length}`,
          variant: 'info'
        });
      };
      progress();
      await Promise.all(
        todo.map(
          (session) =>
            new Promise<void>((resolve) => {
              const finish = (result: ScanResult | 'failed') => {
                done++;
                if (result === 'failed' || result === 'cancelled') failed++;
                progress();
                resolve();
              };
              // Already queued or running for a preview or an open: wait for that scan instead.
              if (known(session.id)) {
                const job =
                  running?.sessionID === session.id
                    ? running
                    : queue.find((queued) => queued.sessionID === session.id);
                if (job === undefined) return finish('skipped');
                // Closing the browser must not cancel a scan this run waits for.
                if (job.reason === 'preview') job.reason = 'all';
                const previous = job.finished;
                job.finished = (result) => {
                  previous(result);
                  finish(result);
                };
                return;
              }
              enqueue({ sessionID: session.id, reason: 'all', cancelled: false, finished: finish });
            })
        )
      );
      if (disposed) return;
      const scanned = todo.length - failed;
      context.ui.toast.show({
        message: [
          `Scanned ${count(scanned, 'session')}`,
          ...(skipped > 0 ? [`${skipped} already scanned`] : []),
          ...(failed > 0 ? [`${failed} failed`] : [])
        ].join(', '),
        variant: failed > 0 ? 'warning' : 'success'
      });
    },
    onScanned(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      queue = [];
      if (running) running.cancelled = true;
      listeners.clear();
    }
  };
}

/** "1 session", "3 sessions". */
function count(value: number, noun: string): string {
  return `${value} ${value === 1 ? noun : `${noun}s`}`;
}
