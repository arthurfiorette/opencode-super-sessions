import type { Plugin } from '@opencode/plugin/tui';
import type { Route } from '@opencode/plugin/tui/context';
import {
  createComponent,
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  lazy,
  on
} from 'solid-js';
import type { Options } from '../config.js';
import { BASE_MODE, DIALOG_MODE, OVER_PROMPT } from '../host/keymap.js';
import type { Pins } from '../pins.js';
import { type BrowserModel, createBrowserModel } from './model.js';
import { moveSelection } from './state.js';

/** Everything the browser view needs from the plugin entry. */
export interface PageProps {
  context: Plugin.Context;
  options: Options;
  pins: Pins;
  model: BrowserModel;
  /** Closes the browser. */
  close(): void;
  /** Closes the browser and shows the session, with `esc` coming back to the browser. */
  peek(sessionID: string): void;
}

/** What the peek banner shows. */
export interface PeekBannerProps {
  context: Plugin.Context;
  /** One-based position of the peek cursor in the browser's list, and the list's length. */
  position(): { index: number; total: number } | undefined;
}

/** Opens and closes the session browser drawn over the current route. */
export interface Browser {
  isOpen(): boolean;
  open(): void;
  close(): void;
  toggle(): void;
  /** Removes the overlay, the peek keys and banner, and the cached lists. */
  dispose(): void;
}

// Holding an arrow while peeking moves the cursor at key-repeat speed; only the last stop shows.
const PEEK_DELAY = 150;

// Importing `./tui` from Node must not load OpenTUI, so the view and its OpenTUI imports load
// only when the browser first opens inside the TUI.
const View = lazy(() => import('./view.js'));
// A peek starts from the browser, so the view module is loaded by the time the banner renders.
const Banner = lazy(() => import('./view.js').then((module) => ({ default: module.PeekBanner })));

/**
 * Claims the host's `app` slot, which the host renders after the route inside the main column,
 * and draws the browser there as an overlay while it is open. The route underneath stays
 * mounted, so closing the browser costs nothing to redraw.
 */
export function installBrowser(context: Plugin.Context, options: Options, pins: Pins): Browser {
  const router = context.ui.router;
  const [origin, setOrigin] = createSignal<Route>();
  const model = createBrowserModel(context, pins, () => origin() !== undefined);

  // A peek shows `peeked` and moves `cursor` with the arrows; the route follows the cursor
  // after PEEK_DELAY. The browser's own state stays in `storage.memory` for the way back.
  const [peeked, setPeeked] = createSignal<string>();
  const [cursor, setCursor] = createSignal<string>();
  let follow: ReturnType<typeof setTimeout> | undefined;
  const endPeek = () => {
    clearTimeout(follow);
    setPeeked(undefined);
    setCursor(undefined);
  };

  const close = () => setOrigin(undefined);
  const open = () => {
    const target = cursor();
    endPeek();
    if (target !== undefined) model.remember({ selected: target });
    if (origin() !== undefined) return;
    const route = copyRoute(router.current());
    model.setOrigin(route);
    setOrigin(route);
  };
  /** Shows a peeked session. Set before navigating, so the route watcher keeps the peek. */
  const show = (sessionID: string) => {
    setPeeked(sessionID);
    router.navigate({ type: 'session', sessionID });
  };
  const peek = (sessionID: string) => {
    close();
    setCursor(sessionID);
    show(sessionID);
  };
  /** Moves the peek cursor through the browser's list; the route follows after a pause. */
  const step = (delta: number) => {
    const from = cursor();
    if (from === undefined) return;
    const next = moveSelection(model.rows(), from, delta);
    // Ends of the list, or a cursor no longer in the list after a reload: stay put.
    if (next === undefined || next === from) return;
    setCursor(next);
    model.remember({ selected: next });
    clearTimeout(follow);
    follow = setTimeout(() => show(next), PEEK_DELAY);
  };
  /** Whether the peek keys apply: the peeked session is on screen and nothing else has keys. */
  const peekActive = (modes: (mode: string) => boolean) => {
    const id = peeked();
    const route = router.current();
    return (
      id !== undefined &&
      route.type === 'session' &&
      route.sessionID === id &&
      modes(context.keymap.mode.current())
    );
  };
  /** Whether the focused prompt holds text, so the arrows belong to it. */
  const typing = () => (context.renderer.currentFocusedEditor?.plainText.length ?? 0) > 0;

  const unclaimOverlay = context.ui.slot({
    append: 'app',
    render: () => {
      // Lives with the slot, which the host keeps mounted, so it sees every route change.
      createEffect(
        on(
          () => routeKey(router.current()),
          () => {
            const route = router.current();
            if (route.type !== 'session' || route.sessionID !== peeked()) endPeek();
          },
          { defer: true }
        )
      );
      return createMemo(() => {
        if (origin() === undefined) return undefined;
        return lazyNode(View, { context, options, pins, model, close, peek });
      });
    }
  });
  const unclaimBanner = context.ui.slot({
    append: 'session.composer.top',
    render: (input) =>
      createMemo(() => {
        if (peeked() === undefined || peeked() !== input.sessionID) return undefined;
        return lazyNode(Banner, {
          context,
          position: () => {
            const rows = model.rows();
            const index = rows.findIndex((session) => session.id === cursor());
            return index === -1 ? undefined : { index: index + 1, total: rows.length };
          }
        });
      })
  });

  // Writing in the peeked session means the user is working there now, so esc interrupts again.
  const offInbox = context.data.on('session.inbox.enqueued', (event) => {
    if (event.data.sessionID === peeked() && event.data.item.type === 'user') endPeek();
  });

  // Wins over the host's `session.interrupt` and `prompt.autocomplete.hide` on esc, and over
  // prompt history and `session.parent` on the arrows, while peeking (see OVER_PROMPT). With text
  // in the prompt the arrows return false and fall through to the prompt. Tradeoff: esc in a
  // running peeked session returns to the list instead of interrupting it; sending a message or
  // opening the session with enter ends the peek and gives esc back to the host. Every run stays
  // synchronous, because the keymap treats a returned Promise as handled.
  context.keymap.layer(() => ({
    mode: 'global',
    priority: OVER_PROMPT,
    commands: [
      {
        id: 'super-sessions.peek.return',
        title: 'Back to sessions',
        group: 'Session',
        bind: 'escape',
        enabled: () => peekActive((mode) => mode !== DIALOG_MODE),
        run: () => open()
      },
      {
        id: 'super-sessions.peek.previous',
        title: 'Peek previous session',
        group: 'Session',
        bind: 'up',
        enabled: () => peekActive((mode) => mode === BASE_MODE),
        run: () => (typing() ? false : step(-1))
      },
      {
        id: 'super-sessions.peek.next',
        title: 'Peek next session',
        group: 'Session',
        bind: 'down',
        enabled: () => peekActive((mode) => mode === BASE_MODE),
        run: () => (typing() ? false : step(1))
      }
    ]
  }));

  return {
    isOpen: () => origin() !== undefined,
    open,
    close,
    toggle: () => (origin() === undefined ? open() : close()),
    dispose: () => {
      endPeek();
      offInbox();
      unclaimOverlay();
      unclaimBanner();
      model.dispose();
    }
  };
}

/** Renders a lazily loaded component, hiding Solid's empty-string placeholder while it loads. */
function lazyNode<Props extends object>(
  component: (props: Props) => JSX.Element,
  props: Props
): JSX.Element {
  const view = createComponent(component, props);
  return createMemo(() => {
    const node = typeof view === 'function' ? view() : view;
    // OpenTUI boxes cannot contain text nodes.
    return node === '' ? undefined : node;
  });
}

/** A value that changes whenever the route moves to another session or page. */
export function routeKey(route: Route): string {
  if (route.type === 'session') return `session:${route.sessionID}`;
  if (route.type === 'plugin') return `plugin:${route.id ?? ''}:${route.name}`;
  return route.type;
}

/**
 * Copies a route. `router.current()` returns a live store, so keeping the reference would follow
 * the router after the user peeks into another session.
 */
function copyRoute(route: Route): Route {
  if (route.type === 'plugin') {
    return {
      type: 'plugin',
      id: route.id,
      name: route.name,
      ...(route.data ? { data: { ...route.data } } : {})
    };
  }
  return route.type === 'session'
    ? { type: 'session', sessionID: route.sessionID }
    : { type: 'home' };
}
