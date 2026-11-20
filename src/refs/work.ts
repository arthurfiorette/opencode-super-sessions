import type { SessionRefView } from '../rpc.js';
import { refUrl } from './look.js';
import { type Ref, type RefReview, type RefState, refKey } from './ref.js';
import { pullRequests, type ShownLink, trackedRefs, workLinks } from './summary.js';

// The lines of a session's Work section, decided once for the TUI's preview (`src/page/preview-
// header.ts`) and the Desktop GUI's Work list (`src/gui/status/work-list.tsx`). No UI or Node.js
// import, so the GUI bundle can load it.

/** The review of an open or draft pull request, or undefined for any other ref. */
export function openReview(state: RefState | undefined): RefReview | undefined {
  return state?.status === 'open' || state?.status === 'draft' ? state.review : undefined;
}

/**
 * Whether the lines under an open pull request have something to show: a review verdict, a CI
 * result, merge conflicts or unresolved threads for the icon line, which failing checks always
 * come with.
 */
export function hasWorkStatus(state: RefState | undefined): boolean {
  const review = openReview(state);
  if (review === undefined) return false;
  return (
    review.decision !== undefined ||
    review.checks !== undefined ||
    review.conflicts === true ||
    (review.unresolved ?? 0) > 0
  );
}

/** The page of a pull request that lists all its checks: `/checks` on GitHub, pipelines on GitLab. */
export function checksPage(ref: Ref, state: RefState | undefined): string {
  return `${refUrl(ref, state)}/${ref.provider === 'gitlab' ? 'pipelines' : 'checks'}`;
}

/**
 * One line of a Work section: a ref row, the status lines under an open pull request (see
 * {@link hasWorkStatus}), or the label over mentioned refs.
 */
export type WorkLine =
  | { kind: 'label'; text: string }
  | { kind: 'ref'; ref: Ref }
  | { kind: 'status'; ref: Ref }
  | { kind: 'link'; link: ShownLink };

/**
 * Tracked refs: pull requests in the rows' order (see `pullRequests`), so an open one is always
 * above the merged and closed ones, each followed by its status line when it has one and the
 * issues it closes right under it, in the same columns; then the other tracked issues, then work
 * links, newest first, then mentioned refs under a label. Each ref and link appears once, so its
 * key names its row.
 */
export function workLines(view: SessionRefView): WorkLine[] {
  const tracked = trackedRefs(view);
  const trackedKeys = new Set(tracked.map(refKey));
  const nestedKeys = new Set<string>();
  // The PR's snapshot still lists an issue the user unlinked; its stored link is what is gone.
  const linkedKeys = new Set(view.links.map((link) => refKey(link.ref)));
  const lines: WorkLine[] = [];
  for (const pr of pullRequests(view)) {
    const key = refKey(pr);
    lines.push({ kind: 'ref', ref: pr });
    if (hasWorkStatus(view.states[key])) lines.push({ kind: 'status', ref: pr });
    const closes = new Map<string, Ref>();
    for (const ref of view.states[key]?.closes ?? []) {
      if (linkedKeys.has(refKey(ref))) closes.set(refKey(ref), ref);
    }
    for (const link of view.links) {
      if (link.source === 'closes' && link.via === key) closes.set(refKey(link.ref), link.ref);
    }
    for (const [issueKey, ref] of closes) {
      if (nestedKeys.has(issueKey)) continue;
      nestedKeys.add(issueKey);
      lines.push({ kind: 'ref', ref });
    }
  }
  for (const ref of tracked) {
    if (ref.kind === 'issue' && !nestedKeys.has(refKey(ref))) lines.push({ kind: 'ref', ref });
  }
  for (const link of workLinks(view)) lines.push({ kind: 'link', link });
  const mentioned = view.links.filter(
    (link) =>
      link.source === 'mention' &&
      !trackedKeys.has(refKey(link.ref)) &&
      !nestedKeys.has(refKey(link.ref))
  );
  if (mentioned.length > 0) {
    lines.push({ kind: 'label', text: 'mentioned' });
    for (const link of mentioned) lines.push({ kind: 'ref', ref: link.ref });
  }
  return lines;
}
