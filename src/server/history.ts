import type { RefCandidate, RepoRef } from '../providers/provider.js';
import { detectCreated, detectInPrompt, detectInText } from '../refs/detect.js';
import { pushedBranches, runsPush } from '../refs/push.js';
import {
  historyScanned,
  type RefLink,
  type RefSource,
  readSessionRefs,
  refKey,
  type SessionRefs,
  type WorkLink
} from '../refs/ref.js';
import { addPushed, markScanned, mergeLinks, mergeWorkLinks } from '../refs/store.js';
import { recognizeLink, trackerLinks } from '../refs/work-link.js';
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
 * older than the plugin or written while it was not running. A session the scan is done with
 * (see {@link historyScanned}) is skipped whole, so the TUI stops paging it. A session scanned
 * by a version without push detection or work links gets one more pass for only what that
 * version missed: its forge links and index entries are in place, and redoing them would cost
 * forge lookups for nothing. All links and pushes of a chunk, and the marker on the last one, go
 * through the write queue in one update that writes only when something changed.
 */
export async function scanHistory(
  runtime: Runtime,
  session: SessionAccess,
  chunk: HistoryChunk
): Promise<{ skipped: boolean }> {
  const { sessionID, items, done, lastMessageID } = chunk;
  const info = await session.get({ sessionID });
  const stored = readSessionRefs(info.metadata);
  if (historyScanned(stored)) return { skipped: true };
  const full = stored.scanned === undefined;
  if (full) await indexItems(runtime, sessionID, items);
  const links = full ? await detectItems(runtime, info.location.directory, items) : [];
  const work = full || stored.scanned?.links !== true ? promptWorkLinks(runtime, items) : [];
  const pushed =
    full || stored.scanned?.pushes !== true
      ? await detectPushes(runtime, info.location.directory, items)
      : [];
  if (links.length === 0 && work.length === 0 && pushed.length === 0 && !done) {
    return { skipped: false };
  }
  await runtime.writes.update(session, sessionID, (refs) => {
    const merged = mergeLinks(refs, keepLinkedAt(refs, links));
    const linked = mergeWorkLinks(merged.next, keepWorkLinkedAt(merged.next, work));
    const recorded = addPushed(linked.next, pushed);
    const changed = merged.changed || linked.changed || recorded.changed;
    if (!done) return { next: recorded.next, changed };
    const marked = markScanned(recorded.next, Date.now(), lastMessageID);
    return { next: marked.next, changed: changed || marked.changed };
  });
  return { skipped: false };
}

/**
 * Branches the chunk's `git push` commands wrote, as live detection records them. The branch
 * checked out now stands in for a push whose output names none, which is right unless the
 * checkout moved since; git's report, which the TUI keeps for push commands, usually names it.
 */
async function detectPushes(
  runtime: Runtime,
  directory: string,
  items: HistoryItem[]
): Promise<string[]> {
  let current: Promise<string | undefined> | undefined;
  const branches: string[] = [];
  for (const item of items) {
    if (item.type !== 'shell' || !runsPush(item.command)) continue;
    // Read once per chunk, and only for a chunk with pushes.
    current ??= resolveRepo(runtime, directory).then((info) => info.branch);
    branches.push(...pushedBranches(item.command, item.output, await current));
  }
  return branches;
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

/** Tracker URLs in the chunk's prompts, as live detection links them, when `detect.prompts` is on. */
function promptWorkLinks(runtime: Runtime, items: HistoryItem[]): WorkLink[] {
  if (!runtime.options.detect.prompts) return [];
  return items.flatMap((item) =>
    item.type === 'prompt'
      ? trackerLinks(item.text).map(
          (info): WorkLink => ({ url: info.url, source: 'prompt', linkedAt: item.created })
        )
      : []
  );
}

/** {@link keepLinkedAt} for work links, by their key. */
function keepWorkLinkedAt(refs: SessionRefs, links: WorkLink[]): WorkLink[] {
  const stored = new Map(
    (refs.urls ?? []).map((link) => [recognizeLink(link.url)?.key, link.linkedAt])
  );
  return links.map((link) => {
    const linkedAt = stored.get(recognizeLink(link.url)?.key);
    return linkedAt === undefined ? link : { ...link, linkedAt };
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
