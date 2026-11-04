import type { SessionRefView } from '../rpc.js';
import { type Ref, type RefLink, type RefSource, refKey, TRACKED_SOURCES } from './ref.js';

/** Refs drawn on a session row: the primary ref, an issue beside it, and how many more exist. */
export interface RowRefs {
  primary?: Ref;
  issue?: Ref;
  extra: number;
}

/** Input of {@link isDone}. */
export interface DoneInput {
  running: boolean;
  /** A permission or question is waiting for the user. */
  pending: boolean;
  archived: boolean;
  view: SessionRefView;
  /** Epoch milliseconds of the user's last message. Refs closed before it do not end the session. */
  lastUserMessageAt?: number;
}

const EXPLICIT_PR_SOURCES: ReadonlySet<RefSource> = new Set(['agent', 'created', 'manual']);
const ROW_ISSUE_SOURCES: ReadonlySet<RefSource> = new Set(['prompt', 'closes']);
const CLOSED_STATUSES = new Set(['merged', 'closed', 'completed', 'not_planned']);

/** The link with the highest `linkedAt`, or undefined for an empty list. */
function newest(links: RefLink[]): RefLink | undefined {
  let best: RefLink | undefined;
  for (const link of links) if (best === undefined || link.linkedAt > best.linkedAt) best = link;
  return best;
}

/** Links whose source counts toward Done and the row. */
function trackedLinks(view: SessionRefView): RefLink[] {
  return view.links.filter((link) => TRACKED_SOURCES.has(link.source));
}

/** Branch pull requests plus tracked links, deduped by key. Mentions are left out. */
export function trackedRefs(view: SessionRefView): Ref[] {
  const refs = new Map<string, Ref>();
  for (const ref of [...view.branchRefs, ...trackedLinks(view).map((link) => link.ref)]) {
    const key = refKey(ref);
    if (!refs.has(key)) refs.set(key, ref);
  }
  return [...refs.values()];
}

/**
 * Picks what a session row shows. The primary ref is the branch PR, else the newest PR the agent
 * or user linked, else the newest PR from a prompt, else the newest tracked issue. The issue
 * beside it is the newest `prompt` or `closes` issue, preferring one the primary PR closes.
 * `extra` counts every other ref, mentions included.
 */
export function rowRefs(view: SessionRefView): RowRefs {
  const tracked = trackedLinks(view);
  const prs = tracked.filter((link) => link.ref.kind === 'pr');
  const primary =
    view.branchRefs[0] ??
    newest(prs.filter((link) => EXPLICIT_PR_SOURCES.has(link.source)))?.ref ??
    newest(prs)?.ref ??
    newest(tracked.filter((link) => link.ref.kind === 'issue'))?.ref;
  const primaryKey = primary === undefined ? undefined : refKey(primary);

  const issues = tracked.filter(
    (link) =>
      link.ref.kind === 'issue' &&
      ROW_ISSUE_SOURCES.has(link.source) &&
      refKey(link.ref) !== primaryKey
  );
  // The PR snapshot knows its closing issues before a `closes` link is stored, so check both.
  const closedByPrimary = new Set(
    (primaryKey === undefined ? undefined : view.states[primaryKey]?.closes)?.map(refKey)
  );
  const preferred = issues.filter(
    (link) =>
      (primaryKey !== undefined && link.via === primaryKey) || closedByPrimary.has(refKey(link.ref))
  );
  const issue = (newest(preferred) ?? newest(issues))?.ref;

  const shown = new Set([primaryKey, issue === undefined ? undefined : refKey(issue)]);
  const others = new Set(
    [...view.branchRefs, ...view.links.map((link) => link.ref)]
      .map(refKey)
      .filter((key) => !shown.has(key))
  );
  return {
    ...(primary === undefined ? {} : { primary }),
    ...(issue === undefined ? {} : { issue }),
    extra: others.size
  };
}

/** Refs listed in the session sidebar, in display order, and how many mentions were left out. */
export interface SidebarRefs {
  refs: Ref[];
  mentioned: number;
}

/**
 * Orders a session's tracked refs for the sidebar: branch pull requests, then pull requests the
 * agent or user linked, then other pull requests, then issues, newest link first within each
 * group. Mentions are only counted.
 */
export function sidebarRefs(view: SessionRefView): SidebarRefs {
  const rank = (link: RefLink) =>
    link.ref.kind === 'issue' ? 2 : EXPLICIT_PR_SOURCES.has(link.source) ? 0 : 1;
  const links = trackedLinks(view).sort((a, b) => rank(a) - rank(b) || b.linkedAt - a.linkedAt);
  const refs = new Map<string, Ref>();
  // A ref linked twice keeps its first, highest-ranked place.
  for (const ref of [...view.branchRefs, ...links.map((link) => link.ref)]) {
    const key = refKey(ref);
    if (!refs.has(key)) refs.set(key, ref);
  }
  const mentioned = new Set(
    view.links
      .filter((link) => link.source === 'mention')
      .map((link) => refKey(link.ref))
      .filter((key) => !refs.has(key))
  );
  return { refs: [...refs.values()], mentioned: mentioned.size };
}

/**
 * Refs whose state decides Done: tracked PRs when the session has any, otherwise tracked issues
 * that are not `closes` links (those follow a PR and never decide on their own).
 */
function deciding(view: SessionRefView): Ref[] {
  const tracked = trackedRefs(view);
  const prs = tracked.filter((ref) => ref.kind === 'pr');
  if (prs.length > 0) return prs;
  return trackedLinks(view)
    .filter((link) => link.ref.kind === 'issue' && link.source !== 'closes')
    .map((link) => link.ref);
}

/** Latest `mergedAt`/`closedAt` among the refs, or undefined when none has one. */
function latestClose(view: SessionRefView, refs: Ref[]): number | undefined {
  let latest: number | undefined;
  for (const ref of refs) {
    const state = view.states[refKey(ref)];
    const at = state?.mergedAt ?? state?.closedAt;
    if (at !== undefined && (latest === undefined || at > latest)) latest = at;
  }
  return latest;
}

/**
 * Whether a session belongs in the Done view: idle, not archived, every deciding ref merged or
 * closed after the user's last message, and every tracked ref's state known. Unknown state is
 * treated as not Done so a failed fetch never hides a session.
 */
export function isDone(input: DoneInput): boolean {
  const { view } = input;
  if (input.running || input.pending || input.archived) return false;
  const refs = deciding(view);
  if (refs.length === 0) return false;
  if (!trackedRefs(view).every((ref) => view.states[refKey(ref)] !== undefined)) return false;
  const closed = refs.every((ref) => {
    const status = view.states[refKey(ref)]?.status;
    return status !== undefined && CLOSED_STATUSES.has(status);
  });
  if (!closed) return false;
  if (input.lastUserMessageAt === undefined) return true;
  const latest = latestClose(view, refs);
  return latest !== undefined && latest > input.lastUserMessageAt;
}

/** When the session's deciding refs last merged or closed, for grouping the Done view by day. */
export function doneAt(view: SessionRefView): number | undefined {
  return latestClose(view, deciding(view));
}
