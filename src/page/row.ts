import type { ResolvedTheme } from '@opencode/theme/tui';
import { MouseButton, type MouseEvent, type RGBA } from '@opentui/core';
import { jsx } from '@opentui/solid/jsx-runtime';
import type { JSX } from 'solid-js';
import type { Options } from '../config.js';
import { type Ref, type RefReview, type RefState, refKey, refNumber } from '../refs/ref.js';
import { rowRefs } from '../refs/summary.js';
import type { SessionRefView } from '../rpc.js';
import { ICONS, refColor, refIcon } from './icons.js';

/** A run of text in one color on a row line. */
export interface Segment {
  text: string;
  fg: string | RGBA;
  bold?: boolean;
}

/** Everything a session row draws. Built by the view for each visible row. */
export interface RowModel {
  /** Pin slot, attention, spinner, unread dot, or a muted `-`; drawn on the title line only. */
  marker: Segment;
  /** The title word-wrapped at the title column (see {@link wrapTitle}), one entry per line. */
  title: string[];
  /** Muted note before the age, such as why a search matched. Empty for none. */
  label: string;
  /** Age, or archive and update ages in the Archived view, right-aligned on the title line. */
  right: string;
  /** Cells inside the row's padding, measured from the list. */
  width: number;
  /** Lines under the title, from {@link rowDetails}. */
  details: RowDetails;
  selected: boolean;
  /** The session runs: the title takes the spinner's color, unless the row is selected. */
  running: boolean;
  /** The first delete press turned this row into a confirmation. */
  deleting: boolean;
  /** The pointer is over one of the row's lines; a faint tint, below the selection's colors. */
  hovered: boolean;
}

/** Input of {@link refSegments}. */
export interface RefsInput {
  options: Options;
  theme: ResolvedTheme;
  mode: 'dark' | 'light';
  refs: SessionRefView | undefined;
  /** `refKey` of the ref a search matched, drawn with its title in the base text color. */
  matched?: string | undefined;
}

/** Short relative age: `now`, `5m`, `3h`, `2d`, `4mo`, `1y`. */
export function formatAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** Cost in dollars, or nothing for sessions that cost less than a cent. */
export function formatCost(cost: number): string {
  return cost >= 0.005 ? `$${cost.toFixed(2)}` : '';
}

/** Every ref of a view, branch pull requests first, by key. */
function refsByKey(view: SessionRefView): Map<string, Ref> {
  const refs = new Map<string, Ref>();
  for (const ref of [...view.branchRefs, ...view.links.map((link) => link.ref)]) {
    if (!refs.has(refKey(ref))) refs.set(refKey(ref), ref);
  }
  return refs;
}

/** The ref a key names among a session's refs. */
export function findRef(view: SessionRefView | undefined, key: string): Ref | undefined {
  return view === undefined ? undefined : refsByKey(view).get(key);
}

/**
 * Lines a row draws under its title. Each part is empty when its line is not drawn.
 *
 * - `pr`: the main PR's icon and number, its review and CI icons, its title, then a matched ref
 *   that is shown nowhere else, and `+N`.
 * - `issues`: one piece per tracked issue (with its title when it is the only one), fitted to
 *   the width when drawn; `extra` is the `+N`
 *   the issues line carries when there is no PR line.
 */
export interface RowDetails {
  pr: Segment[];
  issues: Segment[][];
  extra: number;
}

/** Details of a session without refs. */
export const NO_DETAILS: RowDetails = { pr: [], issues: [], extra: 0 };

/** The detail lines a row has, in order, for laying out the list. */
export function detailKinds(details: RowDetails): Array<'pr' | 'issues'> {
  return [
    ...(details.pr.length > 0 ? (['pr'] as const) : []),
    ...(details.issues.length > 0 ? (['issues'] as const) : [])
  ];
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
 * The review and CI icons drawn after an open pull request's number, in GitHub's colors: the
 * review verdict, the CI result with `passed/total` muted unless every check passed (see
 * {@link checkCounts}), then the unresolved threads in the
 * warning color. A part without data is left out. Each part starts with its separating space, so
 * the number and the state icon stay in the same column on every row, and each glyph keeps a
 * 2-cell slot like the ref icons because a space always follows it (the next part's or the
 * title's).
 */
export function badgeSegments(review: RefReview | undefined, theme: ResolvedTheme): Segment[] {
  if (review === undefined) return [];
  const { feedback, muted } = theme.text;
  const parts: Segment[] = [];
  if (review.decision === 'changes_requested') {
    parts.push({ text: ` ${ICONS.changesRequested}`, fg: feedback.error.base });
  } else if (review.decision === 'approved') {
    parts.push({ text: ` ${ICONS.approved}`, fg: feedback.success.base });
  } else if (review.decision === 'review_required') {
    parts.push({ text: ` ${ICONS.reviewRequired}`, fg: muted });
  }
  if (review.checks !== undefined) {
    const [glyph, fg] =
      review.checks === 'passing'
        ? [ICONS.checksPassing, feedback.success.base]
        : review.checks === 'failing'
          ? [ICONS.checksFailing, feedback.error.base]
          : [ICONS.checksPending, feedback.warning.base];
    parts.push({ text: ` ${glyph}`, fg });
    const counts = checkCounts(review);
    if (counts !== undefined) parts.push({ text: ` ${counts}`, fg: muted });
  }
  if (review.unresolved !== undefined && review.unresolved > 0) {
    parts.push({ text: ` ${ICONS.threads} ${review.unresolved}`, fg: feedback.warning.base });
  }
  return parts;
}

/** {@link badgeSegments} for a ref's state, or none unless it is an open or draft pull request. */
export function stateBadges(state: RefState | undefined, theme: ResolvedTheme): Segment[] {
  const open = state?.status === 'open' || state?.status === 'draft';
  return open ? badgeSegments(state.review, theme) : [];
}

/**
 * Builds a row's detail lines. Icon and number take the state color, since a colored icon beside
 * a plain number read as two things; titles are muted, except a ref a search matched.
 */
export function rowDetails(input: RefsInput): RowDetails {
  const view = input.refs;
  if (view === undefined) return NO_DETAILS;
  const { base, muted } = input.theme.text;
  const summary = rowRefs(view);
  /** Icon and number of `ref`, its review and CI icons when `badged`, its title when `titled`. */
  const piece = (ref: Ref, titled: boolean, badged = false): Segment[] => {
    const key = refKey(ref);
    const state = view.states[key];
    const color = refColor(input.options, state?.status, input.theme, input.mode);
    const segments: Segment[] = [
      { text: `${refIcon(ref.kind, state?.status)} `, fg: color },
      { text: refNumber(ref), fg: color },
      ...(badged ? stateBadges(state, input.theme) : [])
    ];
    if (titled && state?.title) {
      segments.push({ text: ` ${state.title}`, fg: key === input.matched ? base : muted });
    }
    return segments;
  };

  const shownKeys = new Set(
    [summary.pr, ...summary.issues].flatMap((ref) => (ref ? [refKey(ref)] : []))
  );
  const matched = input.matched === undefined ? undefined : findRef(view, input.matched);
  // A hit on a ref the row does not show (another PR, a mention) joins the line of its kind.
  const extraHit = matched && !shownKeys.has(refKey(matched)) ? matched : undefined;
  const extra = Math.max(0, summary.extra - (extraHit ? 1 : 0));
  const prs = [summary.pr, extraHit?.kind === 'pr' ? extraHit : undefined].filter(
    (ref): ref is Ref => ref !== undefined
  );
  const issues = [...summary.issues, ...(extraHit?.kind === 'issue' ? [extraHit] : [])];

  const pr = prs.flatMap((ref, index) => [
    ...(index > 0 ? [{ text: '  ', fg: muted }] : []),
    ...piece(ref, ref === summary.pr || ref === extraHit, ref === summary.pr)
  ]);
  if (pr.length > 0 && extra > 0) pr.push({ text: `  +${extra}`, fg: muted });
  return {
    pr,
    // A lone issue has the room for its title, like the PR line; several read as a number list.
    issues: issues.map((ref) => piece(ref, issues.length === 1)),
    extra: pr.length > 0 ? 0 : extra
  };
}

/**
 * Joins issue pieces as `#1, #2 and #3`. When they do not fit `width`, as many as fit are joined
 * with commas and the rest counted in `+N`, which `extra` adds to.
 */
export function issueSegments(
  pieces: readonly Segment[][],
  extra: number,
  width: number,
  muted: string | RGBA
): Segment[] {
  const size = (segments: readonly Segment[]) =>
    segments.reduce((sum, segment) => sum + cells(segment.text), 0);
  /** The first `count` pieces joined, with the `+N` for the rest. */
  const join = (count: number): Segment[] => {
    const hidden = pieces.length - count + extra;
    const shown = pieces.slice(0, count);
    const out = shown.flatMap((piece, index) => {
      if (index === 0) return piece;
      const last = index === shown.length - 1 && count === pieces.length;
      return [{ text: last ? ' and ' : ', ', fg: muted }, ...piece];
    });
    if (hidden > 0) out.push({ text: `${count > 0 ? ' ' : ''}+${hidden}`, fg: muted });
    return out;
  };
  for (let count = pieces.length; count > 0; count--) {
    const line = join(count);
    if (size(line) <= width) return line;
  }
  return join(pieces.length > 0 ? 1 : 0);
}

/** Pointer handlers shared by every line of a row. */
export interface RowEvents {
  /** The pointer entered one of the row's lines. */
  hover(): void;
  /** The pointer left one of the row's lines. */
  leave(): void;
  /** A left click without ctrl: the view selects the row, or opens it on a double click. */
  click(): void;
  /** A ctrl+click on a row that stands for a link, such as a pull request, copies its URL. */
  copy?(): void;
}

/**
 * Color of a running session's spinner and title. The warning feedback token, which reads as
 * yellow in gruvbox, because the muted text the spinner used before did not stand out.
 */
export function runningColor(theme: ResolvedTheme): RGBA {
  return theme.text.feedback.warning.base;
}

/** What a row's colors depend on. */
type RowLook = Pick<RowModel, 'deleting' | 'selected' | 'hovered'>;

/** Everything a row of the Pull requests view draws. */
export interface PullRowModel extends RowLook {
  /** The state icon and number in the state color, then the review and CI icons. */
  lead: Segment[];
  title: string;
  /** Muted note at the right end, such as `3 sessions`. */
  right: string;
  /** Cells inside the row's padding. */
  width: number;
}

/** A pull request's state icon and number in the state color, then its review and CI icons. */
export function pullLead(
  ref: Ref,
  state: RefState | undefined,
  look: { options: Options; theme: ResolvedTheme; mode: 'dark' | 'light' }
): Segment[] {
  const color = refColor(look.options, state?.status, look.theme, look.mode);
  return [
    { text: `${refIcon(ref.kind, state?.status)} `, fg: color },
    { text: refNumber(ref), fg: color },
    ...stateBadges(state, look.theme)
  ];
}

/**
 * The one line of a Pull requests view row: the icons and number, the title cut to the room left,
 * and the session count at the right end.
 */
export function pullLine(
  theme: () => ResolvedTheme,
  model: () => PullRowModel,
  events: RowEvents
): JSX.Element {
  const fg = (fallback: string | RGBA) => rowColors(theme(), model()).fg ?? fallback;
  const lead = () => model().lead.reduce((sum, segment) => sum + cells(segment.text), 0);
  return lineBox(theme, model, events, [
    // The same muted mark as a session row without a marker, so the icons line up with titles.
    jsx('box', {
      width: MARKER_WIDTH,
      flexShrink: 0,
      children: jsx('text', {
        wrapMode: 'none',
        get fg() {
          return fg(theme().text.muted);
        },
        children: '-'
      })
    }),
    jsx('text', {
      flexShrink: 0,
      wrapMode: 'none',
      get children() {
        return model().lead.map((segment) =>
          jsx('span', {
            style: { fg: fg(segment.fg), bold: model().selected },
            children: segment.text
          })
        );
      }
    }),
    jsx('text', {
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      wrapMode: 'none',
      get children() {
        const current = model();
        const room = current.width - MARKER_WIDTH - lead() - 1 - RIGHT_GAP - cells(current.right);
        return jsx('span', {
          style: { fg: fg(theme().text.base), bold: current.selected },
          children: ` ${fitText(current.title, room)}`
        });
      }
    }),
    jsx('text', {
      flexShrink: 0,
      wrapMode: 'none',
      get fg() {
        return fg(theme().text.muted);
      },
      get children() {
        return `${' '.repeat(RIGHT_GAP)}${model().right}`;
      }
    })
  ]);
}

/**
 * Background and foreground of a row for its delete, selection and hover state, in that order of
 * precedence. Hover only tints the background, so it never reads as the selection.
 */
function rowColors(theme: ResolvedTheme, model: RowLook) {
  if (model.deleting) {
    return {
      bg: theme.background.action.destructive.focused,
      fg: theme.text.action.destructive.focused
    };
  }
  if (model.selected) {
    return { bg: theme.background.action.primary.focused, fg: theme.text.action.primary.focused };
  }
  return { bg: model.hovered ? hoverBackground(theme) : undefined, fg: undefined };
}

/**
 * The hover tint: the theme's hovered action background. `raised.base` equals the panel on the
 * dialog surface, so it would show nothing; when the hovered token does too, `raised.high`
 * stands in.
 */
function hoverBackground(theme: ResolvedTheme): RGBA {
  const hovered = theme.background.action.primary.hovered;
  return hovered.equals(theme.background.base) ? theme.background.raised.high : hovered;
}

/** A row line's outer box: height, padding, colors and pointer handlers. */
function lineBox(
  theme: () => ResolvedTheme,
  model: () => RowLook,
  events: RowEvents,
  children: JSX.Element
) {
  return jsx('box', {
    flexDirection: 'row',
    height: 1,
    flexShrink: 0,
    paddingLeft: 1,
    paddingRight: 1,
    get backgroundColor() {
      return rowColors(theme(), model()).bg;
    },
    onMouseOver: () => events.hover(),
    onMouseOut: () => events.leave(),
    onMouseUp: (event: MouseEvent) => {
      if (event.button !== MouseButton.LEFT) return;
      event.stopPropagation();
      if (event.modifiers.ctrl && events.copy) events.copy();
      else events.click();
    },
    children
  });
}

const MARKER_WIDTH = 2;
const RIGHT_GAP = 2;
// Lines under the title start this many cells right of it, so the titles form their own column.
const DETAIL_INDENT = 2;

/** Cells the title gets on its line, after the marker, the label and the age. */
export function titleRoom(model: Pick<RowModel, 'width' | 'label' | 'right'>): number {
  const label = model.label ? cells(model.label) + RIGHT_GAP : 0;
  return model.width - MARKER_WIDTH - RIGHT_GAP - label - cells(model.right);
}

/** First row line: marker column, title at the full remaining width, then label and age. */
export function titleLine(
  theme: () => ResolvedTheme,
  model: () => RowModel,
  events: RowEvents
): JSX.Element {
  const fg = (fallback: RGBA) => rowColors(theme(), model()).fg ?? fallback;
  return lineBox(theme, model, events, [
    // A fixed 2-cell box keeps the title column still whether the marker is a digit, a spinner
    // or a dot, and whatever width the font gives those glyphs.
    jsx('box', {
      width: MARKER_WIDTH,
      flexShrink: 0,
      children: jsx('text', {
        wrapMode: 'none',
        get children() {
          const marker = model().marker;
          return jsx('span', {
            get style() {
              return {
                fg: rowColors(theme(), model()).fg ?? marker.fg,
                bold: marker.bold ?? false
              };
            },
            children: marker.text
          });
        }
      })
    }),
    jsx('text', {
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      wrapMode: 'none',
      get children() {
        const current = model();
        const room = titleRoom(current);
        const color = current.running ? runningColor(theme()) : theme().text.base;
        return jsx('span', {
          style: { fg: fg(color), bold: current.selected },
          children: fitText(current.title[0] ?? '', room)
        });
      }
    }),
    jsx('text', {
      flexShrink: 0,
      wrapMode: 'none',
      get fg() {
        return fg(theme().text.muted);
      },
      get children() {
        const current = model();
        return current.label ? `${current.label}  ${current.right}` : current.right;
      }
    })
  ]);
}

/**
 * A later line of a row's wrapped title, starting in the title's column. The age stays on the
 * first line.
 */
export function wrapLine(
  index: number,
  theme: () => ResolvedTheme,
  model: () => RowModel,
  events: RowEvents
): JSX.Element {
  return lineBox(theme, model, events, [
    jsx('box', { width: MARKER_WIDTH, flexShrink: 0 }),
    jsx('text', {
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      wrapMode: 'none',
      get children() {
        const current = model();
        const color = current.running ? runningColor(theme()) : theme().text.base;
        return jsx('span', {
          style: { fg: rowColors(theme(), current).fg ?? color, bold: current.selected },
          children: current.title[index] ?? ''
        });
      }
    })
  ]);
}

/**
 * Word-wraps a title to lines of at most `width` cells. A word longer than a line is split
 * where the line ends.
 */
export function wrapTitle(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  let line = '';
  /** Appends `piece`, starting a new line first when it does not fit. */
  const push = (piece: string, space: boolean) => {
    const joined = line && space ? `${line} ${piece}` : `${line}${piece}`;
    if (cells(joined) <= width) {
      line = joined;
      return;
    }
    if (line) lines.push(line);
    line = '';
    if (cells(piece) <= width) {
      line = piece;
      return;
    }
    for (const { segment } of graphemes.segment(piece)) {
      if (line && cells(line + segment) > width) {
        lines.push(line);
        line = '';
      }
      line += segment;
    }
  };
  for (const word of text.split(/\s+/).filter(Boolean)) push(word, true);
  if (line || lines.length === 0) lines.push(line);
  return lines;
}

/**
 * A line under the title, indented past the title column, cut to the row width. The indent sits
 * inside the line box, so the selection still fills the whole row.
 */
function detailLine(
  theme: () => ResolvedTheme,
  model: () => RowModel,
  events: RowEvents,
  segments: (room: number) => Segment[]
): JSX.Element {
  return lineBox(theme, model, events, [
    jsx('box', { width: MARKER_WIDTH + DETAIL_INDENT, flexShrink: 0 }),
    jsx('text', {
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      wrapMode: 'none',
      get children() {
        const current = model();
        const override = rowColors(theme(), current).fg;
        const room = current.width - MARKER_WIDTH - DETAIL_INDENT;
        return fitSegments(segments(room), room).map((segment) =>
          jsx('span', {
            style: { fg: override ?? segment.fg, bold: segment.bold ?? false },
            children: segment.text
          })
        );
      }
    })
  ]);
}

/**
 * One of the lines under the title (see {@link RowDetails}). The branch shows in the preview
 * instead.
 */
export function detailsLine(
  kind: 'pr' | 'issues',
  theme: () => ResolvedTheme,
  model: () => RowModel,
  events: RowEvents
): JSX.Element {
  return detailLine(theme, model, events, (room) => {
    const details = model().details;
    if (kind === 'issues') {
      return issueSegments(details.issues, details.extra, room, theme().text.muted);
    }
    return details[kind];
  });
}

type Bun = { stringWidth(text: string): number };
const bun = (globalThis as { Bun?: Bun }).Bun;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Terminal cells a string takes. Bun measures wide and zero-width characters; Node counts code units. */
export function cells(text: string): number {
  return bun ? bun.stringWidth(text) : text.length;
}

/**
 * Cuts text to `width` cells with a trailing ellipsis. OpenTUI's own truncation cuts in the
 * middle with three dots, which hides the end of a title instead of its tail.
 */
export function fitText(text: string, width: number): string {
  if (width <= 0) return '';
  if (cells(text) <= width) return text;
  let used = 0;
  let out = '';
  for (const { segment } of graphemes.segment(text)) {
    const size = cells(segment);
    if (used + size > width - 1) break;
    out += segment;
    used += size;
  }
  return `${out}…`;
}

/** Cuts colored segments to `width` cells, ending the last visible one with an ellipsis. */
function fitSegments(segments: readonly Segment[], width: number): Segment[] {
  const total = segments.reduce((sum, segment) => sum + cells(segment.text), 0);
  if (total <= width) return [...segments];
  const out: Segment[] = [];
  let left = width;
  for (const segment of segments) {
    const size = cells(segment.text);
    if (size < left) {
      out.push(segment);
      left -= size;
      continue;
    }
    out.push({ ...segment, text: fitText(segment.text, left) });
    break;
  }
  return out;
}
