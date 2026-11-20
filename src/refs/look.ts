import type { PullCheck, Ref, RefKind, RefReview, RefState, RefStatus } from './ref.js';

// How a ref looks, decided once for every surface: the TUI draws these decisions with Nerd Font
// glyphs and theme colors (`src/page/icons.ts`, `src/page/checks.ts`, `src/page/row.ts`), and the
// Desktop GUI with octicons and CSS (`src/gui/ref-view.tsx`). No UI or Node.js import, so the GUI
// bundle can load it.

/** A glyph a ref, its review or its checks draw, named after what it stands for. */
export type LookIcon =
  | 'prOpen'
  | 'prDraft'
  | 'prMerged'
  | 'prClosed'
  | 'issueOpen'
  | 'issueCompleted'
  | 'issueNotPlanned'
  | 'changesRequested'
  | 'approved'
  | 'reviewRequired'
  | 'checksPassing'
  | 'checksFailing'
  | 'checksPending'
  | 'checksCancelled'
  | 'checksSkipped'
  | 'actionRequired'
  | 'conflicts'
  | 'threads'
  | 'stack';

/** A color role: each surface maps it to its own success, error, warning and muted colors. */
export type Tone = 'success' | 'error' | 'warning' | 'muted';

/** Glyph for a ref. Unknown state (no snapshot yet) uses the open glyph. */
export function refGlyph(kind: RefKind, status: RefStatus | undefined): LookIcon {
  if (kind === 'pr') {
    if (status === 'draft') return 'prDraft';
    if (status === 'merged') return 'prMerged';
    if (status === 'closed') return 'prClosed';
    return 'prOpen';
  }
  if (status === 'completed' || status === 'closed') return 'issueCompleted';
  if (status === 'not_planned') return 'issueNotPlanned';
  return 'issueOpen';
}

/** GitHub Primer foreground colors for each state, so refs read like GitHub in either mode. */
export const GITHUB_COLORS: Record<RefStatus, { dark: string; light: string }> = {
  open: { dark: '#3fb950', light: '#1a7f37' },
  draft: { dark: '#9198a1', light: '#59636e' },
  merged: { dark: '#ab7df8', light: '#8250df' },
  closed: { dark: '#f85149', light: '#d1242f' },
  completed: { dark: '#ab7df8', light: '#8250df' },
  not_planned: { dark: '#9198a1', light: '#59636e' }
};

/**
 * Web page of a ref. The snapshot's URL wins; before the first snapshot arrives the URL is built
 * from the ref with GitHub's path layout.
 */
export function refUrl(ref: Ref, state: RefState | undefined): string {
  return (
    state?.url ??
    `https://${ref.host}/${ref.repo}/${ref.kind === 'pr' ? 'pull' : 'issues'}/${ref.number}`
  );
}

/**
 * A pull request's CI counts as `passed/total`, or undefined when they are unknown or every check
 * passed: the green check alone says that, and `160/160` only took room from the title.
 */
export function checkCounts(review: RefReview | undefined): string | undefined {
  const passed = review?.checksPassed;
  const total = review?.checksTotal;
  if (passed === undefined || total === undefined || passed === total) return undefined;
  return `${passed}/${total}`;
}

/**
 * A pull request's checks by outcome. `passed` is successful and neutral checks; `skipped` also
 * counts toward the `passed/total` drawn on rows. `failed` takes failures, timeouts, startup
 * failures and checks that wait for an action: the ones listed by name. Cancelled checks are
 * counted, never listed.
 */
export interface CheckTally {
  passed: number;
  skipped: number;
  cancelled: number;
  pending: number;
  failed: number;
}

/**
 * The snapshot's tally, or undefined when the forge gave only `passed/total` (GitLab), so the
 * same numbers reach the rows and the Pull requests preview.
 */
export function tallyOf(review: RefReview | undefined): CheckTally | undefined {
  if (review?.checksPassed === undefined || review.checksSkipped === undefined) return undefined;
  return {
    passed: review.checksPassed - review.checksSkipped,
    skipped: review.checksSkipped,
    cancelled: review.checksCancelled ?? 0,
    pending: review.checksPending ?? 0,
    failed: review.checksFailed ?? 0
  };
}

/** Tallies a details check list by the same rules as {@link tallyOf}. */
export function tallyChecks(checks: readonly PullCheck[]): CheckTally {
  const tally: CheckTally = { passed: 0, skipped: 0, cancelled: 0, pending: 0, failed: 0 };
  for (const check of checks) {
    if (check.status === 'success' || check.status === 'neutral') tally.passed++;
    else if (check.status === 'skipped') tally.skipped++;
    else if (check.status === 'cancelled') tally.cancelled++;
    else if (check.status === 'pending') tally.pending++;
    else tally.failed++;
  }
  return tally;
}

/**
 * The checks listed by name under a pull request: failures first, then checks that wait for an
 * action, each in the forge's order. Cancelled, pending, skipped and passed checks are not listed.
 */
export function listedChecks(checks: readonly PullCheck[] | undefined): PullCheck[] {
  const all = checks ?? [];
  return [
    ...all.filter((check) => check.status === 'failure'),
    ...all.filter((check) => check.status === 'action_required')
  ];
}

/**
 * Whether a pull request has checks to list by name, so its details are worth fetching. GitLab
 * gives no tally in the snapshot, so a failing pipeline stands for it there.
 */
export function hasListedChecks(review: RefReview | undefined): boolean {
  const tally = tallyOf(review);
  return tally === undefined ? review?.checks === 'failing' : tally.failed > 0;
}

/** A glyph in a tone. */
export interface Mark {
  icon: LookIcon;
  tone: Tone;
}

/** A check's glyph and tone, in GitHub's colors; cancelled and skipped read muted. */
export function checkMark(status: PullCheck['status']): Mark {
  if (status === 'success') return { icon: 'checksPassing', tone: 'success' };
  if (status === 'failure') return { icon: 'checksFailing', tone: 'error' };
  if (status === 'action_required') return { icon: 'actionRequired', tone: 'warning' };
  if (status === 'cancelled') return { icon: 'checksCancelled', tone: 'muted' };
  if (status === 'pending') return { icon: 'checksPending', tone: 'warning' };
  if (status === 'skipped') return { icon: 'checksSkipped', tone: 'muted' };
  return { icon: 'checksPending', tone: 'muted' };
}

/** The CI glyph for a combined result: the muted stop when the only trouble was cancelled runs. */
export function ciMark(checks: NonNullable<RefReview['checks']>): Mark {
  if (checks === 'passing') return checkMark('success');
  if (checks === 'failing') return checkMark('failure');
  if (checks === 'cancelled') return checkMark('cancelled');
  return checkMark('pending');
}

/**
 * One review or CI indicator after an open pull request's number. `text` follows the glyph, or
 * stands alone for `counts`.
 * - `review`: the review verdict.
 * - `ci`: the combined CI result.
 * - `counts`: `passed/total`, muted, when not every check passed.
 * - `conflicts`: the branch conflicts with its base.
 * - `threads`: unresolved review threads, with their count.
 */
export interface Badge {
  kind: 'review' | 'ci' | 'counts' | 'conflicts' | 'threads';
  icon?: LookIcon;
  text?: string;
  tone: Tone;
}

/**
 * The review and CI indicators of a pull request, in drawing order: the review verdict, the CI
 * result with `passed/total` unless every check passed (see {@link checkCounts}) or `counts` is
 * false, merge conflicts, then the unresolved threads. A part without data is left out, and so
 * is the CI result when `ci` is false.
 */
export function reviewBadges(review: RefReview | undefined, counts = true, ci = true): Badge[] {
  if (review === undefined) return [];
  const badges: Badge[] = [];
  if (review.decision === 'changes_requested') {
    badges.push({ kind: 'review', icon: 'changesRequested', tone: 'error' });
  } else if (review.decision === 'approved') {
    badges.push({ kind: 'review', icon: 'approved', tone: 'success' });
  } else if (review.decision === 'review_required') {
    badges.push({ kind: 'review', icon: 'reviewRequired', tone: 'muted' });
  }
  if (ci && review.checks !== undefined) {
    badges.push({ kind: 'ci', ...ciMark(review.checks) });
    const text = counts ? checkCounts(review) : undefined;
    if (text !== undefined) badges.push({ kind: 'counts', text, tone: 'muted' });
  }
  if (review.conflicts === true) {
    badges.push({ kind: 'conflicts', icon: 'conflicts', tone: 'error' });
  }
  if (review.unresolved !== undefined && review.unresolved > 0) {
    badges.push({
      kind: 'threads',
      icon: 'threads',
      text: `${review.unresolved}`,
      tone: 'warning'
    });
  }
  return badges;
}

/** {@link reviewBadges} for a ref's state, or none unless it is an open or draft pull request. */
export function openBadges(state: RefState | undefined, counts = true): Badge[] {
  const open = state?.status === 'open' || state?.status === 'draft';
  return open ? reviewBadges(state.review, counts) : [];
}
