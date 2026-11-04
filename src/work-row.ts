import type { Plugin } from '@opencode/plugin/tui';
import type { ResolvedTheme } from '@opencode/theme/tui';
import { MouseButton, type MouseEvent, TextAttributes } from '@opentui/core';
import { jsx } from '@opentui/solid/jsx-runtime';
import { createSignal, type JSX } from 'solid-js';
import { openUrl, refUrl } from './browser.js';
import type { Options } from './config.js';
import { type createMarquee, marqueeText } from './marquee.js';
import { refColor, refIcon } from './page/icons.js';
import { cells, fitText } from './page/row.js';
import { type Ref, type RefState, refKey, refNumber } from './refs/ref.js';

// Cells taken by a ref glyph and its trailing space (see `ICONS`).
const ICON = 2;

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
  /** Muted text at the right edge, such as the state word. */
  right?(): string;
  /** Element id; the parts get `-icon`, `-number` and `-title` after it. */
  id?: string;
}

/**
 * One line of a Work section, shared by the session sidebar and the browser's preview: the state
 * icon in the column of the section's triangle, like the host's MCP dots, then the number in
 * `text.base` and the muted title. Hover brightens both and scrolls a cut title; a click opens
 * the ref's page. Built once per position, so updates change properties, never the tree.
 */
export function workRow(input: WorkRowInput): JSX.Element {
  const context = input.context;
  const theme = input.theme;
  const [hovered, setHovered] = createSignal(false);
  const id = (part: string) => (input.id === undefined ? {} : { id: `${input.id}-${part}` });
  const key = () => refKey(input.ref());
  const number = () => refNumber(input.ref());
  const title = () => input.state()?.title ?? '';
  const right = () => input.right?.() ?? '';
  /** Cells left for the title after the icon, the number, the space before the title and the right text. */
  const room = () =>
    Math.floor(input.width()) - ICON - cells(number()) - 1 - (right() ? cells(right()) + 1 : 0);
  return jsx('box', {
    ...(input.id === undefined ? {} : { id: input.id }),
    flexDirection: 'row',
    height: 1,
    flexShrink: 0,
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
        ...id('icon'),
        flexShrink: 0,
        wrapMode: 'none',
        get fg() {
          return refColor(input.options, input.state()?.status, theme(), context.themeMode);
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
          return theme().text.base;
        },
        // The number is already `text.base`, so hover brightens it with weight, like host toasts.
        get attributes() {
          return hovered() ? TextAttributes.BOLD : TextAttributes.NONE;
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
          return hovered() ? theme().text.base : theme().text.muted;
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
          return right() !== '';
        },
        get fg() {
          return theme().text.muted;
        },
        get children() {
          return ` ${right()}`;
        }
      })
    ]
  });
}
