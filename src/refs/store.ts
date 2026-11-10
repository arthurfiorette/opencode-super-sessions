import {
  METADATA_KEY,
  type RefLink,
  type RefSource,
  refKey,
  type SessionRefs,
  type WorkLink
} from './ref.js';
import { recognizeLink } from './work-link.js';

/** Result of a pure update. `changed` is false when `next` equals the input, so callers skip the write. */
export interface RefsUpdate {
  next: SessionRefs;
  changed: boolean;
}

// A link's source only moves up this ladder. Explicit links outrank anything detection inferred,
// and an issue the user named in a prompt outranks one derived from a PR body.
const PRIORITY: Record<RefSource, number> = {
  agent: 3,
  created: 3,
  manual: 3,
  prompt: 2,
  closes: 1,
  mention: 0
};

// Only a deliberate link by the user or agent may revive a dismissed key. `created` is still
// detection, so a dismissed PR stays hidden even if a later script prints its URL again.
const EXPLICIT: ReadonlySet<RefSource> = new Set(['agent', 'manual']);

/** Copies a link, keeping `via` only on `closes` links since it means nothing for other sources. */
function normalized(link: RefLink): RefLink {
  const { via, ...rest } = link;
  return link.source === 'closes' && via !== undefined ? { ...rest, via } : rest;
}

/** Combines a stored link with an incoming one for the same key. */
function combine(existing: RefLink, incoming: RefLink): RefLink {
  const upgrade = PRIORITY[incoming.source] > PRIORITY[existing.source];
  const source = upgrade ? incoming.source : existing.source;
  const link: RefLink = {
    ref: existing.ref,
    source,
    linkedAt: Math.min(existing.linkedAt, incoming.linkedAt)
  };
  const via = source === 'closes' ? (existing.via ?? incoming.via) : undefined;
  return via === undefined ? link : { ...link, via };
}

/** Whether two links hold the same values. Links are flat apart from `ref`, which never changes per key. */
function sameLink(a: RefLink, b: RefLink): boolean {
  return a.source === b.source && a.linkedAt === b.linkedAt && a.via === b.via;
}

/**
 * Adds links, deduped by {@link refKey}. Existing links keep their earliest `linkedAt` and only
 * move to a higher-priority source. Dismissed keys are skipped unless the incoming link is an
 * explicit `agent` or `manual` link, which removes the dismissal.
 */
export function mergeLinks(current: SessionRefs, incoming: RefLink[]): RefsUpdate {
  const links = [...current.links];
  const dismissed = new Set(current.dismissed);
  let changed = false;
  for (const link of incoming) {
    const key = refKey(link.ref);
    if (dismissed.has(key)) {
      if (!EXPLICIT.has(link.source)) continue;
      dismissed.delete(key);
      changed = true;
    }
    const index = links.findIndex((existing) => refKey(existing.ref) === key);
    const existing = links[index];
    if (existing === undefined) {
      links.push(normalized(link));
      changed = true;
      continue;
    }
    const next = combine(existing, link);
    if (!sameLink(existing, next)) {
      links[index] = next;
      changed = true;
    }
  }
  return changed
    ? { next: { ...current, links, dismissed: [...dismissed] }, changed }
    : { next: current, changed };
}

/**
 * Adds work links, deduped by their {@link recognizeLink} key, like {@link mergeLinks}: the
 * earliest `linkedAt` stays, the source only moves up, and a dismissed key comes back only
 * through an explicit `agent` or `manual` link. A given title replaces the stored one, since the
 * latest one the agent or user gave is the best they know. URLs that do not parse are skipped.
 */
export function mergeWorkLinks(current: SessionRefs, incoming: WorkLink[]): RefsUpdate {
  const urls = [...(current.urls ?? [])];
  const dismissed = new Set(current.dismissed);
  const keyOf = (link: WorkLink) => recognizeLink(link.url)?.key;
  let changed = false;
  for (const link of incoming) {
    const key = keyOf(link);
    if (key === undefined) continue;
    if (dismissed.has(key)) {
      if (!EXPLICIT.has(link.source)) continue;
      dismissed.delete(key);
      changed = true;
    }
    const index = urls.findIndex((existing) => keyOf(existing) === key);
    const existing = urls[index];
    if (existing === undefined) {
      urls.push(link);
      changed = true;
      continue;
    }
    const upgrade = PRIORITY[link.source] > PRIORITY[existing.source];
    const title = link.title ?? existing.title;
    const next: WorkLink = {
      url: existing.url,
      source: upgrade ? link.source : existing.source,
      linkedAt: Math.min(existing.linkedAt, link.linkedAt),
      ...(title === undefined ? {} : { title })
    };
    if (
      next.source !== existing.source ||
      next.linkedAt !== existing.linkedAt ||
      next.title !== existing.title
    ) {
      urls[index] = next;
      changed = true;
    }
  }
  return changed
    ? { next: { ...current, urls, dismissed: [...dismissed] }, changed }
    : { next: current, changed };
}

/**
 * Removes a link and records its key as dismissed. Dismissing a PR also drops the `closes`
 * links derived from it, without dismissing those issues: the user may still link them. A work
 * link's key (`link:...`) removes the work link instead.
 */
export function dismissLink(current: SessionRefs, key: string): RefsUpdate {
  const links = current.links.filter(
    (link) => refKey(link.ref) !== key && !(link.source === 'closes' && link.via === key)
  );
  const urls = current.urls?.filter((link) => recognizeLink(link.url)?.key !== key);
  const removed = links.length !== current.links.length || urls?.length !== current.urls?.length;
  const alreadyDismissed = current.dismissed.includes(key);
  if (alreadyDismissed && !removed) return { next: current, changed: false };
  const dismissed = alreadyDismissed ? current.dismissed : [...current.dismissed, key];
  return {
    next: { ...current, links, ...(urls === undefined ? {} : { urls }), dismissed },
    changed: true
  };
}

/**
 * Sets the user's Done override, or clears it with `null`. Marking Done records `now`, which
 * auto-archive counts from; marking a session that is already marked keeps the first time.
 */
export function setDone(current: SessionRefs, done: boolean | null, now: number): RefsUpdate {
  if ((current.done ?? null) === done) return { next: current, changed: false };
  const { done: _done, doneAt: _doneAt, ...rest } = current;
  if (done === null) return { next: rest, changed: true };
  return { next: done ? { ...rest, done, doneAt: now } : { ...rest, done }, changed: true };
}

/**
 * Records that the history scan read the session, pushes included, through `lastMessageID`. A
 * session already marked keeps its first marker, so a second scan of it writes nothing; a marker
 * from before push detection only gains `pushes`.
 */
export function markScanned(
  current: SessionRefs,
  scannedAt: number,
  lastMessageID: string | undefined
): RefsUpdate {
  if (current.scanned?.pushes === true) return { next: current, changed: false };
  if (current.scanned !== undefined) {
    return { next: { ...current, scanned: { ...current.scanned, pushes: true } }, changed: true };
  }
  const scanned =
    lastMessageID === undefined
      ? { scannedAt, pushes: true as const }
      : { scannedAt, lastMessageID, pushes: true as const };
  return { next: { ...current, scanned }, changed: true };
}

// A session pushes to a handful of branches; the cap only bounds a runaway script.
const PUSHED_MAX = 50;

/**
 * Records branches the session pushed, keeping the newest {@link PUSHED_MAX}. A branch already
 * recorded writes nothing.
 */
export function addPushed(current: SessionRefs, branches: readonly string[]): RefsUpdate {
  const known = current.pushed ?? [];
  const added = [...new Set(branches)].filter((branch) => !known.includes(branch));
  if (added.length === 0) return { next: current, changed: false };
  return { next: { ...current, pushed: [...known, ...added].slice(-PUSHED_MAX) }, changed: true };
}

/** Removes a key from `dismissed` so detection may add it again. */
export function undismiss(current: SessionRefs, key: string): RefsUpdate {
  if (!current.dismissed.includes(key)) return { next: current, changed: false };
  return {
    next: { ...current, dismissed: current.dismissed.filter((value) => value !== key) },
    changed: true
  };
}

/** Returns session metadata with this plugin's value replaced and every other key preserved. */
export function withSessionRefs(
  metadata: Record<string, unknown> | undefined,
  refs: SessionRefs
): Record<string, unknown> {
  return { ...metadata, [METADATA_KEY]: refs };
}
