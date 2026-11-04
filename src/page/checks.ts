import type { ResolvedTheme } from '@opencode/theme/tui';
import type { RGBA } from '@opentui/core';
import type { PullCheck, RefReview } from '../refs/ref.js';
import { ICONS } from './icons.js';
import type { Segment } from './row.js';

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

/** A check's glyph and color, in GitHub's colors; cancelled and skipped read muted. */
export function checkLook(
  status: PullCheck['status'],
  theme: ResolvedTheme
): [string, string | RGBA] {
  const { feedback, muted } = theme.text;
  if (status === 'success') return [ICONS.checksPassing, feedback.success.base];
  if (status === 'failure') return [ICONS.checksFailing, feedback.error.base];
  if (status === 'action_required') return [ICONS.actionRequired, feedback.warning.base];
  if (status === 'cancelled') return [ICONS.checksCancelled, muted];
  if (status === 'pending') return [ICONS.checksPending, feedback.warning.base];
  if (status === 'skipped') return [ICONS.checksSkipped, muted];
  return [ICONS.checksPending, muted];
}

/** The CI icon for a combined result: the muted stop when the only trouble was cancelled runs. */
export function ciLook(
  checks: NonNullable<RefReview['checks']>,
  theme: ResolvedTheme
): [string, string | RGBA] {
  if (checks === 'passing') return checkLook('success', theme);
  if (checks === 'failing') return checkLook('failure', theme);
  if (checks === 'cancelled') return checkLook('cancelled', theme);
  return checkLook('pending', theme);
}

/**
 * The summary line of the Pull requests preview's checks: passed, skipped, cancelled, pending
 * and failed counts with their icons, leaving out zeros. When nothing failed, waits or was
 * cancelled, only the green icon with the count of every check.
 */
export function tallySegments(tally: CheckTally, theme: ResolvedTheme): Segment[] {
  const part = (status: PullCheck['status'], count: number): Segment[] => {
    if (count === 0) return [];
    const [glyph, fg] = checkLook(status, theme);
    return [{ text: `${glyph} ${count}`, fg }];
  };
  const clean = tally.failed === 0 && tally.pending === 0 && tally.cancelled === 0;
  const parts = clean
    ? part('success', tally.passed + tally.skipped)
    : [
        ...part('success', tally.passed),
        ...part('skipped', tally.skipped),
        ...part('cancelled', tally.cancelled),
        ...part('pending', tally.pending),
        ...part('failure', tally.failed)
      ];
  return parts.flatMap((segment, index) =>
    index === 0 ? [segment] : [{ text: '  ', fg: theme.text.muted }, segment]
  );
}
