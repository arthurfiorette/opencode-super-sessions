import type { ResolvedTheme } from '@opencode/theme/tui';
import type { RGBA } from '@opentui/core';
import { type CheckTally, checkMark, type Tone } from '../refs/look.js';
import type { PullCheck } from '../refs/ref.js';
import { ICONS } from './icons.js';
import type { Segment } from './row.js';

export {
  type CheckTally,
  hasListedChecks,
  listedChecks,
  tallyChecks,
  tallyOf
} from '../refs/look.js';

/** The theme color of a {@link Tone}. */
export function toneColor(tone: Tone, theme: ResolvedTheme): RGBA {
  const { feedback, muted } = theme.text;
  if (tone === 'success') return feedback.success.base;
  if (tone === 'error') return feedback.error.base;
  if (tone === 'warning') return feedback.warning.base;
  return muted;
}

/** A check's glyph and color, in GitHub's colors; cancelled and skipped read muted. */
export function checkLook(
  status: PullCheck['status'],
  theme: ResolvedTheme
): [string, string | RGBA] {
  const mark = checkMark(status);
  return [ICONS[mark.icon], toneColor(mark.tone, theme)];
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
