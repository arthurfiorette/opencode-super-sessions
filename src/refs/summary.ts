import type { SessionRefView } from '../rpc.js';
import {
  type Ref,
  type RefLink,
  type RefSource,
  refKey,
  TRACKED_SOURCES,
  type WorkLink
} from './ref.js';
import { cleanTitle, type LinkInfo, recognizeLink, titleWithoutId } from './work-link.js';

/**
 * Refs drawn on a session row: the first {@link ROW_PRS} pull requests in {@link pullRequests}
 * order, every tracked issue, and how many others exist.
 */
export interface RowRefs {
  prs: Ref[];
  issues: Ref[];
  /** Pull requests past {@link ROW_PRS}, and mentions. */
  extra: number;
}

/** Pull request lines a row draws before the rest count in its `+N`. */
export const ROW_PRS = 3;

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
 * Where a pull request's state puts it: open, draft and not yet fetched first, then merged, then
 * closed. A PR without a snapshot is nearly always one just created or linked, so it sorts with
 * the open ones and keeps its place when its state arrives; a failed fetch never sinks it either.
 */
function stateRank(view: SessionRefView, ref: Ref): number {
  const status = view.states[refKey(ref)]?.status;
  return status === 'merged' ? 1 : status === 'closed' ? 2 : 0;
}

/**
 * The session's tracked pull requests (branch PRs and tracked links, no mentions) in display
 * order: by state (see {@link stateRank}), then the branch's PRs in the server's order, then
 * PRs the agent or user linked or created, then PRs from prompts, newest link first. A PR
 * linked more than once takes its best place.
 */
export function pullRequests(view: SessionRefView): Ref[] {
  const places = new Map<string, { ref: Ref; source: number; at: number }>();
  view.branchRefs.forEach((ref, index) => {
    // Newest first sorts `at` descending, so a negated index keeps the server's order.
    if (!places.has(refKey(ref))) places.set(refKey(ref), { ref, source: 0, at: -index });
  });
  for (const link of trackedLinks(view)) {
    if (link.ref.kind !== 'pr') continue;
    const key = refKey(link.ref);
    const source = EXPLICIT_PR_SOURCES.has(link.source) ? 1 : 2;
    const place = places.get(key);
    if (place && (place.source < source || (place.source === source && place.at >= link.linkedAt)))
      continue;
    places.set(key, { ref: link.ref, source, at: link.linkedAt });
  }
  const sorted = [...places.values()]
    .sort(
      (a, b) =>
        stateRank(view, a.ref) - stateRank(view, b.ref) || a.source - b.source || b.at - a.at
    )
    .map((place) => place.ref);
  return stacked(view, sorted);
}

/**
 * Keeps the pull requests of one GitHub stack together, bottom of the stack first, at the place
 * of the first of them, so the rows read in the stack's order whatever their states.
 */
function stacked(view: SessionRefView, prs: Ref[]): Ref[] {
  const stackKey = (ref: Ref) => {
    const stack = view.states[refKey(ref)]?.stack;
    return stack === undefined
      ? undefined
      : `${ref.host}/${ref.repo}#${stack.number}`.toLowerCase();
  };
  const position = (ref: Ref) => view.states[refKey(ref)]?.stack?.position ?? 0;
  const placed = new Set<string>();
  return prs.flatMap((ref) => {
    const key = stackKey(ref);
    if (key === undefined) return [ref];
    if (placed.has(key)) return [];
    placed.add(key);
    return prs.filter((other) => stackKey(other) === key).sort((a, b) => position(a) - position(b));
  });
}

/**
 * Picks what a session row shows: the first {@link ROW_PRS} of {@link pullRequests} and every
 * tracked issue, the ones a shown PR closes first, newest link first within each part. Only
 * stored links count: the server stores a `closes` link for each issue in the PR's snapshot
 * before it answers, so an issue the snapshot lists without a link is one the user unlinked.
 * `extra` counts the other pull requests and the mentions.
 */
export function rowRefs(view: SessionRefView): RowRefs {
  const prs = pullRequests(view).slice(0, ROW_PRS);
  const prKeys = new Set(prs.map(refKey));
  const closedByShown = new Set(
    prs.flatMap((pr) => view.states[refKey(pr)]?.closes ?? []).map(refKey)
  );
  const issueLinks = trackedLinks(view)
    .filter((link) => link.ref.kind === 'issue')
    .sort((a, b) => b.linkedAt - a.linkedAt);
  const closesShown = (link: RefLink) =>
    (link.via !== undefined && prKeys.has(link.via)) || closedByShown.has(refKey(link.ref));
  const issues = new Map<string, Ref>();
  for (const link of issueLinks.filter(closesShown)) issues.set(refKey(link.ref), link.ref);
  for (const link of issueLinks) {
    if (!issues.has(refKey(link.ref))) issues.set(refKey(link.ref), link.ref);
  }

  const shown = new Set([...prKeys, ...issues.keys()]);
  const others = new Set(
    [...view.branchRefs, ...view.links.map((link) => link.ref)]
      .map(refKey)
      .filter((key) => !shown.has(key))
  );
  return { prs, issues: [...issues.values()], extra: others.size };
}

/** Refs listed in the session sidebar, in display order, and how many mentions were left out. */
export interface SidebarRefs {
  refs: Ref[];
  mentioned: number;
}

/**
 * Orders a session's tracked refs for the sidebar: pull requests in {@link pullRequests} order,
 * then issues, newest link first. Mentions are only counted.
 */
export function sidebarRefs(view: SessionRefView): SidebarRefs {
  const issues = trackedLinks(view)
    .filter((link) => link.ref.kind === 'issue')
    .sort((a, b) => b.linkedAt - a.linkedAt);
  const refs = new Map<string, Ref>();
  // An issue linked twice keeps its newest place.
  for (const ref of [...pullRequests(view), ...issues.map((link) => link.ref)]) {
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

/** A work link as rows draw it: what its URL says, with the stored title over the URL's. */
export interface ShownLink extends LinkInfo {
  source: WorkLink['source'];
  linkedAt: number;
}

/**
 * The session's work links, newest link first. Links whose URL no longer parses are left out.
 * They never decide Done: nothing reports their state.
 */
export function workLinks(view: SessionRefView): ShownLink[] {
  return (view.urls ?? [])
    .flatMap((link): ShownLink[] => {
      const info = recognizeLink(link.url);
      if (info === undefined) return [];
      return [
        {
          ...info,
          ...(link.title === undefined
            ? {}
            : { title: titleWithoutId(cleanTitle(link.title), info.name) }),
          source: link.source,
          linkedAt: link.linkedAt
        }
      ];
    })
    .sort((a, b) => b.linkedAt - a.linkedAt);
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
