import { type Accessor, createSignal, onCleanup } from 'solid-js';
import { cells } from './page/row.js';

// Slower than the host's tab titles (600 ms, then 80 ms per cell): a title in a list is read while
// it moves, and the tab rhythm was too fast to follow.
const DELAY = 1000;
const INTERVAL = 200;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * The `width` cells of `text` that start `offset` cells in, with the offset clamped so the window
 * never runs past the end of the text. Whole graphemes only, so a wide character is never split.
 * Text that fits comes back whole.
 */
export function marqueeText(text: string, width: number, offset: number): string {
  if (width <= 0) return '';
  const skip = Math.min(Math.max(0, offset), Math.max(0, cells(text) - width));
  let skipped = 0;
  let used = 0;
  let out = '';
  for (const { segment } of graphemes.segment(text)) {
    const size = cells(segment);
    if (skipped < skip) {
      skipped += size;
      continue;
    }
    if (used + size > width) break;
    used += size;
    out += segment;
  }
  return out;
}

/**
 * Scrolls one key's text at a time while it is hovered: the start shows for 1 s, then the text
 * moves left one cell every 200 ms until its end reaches the right edge, rests there for 1 s,
 * jumps back to the start and goes round again until the pointer leaves. Only the active key
 * ticks, so a list of rows costs one timer, not one per row. Text that fits never moves, and
 * nothing moves while `animated()` is false (the host's `animations` setting).
 */
export function createMarquee(options: { animated?(): boolean } = {}): {
  /** The key currently scrolling, if any. */
  active: Accessor<string | undefined>;
  /** Current offset in cells of the active key. */
  offset: Accessor<number>;
  /** Starts scrolling `key` when `text` overflows `width`; a no-op for the key already active. */
  enter(key: string, text: string, width: number): void;
  /** Stops scrolling, but only if `key` is the active one, so a late leave cannot stop a newer enter. */
  leave(key: string): void;
} {
  const [active, setActive] = createSignal<string>();
  const [offset, setOffset] = createSignal(0);
  let delay: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;

  /** Cancels both timers. */
  const clear = () => {
    clearTimeout(delay);
    clearInterval(interval);
    delay = undefined;
    interval = undefined;
  };
  /** Returns to the resting state. */
  const reset = () => {
    clear();
    setActive(undefined);
    setOffset(0);
  };
  /** One round from the start: wait, scroll to `max`, wait, jump back, then the next round. */
  const round = (max: number) => {
    delay = setTimeout(() => {
      interval = setInterval(() => {
        // Animations turned off mid-scroll: back to the start at once.
        if (options.animated?.() === false) return reset();
        const next = offset() + 1;
        setOffset(next);
        if (next < max) return;
        clearInterval(interval);
        interval = undefined;
        delay = setTimeout(() => {
          setOffset(0);
          round(max);
        }, DELAY);
      }, INTERVAL);
    }, DELAY);
  };
  onCleanup(clear);

  return {
    active,
    offset,
    enter(key, text, width) {
      if (cells(text) <= width || options.animated?.() === false) {
        if (active() === key) reset();
        return;
      }
      if (active() === key) return;
      clear();
      setActive(key);
      setOffset(0);
      round(cells(text) - width);
    },
    leave(key) {
      if (active() === key) reset();
    }
  };
}
