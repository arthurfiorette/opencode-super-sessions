import type { ResolvedTheme } from '@opencode/theme/tui';
import { MouseButton, type MouseEvent, type RGBA } from '@opentui/core';
import { jsx } from '@opentui/solid/jsx-runtime';
import type { JSX } from 'solid-js';
import type { Options } from '../config.js';
import { type Ref, type RefReview, refKey, refNumber } from '../refs/ref.js';
import { rowRefs } from '../refs/summary.js';
import type { SessionRefView } from '../rpc.js';
import { refColor, refIcon } from './icons.js';

/** A run of text in one color on a row line. */
export interface Segment {
  text: string;
  fg: string | RGBA;
  bold?: boolean;
}

/** Everything a session row draws. Built by the view for each visible row. */
export interface RowModel {
  marker: Segment | undefined;
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
  /** Background of every line of the row when not selected; undefined keeps the panel's. */
  stripe: RGBA | undefined;
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
 * - `pr`: the main PR with its title, a matched ref that is shown nowhere else, and `+N`.
 * - `status`: review and CI parts of the main PR worth acting on.
 * - `issues`: one piece per tracked issue (with its title when it is the only one), fitted to
 *   the width when drawn; `extra` is the `+N`
 *   the issues line carries when there is no PR line.
 */
export interface RowDetails {
  pr: Segment[];
  status: Segment[];
  issues: Segment[][];
  extra: number;
}

/** Details of a session without refs. */
export const NO_DETAILS: RowDetails = { pr: [], status: [], issues: [], extra: 0 };

/** The detail lines a row has, in order, for laying out the list. */
export function detailKinds(details: RowDetails): Array<'pr' | 'status' | 'issues'> {
  return [
    ...(details.pr.length > 0 ? (['pr'] as const) : []),
    ...(details.status.length > 0 ? (['status'] as const) : []),
    ...(details.issues.length > 0 ? (['issues'] as const) : [])
  ];
}

/**
 * The list row's status parts for an open pull request, in the colors the forge uses for them.
 * A pending review request and passing checks are the normal state, so they are left out.
 */
export function statusSegments(review: RefReview | undefined, theme: ResolvedTheme): Segment[] {
  if (review === undefined) return [];
  const feedback = theme.text.feedback;
  const parts: Segment[] = [];
  if (review.decision === 'changes_requested') {
    parts.push({ text: 'changes requested', fg: feedback.error.base });
  }
  if (review.unresolved !== undefined && review.unresolved > 0) {
    parts.push({ text: `${review.unresolved} unresolved`, fg: feedback.warning.base });
  }
  if (review.checks === 'failing') parts.push({ text: 'checks failing', fg: feedback.error.base });
  if (review.checks === 'pending') parts.push({ text: 'checks pending', fg: theme.text.muted });
  if (review.decision === 'approved') parts.push({ text: 'approved', fg: feedback.success.base });
  return parts.flatMap((part, index) =>
    index === 0 ? [part] : [{ text: ' · ', fg: theme.text.muted }, part]
  );
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
  /** Icon and number of `ref`, plus its title when `titled`. */
  const piece = (ref: Ref, titled: boolean): Segment[] => {
    const key = refKey(ref);
    const state = view.states[key];
    const color = refColor(input.options, state?.status, input.theme, input.mode);
    const segments: Segment[] = [
      { text: `${refIcon(ref.kind, state?.status)} `, fg: color },
      { text: refNumber(ref), fg: color }
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
    ...piece(ref, ref === summary.pr || ref === extraHit)
  ]);
  if (pr.length > 0 && extra > 0) pr.push({ text: `  +${extra}`, fg: muted });
  const mainState = summary.pr ? view.states[refKey(summary.pr)] : undefined;
  const open = mainState?.status === 'open' || mainState?.status === 'draft';
  return {
    pr,
    status: open ? statusSegments(mainState?.review, input.theme) : [],
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
  open(): void;
}

/**
 * Color of a running session's spinner and title. The warning feedback token, which reads as
 * yellow in gruvbox, because the muted text the spinner used before did not stand out.
 */
export function runningColor(theme: ResolvedTheme): RGBA {
  return theme.text.feedback.warning.base;
}

/** Background and foreground of a row for its selection and delete state. */
function rowColors(theme: ResolvedTheme, model: RowModel) {
  if (model.deleting) {
    return {
      bg: theme.background.action.destructive.focused,
      fg: theme.text.action.destructive.focused
    };
  }
  if (model.selected) {
    return { bg: theme.background.action.primary.focused, fg: theme.text.action.primary.focused };
  }
  return { bg: model.stripe, fg: undefined };
}

/** A row line's outer box: height, padding, colors and pointer handlers. */
function lineBox(
  theme: () => ResolvedTheme,
  model: () => RowModel,
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
      events.open();
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
                fg: rowColors(theme(), model()).fg ?? marker?.fg ?? theme().text.muted,
                bold: marker?.bold ?? false
              };
            },
            children: marker?.text ?? ''
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
 * inside the line box, so the stripe and the selection still fill the whole row.
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
  kind: 'pr' | 'status' | 'issues',
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
