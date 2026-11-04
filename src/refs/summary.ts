import type { SessionRefView } from '../rpc.js';
import { type Ref, type RefLink, type RefSource, refKey, TRACKED_SOURCES } from './ref.js';

/** Refs drawn on a session row: the main PR, every tracked issue, and how many others exist. */
export interface RowRefs {
  pr?: Ref;
  /** The main PR is the one whose head is the session's branch. */
  branch: boolean;
  issues: Ref[];
  /** Other pull requests and mentions. */
  extra: number;
}

/** Input of {@link isDone}. */
export interface DoneInput {
  running: boolean;
  /** A permission or question is waiting for the user. */
  pending: boolean;
  archived: boolean;
  view: SessionRefView;
  /**
   * Epoch milliseconds of the user's last message. Refs closed before it do not end the session.
   * Null when it is unknown, which only the user's own mark overrides.
   */
  lastUserMessageAt?: number | null | undefined;
}

const EXPLICIT_PR_SOURCES: ReadonlySet<RefSource> = new Set(['agent', 'created', 'manual']);
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
 * The session's main pull request: the branch PR, else the newest PR the agent or user linked,
 * else the newest PR from a prompt.
 */
export function mainPullRequest(view: SessionRefView): { pr?: Ref; branch: boolean } {
  const branchPR = view.branchRefs[0];
  if (branchPR !== undefined) return { pr: branchPR, branch: true };
  const prs = trackedLinks(view).filter((link) => link.ref.kind === 'pr');
  const pr =
    newest(prs.filter((link) => EXPLICIT_PR_SOURCES.has(link.source)))?.ref ?? newest(prs)?.ref;
  return pr === undefined ? { branch: false } : { pr, branch: false };
}

/**
 * Picks what a session row shows: the main PR (see {@link mainPullRequest}) and every tracked
 * issue, the ones the main PR closes first, newest link first within each part. The PR snapshot
 * knows its closing issues before a `closes` link is stored, so those count as tracked too.
 * `extra` counts the other pull requests and the mentions.
 */
export function rowRefs(view: SessionRefView): RowRefs {
  const main = mainPullRequest(view);
  const mainKey = main.pr === undefined ? undefined : refKey(main.pr);
  const closedByMain = new Set(
    (mainKey === undefined ? undefined : view.states[mainKey]?.closes)?.map(refKey)
  );
  const issueLinks = trackedLinks(view)
    .filter((link) => link.ref.kind === 'issue')
    .sort((a, b) => b.linkedAt - a.linkedAt);
  const closesMain = (ref: Ref, via?: string) =>
    (mainKey !== undefined && via === mainKey) || closedByMain.has(refKey(ref));
  const issues = new Map<string, Ref>();
  for (const link of issueLinks.filter((item) => closesMain(item.ref, item.via))) {
    issues.set(refKey(link.ref), link.ref);
  }
  for (const ref of mainKey === undefined ? [] : (view.states[mainKey]?.closes ?? [])) {
    if (!issues.has(refKey(ref))) issues.set(refKey(ref), ref);
  }
  for (const link of issueLinks) {
    if (!issues.has(refKey(link.ref))) issues.set(refKey(link.ref), link.ref);
  }

  const shown = new Set([mainKey, ...issues.keys()]);
  const others = new Set(
    [...view.branchRefs, ...view.links.map((link) => link.ref)]
      .map(refKey)
      .filter((key) => !shown.has(key))
  );
  return {
    ...(main.pr === undefined ? {} : { pr: main.pr }),
    branch: main.branch,
    issues: [...issues.values()],
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
 * treated as not Done so a failed fetch never hides a session. The user's override (`view.done`)
 * wins over the refs, the last message and a pending question, but never over running or
 * archived.
 */
export function isDone(input: DoneInput): boolean {
  const { view } = input;
  if (input.running || input.archived) return false;
  if (view.done !== undefined) return view.done;
  if (input.pending) return false;
  const refs = deciding(view);
  if (refs.length === 0) return false;
  if (!trackedRefs(view).every((ref) => view.states[refKey(ref)] !== undefined)) return false;
  const closed = refs.every((ref) => {
    const status = view.states[refKey(ref)]?.status;
    return status !== undefined && CLOSED_STATUSES.has(status);
  });
  if (!closed) return false;
  if (input.lastUserMessageAt === null) return false;
  if (input.lastUserMessageAt === undefined) return true;
  const latest = latestClose(view, refs);
  return latest !== undefined && latest > input.lastUserMessageAt;
}

/**
 * When the session became Done, for grouping the Done view by day and for auto-archive: when the
 * user marked it, else when its deciding refs last merged or closed.
 */
export function doneAt(view: SessionRefView): number | undefined {
  if (view.done === true && view.doneAt !== undefined) return view.doneAt;
  return latestClose(view, deciding(view));
}
