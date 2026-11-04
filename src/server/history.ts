import type { RefCandidate, RepoRef } from '../providers/provider.js';
import { detectCreated, detectInPrompt, detectInText } from '../refs/detect.js';
import {
  type RefLink,
  type RefSource,
  readSessionRefs,
  refKey,
  type SessionRefs
} from '../refs/ref.js';
import { markScanned, mergeLinks } from '../refs/store.js';
import type { HistoryItem } from '../rpc.js';
import { resolveCandidates, resolveRepo } from './links.js';
import type { SessionAccess } from './queue.js';
import { type Runtime, warn } from './runtime.js';

/** One chunk of a session's stored history, as `history.scan` receives it. */
export interface HistoryChunk {
  sessionID: string;
  items: HistoryItem[];
  /** Set on the last chunk, which records the scan marker. */
  done: boolean;
  lastMessageID?: string | undefined;
}

/** A candidate found in one history item, with what linking it needs. */
interface Found {
  candidate: RefCandidate;
  source: RefSource;
  /** A bare number from a prompt: linked only when the forge found it. */
  confirm: boolean;
  /** When the message that named it was written. */
  linkedAt: number;
}

/**
 * Runs live detection and indexing over one chunk of a session's stored messages, for sessions
 * older than the plugin or written while it was not running. A session with a scan marker is
 * skipped whole, so the TUI stops paging it. All links of a chunk, and the marker on the last
 * one, go through the write queue in one update that writes only when something changed.
 */
export async function scanHistory(
  runtime: Runtime,
  session: SessionAccess,
  chunk: HistoryChunk
): Promise<{ skipped: boolean }> {
  const { sessionID, items, done, lastMessageID } = chunk;
  const info = await session.get({ sessionID });
  if (readSessionRefs(info.metadata).scanned !== undefined) return { skipped: true };
  await indexItems(runtime, sessionID, items);
  const links = await detectItems(runtime, info.location.directory, items);
  if (links.length === 0 && !done) return { skipped: false };
  await runtime.writes.update(session, sessionID, (refs) => {
    const merged = mergeLinks(refs, keepLinkedAt(refs, links));
    if (!done) return merged;
    const marked = markScanned(merged.next, Date.now(), lastMessageID);
    return { next: marked.next, changed: merged.changed || marked.changed };
  });
  return { skipped: false };
}

/**
 * Stores prompts and assistant text in the message index under the keys live indexing and the
 * backfill use, so text they already stored is not stored twice. A disabled index (`search.body`
 * off) ignores the calls.
 */
async function indexItems(runtime: Runtime, sessionID: string, items: HistoryItem[]) {
  try {
    const index = await runtime.bodyIndex();
    for (const item of items) {
      if (item.type !== 'shell') index.add(sessionID, item.key, item.text, item.created);
    }
  } catch (error) {
    // Search misses this text; detection below must still run.
    warn(`Indexing the history of ${sessionID} failed`, error);
  }
}

/**
 * The links live detection would have made from these items: refs in prompts (bare numbers
 * against the session's repository, kept only when the forge confirms them), mentions in
 * assistant text, and refs `gh pr create` and the like printed. `detect.prompts` and
 * `detect.mentions` apply as they do live. One forge lookup covers the whole chunk.
 */
async function detectItems(
  runtime: Runtime,
  directory: string,
  items: HistoryItem[]
): Promise<RefLink[]> {
  const { prompts, mentions } = runtime.options.detect;
  const found: Found[] = [];
  const add = (
    candidates: RefCandidate[],
    source: RefSource,
    linkedAt: number,
    bare?: ReadonlySet<RefCandidate>
  ) => {
    for (const candidate of candidates) {
      found.push({ candidate, source, confirm: bare?.has(candidate) ?? false, linkedAt });
    }
  };
  let base: Promise<RepoRef | undefined> | undefined;
  for (const item of items) {
    if (item.type === 'prompt' && prompts) {
      // Read once per chunk, and only for a chunk with prompts.
      base ??= resolveRepo(runtime, directory).then((info) => info.repo);
      const { candidates, bare } = detectInPrompt(runtime.definitions, item.text, await base);
      add(candidates, 'prompt', item.created, bare);
    }
    if (item.type === 'text' && mentions) {
      add(detectInText(runtime.definitions, item.text), 'mention', item.created);
    }
    if (item.type === 'shell') {
      add(detectCreated(runtime.definitions, item.command, item.output), 'created', item.created);
    }
  }
  if (found.length === 0) return [];
  const resolutions = await resolveCandidates(
    runtime,
    found.map((entry) => entry.candidate)
  );
  return found.flatMap((entry, index): RefLink[] => {
    const resolution = resolutions[index];
    if (resolution?.status === 'found') {
      return [{ ref: resolution.ref, source: entry.source, linkedAt: entry.linkedAt }];
    }
    // Like live detection: a ref of known kind is linked while the forge cannot answer.
    if (resolution?.status === 'unverified' && !entry.confirm) {
      return [{ ref: resolution.ref, source: entry.source, linkedAt: entry.linkedAt }];
    }
    return [];
  });
}

/**
 * Gives incoming links the `linkedAt` of a stored link for the same ref. History links carry the
 * time of their message, which is earlier than the time live detection stamped on the same ref,
 * and `mergeLinks` keeps the earliest; without this, scanning a session live detection already
 * covered would rewrite its links for nothing.
 */
function keepLinkedAt(refs: SessionRefs, links: RefLink[]): RefLink[] {
  const stored = new Map(refs.links.map((link) => [refKey(link.ref), link.linkedAt]));
  return links.map((link) => {
    const linkedAt = stored.get(refKey(link.ref));
    return linkedAt === undefined ? link : { ...link, linkedAt };
  });
}
