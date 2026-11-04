import type { ResolvedTheme } from '@opencode/theme/tui';
import { MouseButton, type MouseEvent, type RGBA } from '@opentui/core';
import { jsx } from '@opentui/solid/jsx-runtime';
import type { JSX } from 'solid-js';
import type { Options } from '../config.js';
import { marqueeText } from '../marquee.js';
import { type Ref, refKey, refNumber } from '../refs/ref.js';
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
  marker: Segment | undefined;
  title: string;
  /** Muted note before the age, such as why a search matched. Empty for none. */
  label: string;
  /** Age, or archive and update ages in the Archived view, right-aligned on the title line. */
  right: string;
  /** Cells inside the row's padding, measured from the list. */
  width: number;
  /** Shown on its own line only when it is not the default branch. */
  branch: string | undefined;
  /** The refs line. Empty when the session has no refs. */
  refs: Segment[];
  selected: boolean;
  /** The first delete press turned this row into a confirmation. */
  deleting: boolean;
  /** Marquee offset while the pointer hovers a title that does not fit. */
  scroll: number | undefined;
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
 * The refs line: the primary ref with its title, the issue beside it, the ref a search matched
 * when it is neither, and a count of the rest. Icons take the state color, numbers the base
 * text color and titles the muted one, except the matched ref's title.
 */
export function refSegments(input: RefsInput): Segment[] {
  const view = input.refs;
  if (view === undefined) return [];
  const { base, muted } = input.theme.text;
  const summary = rowRefs(view);
  const shown = [summary.primary, summary.issue].filter((ref): ref is Ref => ref !== undefined);
  const matched = input.matched === undefined ? undefined : findRef(view, input.matched);
  let extra = summary.extra;
  if (matched !== undefined && !shown.some((ref) => refKey(ref) === input.matched)) {
    shown.push(matched);
    extra = Math.max(0, extra - 1);
  }
  const pieces = shown.map((ref): Segment[] => {
    const key = refKey(ref);
    const state = view.states[key];
    const hit = key === input.matched;
    const piece: Segment[] = [
      {
        text: `${refIcon(ref.kind, state?.status)} `,
        fg: refColor(input.options, state?.status, input.theme, input.mode)
      },
      { text: refNumber(ref), fg: base }
    ];
    if ((ref === summary.primary || hit) && state?.title) {
      piece.push({ text: ` ${state.title}`, fg: hit ? base : muted });
    }
    return piece;
  });
  if (extra > 0) pieces.push([{ text: `+${extra}`, fg: muted }]);
  return pieces.flatMap((piece, index) =>
    index === 0 ? piece : [{ text: '  ', fg: muted }, ...piece]
  );
}

/** Pointer handlers shared by every line of a row. */
export interface RowEvents {
  /** The pointer entered one of the row's lines. */
  hover(): void;
  /** The pointer left one of the row's lines. */
  leave(): void;
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

// Marker column plus the gap before the right column.
const MARKER_WIDTH = 2;
const RIGHT_GAP = 2;

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
        return jsx('span', {
          style: { fg: fg(theme().text.base), bold: current.selected },
          children:
            current.scroll !== undefined && current.scroll > 0
              ? marqueeText(current.title, room, current.scroll)
              : fitText(current.title, room)
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

/** A line under the title, indented to the title column, cut to the row width. */
function detailLine(
  theme: () => ResolvedTheme,
  model: () => RowModel,
  events: RowEvents,
  segments: () => Segment[]
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
        return fitSegments(segments(), current.width - MARKER_WIDTH).map((segment) =>
          jsx('span', {
            style: { fg: override ?? segment.fg, bold: segment.bold ?? false },
            children: segment.text
          })
        );
      }
    })
  ]);
}

/** Second row line, when the session is on a branch other than the default one. */
export function branchLine(
  theme: () => ResolvedTheme,
  model: () => RowModel,
  events: RowEvents
): JSX.Element {
  return detailLine(theme, model, events, () => {
    const branch = model().branch;
    return branch ? [{ text: `${ICONS.branch} ${branch}`, fg: theme().text.muted }] : [];
  });
}

/** Last row line, when the session has refs. */
export function refsLine(
  theme: () => ResolvedTheme,
  model: () => RowModel,
  events: RowEvents
): JSX.Element {
  return detailLine(theme, model, events, () => model().refs);
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
