import { METADATA_KEY, type RefLink, type RefSource, refKey, type SessionRefs } from './ref.js';

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
    ? { next: { v: 1, links, dismissed: [...dismissed] }, changed }
    : { next: current, changed };
}

/**
 * Removes a link and records its key as dismissed. Dismissing a PR also drops the `closes`
 * links derived from it, without dismissing those issues: the user may still link them.
 */
export function dismissLink(current: SessionRefs, key: string): RefsUpdate {
  const links = current.links.filter(
    (link) => refKey(link.ref) !== key && !(link.source === 'closes' && link.via === key)
  );
  const alreadyDismissed = current.dismissed.includes(key);
  if (alreadyDismissed && links.length === current.links.length) {
    return { next: current, changed: false };
  }
  const dismissed = alreadyDismissed ? current.dismissed : [...current.dismissed, key];
  return { next: { v: 1, links, dismissed }, changed: true };
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
