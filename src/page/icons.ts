import type { ResolvedTheme } from '@opencode/theme/tui';
import { RGBA } from '@opentui/core';
import { type Options, stateColor } from '../config.js';
import type { RefKind, RefStatus } from '../refs/ref.js';

/**
 * Nerd Font octicons. Every glyph is drawn in a 2-cell slot (glyph and a space) so fonts that draw
 * them wide or narrow never move the text after them.
 */
export const ICONS = {
  prOpen: '\uf407',
  prDraft: '\uf4dd',
  prMerged: '\uf419',
  prClosed: '\uf4dc',
  issueOpen: '\uf41b',
  issueCompleted: '\uf41d',
  issueNotPlanned: '\uf517',
  done: '\uf49e',
  archived: '\uf411',
  // Review and CI, in GitHub's glyphs: file_diff, check_circle_fill, eye, check, x, dot_fill,
  // alert and comment. Approval takes the filled circle so it never reads like a passing CI tick
  // beside it.
  changesRequested: '\uf4d2',
  approved: '\uf4a4',
  reviewRequired: '\uf441',
  checksPassing: '\uf42e',
  checksFailing: '\uf467',
  checksPending: '\uf444',
  conflicts: '\uf421',
  threads: '\uf41f'
} as const;

/** A word per ref state, for the sidebar's summary counts. */
export const STATE_WORDS: Record<RefStatus, string> = {
  open: 'open',
  draft: 'draft',
  merged: 'merged',
  closed: 'closed',
  completed: 'completed',
  not_planned: 'not planned'
};

/** Glyph for a ref. Unknown state (no snapshot yet) uses the open glyph. */
export function refIcon(kind: RefKind, status: RefStatus | undefined): string {
  if (kind === 'pr') {
    if (status === 'draft') return ICONS.prDraft;
    if (status === 'merged') return ICONS.prMerged;
    if (status === 'closed') return ICONS.prClosed;
    return ICONS.prOpen;
  }
  if (status === 'completed' || status === 'closed') return ICONS.issueCompleted;
  if (status === 'not_planned') return ICONS.issueNotPlanned;
  return ICONS.issueOpen;
}

// The theme has no orange or yellow token (`SemanticHue` is accent, interactive and neutral), so
// the title fade ends on the gruvbox orange and falls back to the gruvbox yellow, which read on
// both kinds of background.
const TITLE_ORANGE = { dark: '#fe8019', light: '#af3a03' } as const;
const TITLE_YELLOW = { dark: '#fabd2f', light: '#b57614' } as const;
// Below this RGB distance (channels in 0..1) the two ends look like one color.
const MIN_FADE = 0.2;

/**
 * One color per character of `text`, fading left to right from the theme's warning color to
 * orange, interpolated in RGB. Themes whose warning color is already orange, gruvbox among them,
 * start from yellow instead, or the fade would be flat. A single character takes the first end.
 */
export function titleGradient(text: string, theme: ResolvedTheme, mode: 'dark' | 'light'): RGBA[] {
  const to = RGBA.fromHex(TITLE_ORANGE[mode]);
  const warning = theme.text.feedback.warning.base;
  const distance = Math.hypot(warning.r - to.r, warning.g - to.g, warning.b - to.b);
  const from = distance < MIN_FADE ? RGBA.fromHex(TITLE_YELLOW[mode]) : warning;
  const count = Array.from(text).length;
  return Array.from({ length: count }, (_, index) => {
    const t = count > 1 ? index / (count - 1) : 0;
    const mix = (a: number, b: number) => a + (b - a) * t;
    return RGBA.fromValues(mix(from.r, to.r), mix(from.g, to.g), mix(from.b, to.b), 1);
  });
}

/** Color of a ref's glyph and number. Unknown state is muted so it never reads as open. */
export function refColor(
  options: Options,
  status: RefStatus | undefined,
  theme: ResolvedTheme,
  mode: 'dark' | 'light'
): string | RGBA {
  return status === undefined ? theme.text.muted : stateColor(options, status, mode);
}
