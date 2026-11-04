import type { Plugin } from '@opencode/plugin/tui';
import type { ResolvedTheme } from '@opencode/theme/tui';
import { MouseButton, type MouseEvent, TextAttributes } from '@opentui/core';
import { jsx } from '@opentui/solid/jsx-runtime';
import { createSignal, type JSX } from 'solid-js';
import { openUrl, refUrl } from './browser.js';
import type { Options } from './config.js';
import { type createMarquee, marqueeText } from './marquee.js';
import { refColor, refIcon } from './page/icons.js';
import { cells, fitText, stateBadges } from './page/row.js';
import { type Ref, type RefState, refKey, refNumber } from './refs/ref.js';

// Cells taken by a ref glyph and its trailing space (see `ICONS`).
const ICON = 2;
// Blank cells between the title and the marker at the right end.
const MARKER_GAP = 2;

/** Inputs of {@link workRow}. */
export interface WorkRowInput {
  context: Plugin.Context;
  options: Options;
  theme(): ResolvedTheme;
  ref(): Ref;
  state(): RefState | undefined;
  /** Cells of the whole row. */
  width(): number;
  marquee: ReturnType<typeof createMarquee>;
  /** Keyboard selection, drawn in the action selection colors like a selected list row. */
  selected?(): boolean;
  /** Small muted note at the right end, such as `branch` for the session's branch PR. */
  marker?(): string | undefined;
  /** Element id; the parts get `-icon`, `-number` and `-title` after it. */
  id?: string;
}

/**
 * The full review and CI status of an open pull request, as one muted line such as
 * `approved · 2/3 threads resolved · checks passing`. Undefined when there is nothing to say.
 */
export function reviewSummary(state: RefState | undefined): string | undefined {
  const review = state?.status === 'open' || state?.status === 'draft' ? state.review : undefined;
  if (review === undefined) return undefined;
  const parts: string[] = [];
  if (review.decision !== undefined) parts.push(review.decision.replace('_', ' '));
  if (review.threads !== undefined && review.threads > 0) {
    parts.push(`${review.threads - (review.unresolved ?? 0)}/${review.threads} threads resolved`);
  }
  if (review.checks !== undefined) {
    const counts =
      review.checksTotal === undefined ? '' : `${review.checksPassed ?? 0}/${review.checksTotal} `;
    parts.push(`${counts}checks ${review.checks}`);
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * The muted status line under a preview Work row's pull request, indented by one icon slot.
 * Hidden while {@link reviewSummary} has nothing to say.
 */
export function workStatusLine(input: {
  theme(): ResolvedTheme;
  state(): RefState | undefined;
  width(): number;
}): JSX.Element {
  return jsx('box', {
    flexDirection: 'row',
    height: 1,
    flexShrink: 0,
    paddingLeft: ICON,
    get visible() {
      return reviewSummary(input.state()) !== undefined;
    },
    children: jsx('text', {
      wrapMode: 'none',
      get fg() {
        return input.theme().text.muted;
      },
      get children() {
        return fitText(reviewSummary(input.state()) ?? '', Math.floor(input.width()) - ICON);
      }
    })
  });
}

/**
 * One line of a Work section, shared by the session sidebar and the browser's preview: an open
 * pull request's review and CI icons (see {@link stateBadges}), then the state icon, starting in
 * the column of the section's triangle like the host's MCP dots, then the number in `text.base`
 * and the muted title. Hover brightens both and scrolls a cut title; a click opens the ref's
 * page. Built once per position, so updates change properties, never the tree.
 */
export function workRow(input: WorkRowInput): JSX.Element {
  const context = input.context;
  const theme = input.theme;
  const [hovered, setHovered] = createSignal(false);
  const id = (part: string) => (input.id === undefined ? {} : { id: `${input.id}-${part}` });
  const key = () => refKey(input.ref());
  const number = () => refNumber(input.ref());
  const title = () => input.state()?.title ?? '';
  const selected = () => input.selected?.() ?? false;
  /** Selection foreground over every part, or undefined for the parts' own colors. */
  const selectedFg = () => (selected() ? theme().text.action.primary.focused : undefined);
  const marker = () => input.marker?.();
  const badges = () => stateBadges(input.state(), theme());
  /**
   * Cells left for the title after the badges, the icon, the number, the marker and the spaces
   * between.
   */
  const room = () => {
    const note = marker();
    const before = badges().reduce((sum, segment) => sum + cells(segment.text), 0);
    return (
      Math.floor(input.width()) -
      before -
      ICON -
      cells(number()) -
      1 -
      (note ? cells(note) + MARKER_GAP : 0)
    );
  };
  return jsx('box', {
    ...(input.id === undefined ? {} : { id: input.id }),
    flexDirection: 'row',
    height: 1,
    flexShrink: 0,
    get backgroundColor() {
      return selected() ? theme().background.action.primary.focused : undefined;
    },
    onMouseOver: () => {
      setHovered(true);
      input.marquee.enter(key(), title(), room());
    },
    onMouseOut: () => {
      setHovered(false);
      input.marquee.leave(key());
    },
    onMouseUp: (event: MouseEvent) => {
      if (event.button !== MouseButton.LEFT) return;
      event.stopPropagation();
      if (!openUrl(refUrl(input.ref(), input.state())))
        context.ui.toast.show({ message: 'Could not open the browser.', variant: 'error' });
    },
    children: [
      jsx('text', {
        ...id('badges'),
        flexShrink: 0,
        wrapMode: 'none',
        get visible() {
          return badges().length > 0;
        },
        get children() {
          return badges().map((segment) =>
            jsx('span', {
              get style() {
                return { fg: selectedFg() ?? segment.fg };
              },
              children: segment.text
            })
          );
        }
      }),
      jsx('text', {
        ...id('icon'),
        flexShrink: 0,
        wrapMode: 'none',
        get fg() {
          return (
            selectedFg() ??
            refColor(input.options, input.state()?.status, theme(), context.themeMode)
          );
        },
        get children() {
          return `${refIcon(input.ref().kind, input.state()?.status)} `;
        }
      }),
      jsx('text', {
        ...id('number'),
        flexShrink: 0,
        wrapMode: 'none',
        get fg() {
          return selectedFg() ?? theme().text.base;
        },
        // The number is already `text.base`, so hover brightens it with weight, like host toasts.
        // A selected list row is bold too.
        get attributes() {
          return hovered() || selected() ? TextAttributes.BOLD : TextAttributes.NONE;
        },
        get children() {
          return number();
        }
      }),
      jsx('text', {
        ...id('title'),
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        wrapMode: 'none',
        get fg() {
          return selectedFg() ?? (hovered() ? theme().text.base : theme().text.muted);
        },
        get children() {
          if (!title() || room() <= 0) return '';
          return input.marquee.active() === key() && input.marquee.offset() > 0
            ? ` ${marqueeText(title(), room(), input.marquee.offset())}`
            : ` ${fitText(title(), room())}`;
        }
      }),
      jsx('text', {
        flexShrink: 0,
        wrapMode: 'none',
        get visible() {
          return marker() !== undefined;
        },
        get fg() {
          return selectedFg() ?? theme().text.muted;
        },
        get children() {
          return `${' '.repeat(MARKER_GAP)}${marker() ?? ''}`;
        }
      })
    ]
  });
}
