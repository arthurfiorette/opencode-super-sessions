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
  /** Keyboard selection, drawn in the action selection colors like a selected list row. */
  selected?(): boolean;
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
  const selected = () => input.selected?.() ?? false;
  /** Selection foreground over every part, or undefined for the parts' own colors. */
  const selectedFg = () => (selected() ? theme().text.action.primary.focused : undefined);
  /** Cells left for the title after the icon, the number and the space before the title. */
  const room = () => Math.floor(input.width()) - ICON - cells(number()) - 1;
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
      })
    ]
  });
}
