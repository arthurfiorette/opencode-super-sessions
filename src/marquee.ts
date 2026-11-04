import { type Accessor, createSignal, onCleanup } from 'solid-js';
import { cells } from './page/row.js';

// Same rhythm as the host's session tabs (packages/tui/src/component/session-tabs.tsx), so a
// scrolling title here moves like a scrolling tab title.
const GAP = ' · ';
const DELAY = 600;
const INTERVAL = 80;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * The `width` cells of `text` visible at `offset` while it scrolls left, wrapping around through a
 * separator. Text that fits, or offset 0, returns the plain head of the text.
 * Ported from the host's `util/marquee.ts` (MIT).
 */
export function marqueeText(text: string, width: number, offset: number): string {
  if (width <= 0) return '';
  const head = (value: string) => {
    let used = 0;
    let out = '';
    for (const { segment } of graphemes.segment(value)) {
      const size = cells(segment);
      if (used + size > width) break;
      used += size;
      out += segment;
    }
    return out;
  };
  if (cells(text) <= width || offset <= 0) return head(text);
  const loop = [...graphemes.segment(text + GAP)].map(({ segment }) => segment);
  const cycle = cells(text + GAP);
  let skipped = 0;
  let start = 0;
  // Skip whole graphemes until `offset % cycle` cells are behind, so wide characters never split.
  while (skipped < offset % cycle && start < loop.length) {
    skipped += cells(loop[start] ?? '');
    start++;
  }
  return head([...loop.slice(start), ...loop].join(''));
}

/**
 * Scrolls one key's text at a time, like the host's tab titles: after a short delay the text moves
 * one cell every 80 ms for one full cycle, then rests at the start. Only the active key ticks, so a
 * list of rows costs one timer, not one per row.
 */
export function createMarquee(): {
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
  onCleanup(clear);

  return {
    active,
    offset,
    enter(key, text, width) {
      if (cells(text) <= width) {
        if (active() === key) reset();
        return;
      }
      if (active() === key) return;
      clear();
      setActive(key);
      setOffset(0);
      const cycle = cells(text + GAP);
      delay = setTimeout(() => {
        interval = setInterval(() => {
          const next = offset() + 1;
          if (next < cycle) return setOffset(next);
          clear();
          setOffset(0);
        }, INTERVAL);
      }, DELAY);
    },
    leave(key) {
      if (active() === key) reset();
    }
  };
}
