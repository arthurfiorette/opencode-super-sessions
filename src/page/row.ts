import type { ResolvedTheme } from '@opencode/theme/tui';
import { MouseButton, type MouseEvent, type RGBA } from '@opentui/core';
import { jsx } from '@opentui/solid/jsx-runtime';
import type { JSX } from 'solid-js';
import type { Options } from '../config.js';
import { refKey } from '../refs/ref.js';
import { rowRefs } from '../refs/summary.js';
import type { SessionRefView } from '../rpc.js';
import { ICONS, refColor, refIcon } from './icons.js';

/** A run of text in one color on a row's second line. */
export interface Segment {
  text: string;
  fg: string | RGBA;
}

/** Everything a session row draws. Built by the view for each visible row. */
export interface RowModel {
  marker: Segment | undefined;
  title: string;
  /** Age and cost, right-aligned on the first line. */
  right: string;
  /** Cells inside the row's padding, measured from the list. */
  width: number;
  detail: Segment[];
  selected: boolean;
  /** The first delete press turned this row into a confirmation. */
  deleting: boolean;
}

/** Input of {@link detailSegments}. */
export interface DetailInput {
  options: Options;
  theme: ResolvedTheme;
  mode: 'dark' | 'light';
  now: number;
  /** Shown only when it differs from the default branch. */
  branch: string | undefined;
  refs: SessionRefView | undefined;
  /** First line of the last assistant text, shown when the row has no branch and no refs. */
  last: string | undefined;
  /** Archive and update times, for rows in the Archived view. */
  archived?: { at: number; updated: number } | undefined;
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

/** Age and cost padded to fixed widths, so both line up down the list. */
export function rightColumn(age: string, cost: string): string {
  return `${age.padStart(4)}  ${cost.padStart(7)}`;
}

/**
 * The second line of a row: archive dates, the branch, the primary ref with its title, an issue
 * beside it and a count of the rest. A row with none of these shows the last assistant line.
 */
export function detailSegments(input: DetailInput): Segment[] {
  const muted = input.theme.text.muted;
  const pieces: Segment[][] = [];
  if (input.archived) {
    pieces.push([
      {
        text: `archived ${formatAge(input.now - input.archived.at)} · updated ${formatAge(input.now - input.archived.updated)}`,
        fg: muted
      }
    ]);
  }
  if (input.branch) pieces.push([{ text: `${ICONS.branch} ${input.branch}`, fg: muted }]);
  const summary = input.refs ? rowRefs(input.refs) : { extra: 0 };
  for (const ref of [summary.primary, summary.issue]) {
    if (ref === undefined) continue;
    const state = input.refs?.states[refKey(ref)];
    const fg = refColor(input.options, state?.status, input.theme, input.mode);
    const piece: Segment[] = [{ text: `${refIcon(ref.kind, state?.status)} #${ref.number}`, fg }];
    if (ref === summary.primary && state?.title) piece.push({ text: ` ${state.title}`, fg: muted });
    pieces.push(piece);
  }
  if (summary.extra > 0) pieces.push([{ text: `+${summary.extra}`, fg: muted }]);
  const hasRefs = summary.primary !== undefined || summary.extra > 0;
  if (!input.branch && !hasRefs && input.last) {
    pieces.push([{ text: `last: ${input.last}`, fg: muted }]);
  }
  return pieces.flatMap((piece, index) =>
    index === 0 ? piece : [{ text: '  ', fg: muted }, ...piece]
  );
}

/** Pointer handlers shared by both lines of a row. */
export interface RowEvents {
  hover(): void;
  open(): void;
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
  return { bg: undefined, fg: undefined };
}

/** Props of a row line's outer box: height, padding, colors and pointer handlers. */
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
    onMouseUp: (event: MouseEvent) => {
      if (event.button !== MouseButton.LEFT) return;
      event.stopPropagation();
      events.open();
    },
    children
  });
}

// Marker column plus the gap before the right column.
const MARKER_WIDTH = 2;
const RIGHT_GAP = 2;

/** First row line: marker column, title at the full remaining width, then age and cost. */
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
        get fg() {
          return rowColors(theme(), model()).fg ?? model().marker?.fg ?? theme().text.muted;
        },
        get children() {
          return model().marker?.text ?? '';
        }
      })
    }),
    jsx('text', {
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      wrapMode: 'none',
      get fg() {
        return fg(theme().text.base);
      },
      get children() {
        const current = model();
        const room = current.width - MARKER_WIDTH - RIGHT_GAP - cells(current.right);
        return fitText(current.title, room);
      }
    }),
    jsx('text', {
      flexShrink: 0,
      wrapMode: 'none',
      get fg() {
        return fg(theme().text.muted);
      },
      get children() {
        return model().right;
      }
    })
  ]);
}

/** Second row line, indented under the title. */
export function detailLine(
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
        const override = rowColors(theme(), current).fg;
        return fitSegments(current.detail, current.width - MARKER_WIDTH).map((segment) =>
          jsx('span', { style: { fg: override ?? segment.fg }, children: segment.text })
        );
      }
    })
  ]);
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
