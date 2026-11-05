import type { SessionInfo } from '@opencode/client';
import type { Plugin } from '@opencode/plugin/tui';
import type { KeymapCommand, Route } from '@opencode/plugin/tui/context';
import {
  createComponent,
  createEffect,
  createMemo,
  createSignal,
  ErrorBoundary,
  type JSX,
  lazy,
  on
} from 'solid-js';
import { COMMAND_GROUP } from '../commands.js';
import type { Options } from '../config.js';
import { type HistoryScanner, listSessions } from '../history-scan.js';
import { isUserPrompt } from '../host/events.js';
import { BASE_MODE, CLASSIC_LIST, DIALOG_MODE, OVER_PROMPT, SESSION_LIST } from '../host/keymap.js';
import { listFilters } from '../host/session-api.js';
import { editorHasText, SLOTS } from '../host/tui.js';
import type { Pins } from '../pins.js';
import { tuiSettingsFor } from '../settings/store.js';
import { type BrowserModel, createBrowserModel } from './model.js';
import { moveSelection, type PageScope } from './state.js';

/** Everything the browser view needs from the plugin entry. */
export interface PageProps {
  context: Plugin.Context;
  options: Options;
  pins: Pins;
  model: BrowserModel;
  /** Scans the history of sessions the user previews, peeks or opens. */
  history: HistoryScanner;
  /** Closes the browser. */
  close(): void;
  /** Closes the browser and shows the session, with `esc` coming back to the browser. */
  peek(sessionID: string): void;
  /** Closes the browser after a crash and opens the built-in list instead. */
  fail(error: unknown): void;
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
  /**
   * Every root session, archived ones included, in the scope the browser lists now: this
   * project or all projects.
   */
  scopeSessions(): Promise<{ scope: PageScope; sessions: SessionInfo[] }>;
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
export function installBrowser(
  context: Plugin.Context,
  options: Options,
  pins: Pins,
  history: HistoryScanner
): Browser {
  const router = context.ui.router;
  const [origin, setOrigin] = createSignal<Route>();
  // `fail` is defined below; the model only calls it later, from a memo.
  const model = createBrowserModel(
    context,
    pins,
    () => origin() !== undefined,
    (error) => queueMicrotask(() => fail(error))
  );

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

  // Scans that only the preview asked for stop with the browser. Opening or peeking a session
  // closes the browser first and asks for its scan again right after, which keeps that one.
  const close = () => {
    history.cancelPreviews();
    setOrigin(undefined);
  };
  // A scan can link refs, which the open browser shows on the session's row and preview.
  const offScanned = history.onScanned((sessionID) => void model.controller.refresh([sessionID]));
  // Set by `fail` until the next open, so one crash reports once.
  let failing = false;
  const open = () => {
    failing = false;
    const target = cursor();
    endPeek();
    if (target !== undefined) model.remember({ selected: target });
    if (origin() !== undefined) return;
    if (target === undefined) model.clearSearch();
    const route = copyRoute(router.current());
    model.setOrigin(route);
    setOrigin(route);
  };
  /** Shows a peeked session. Set before navigating, so the route watcher keeps the peek. */
  const show = (sessionID: string) => {
    setPeeked(sessionID);
    router.navigate({ type: 'session', sessionID });
    history.open(sessionID);
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
  /**
   * Whether the peek keys apply: the peeked session is on screen and nothing else has keys. Off
   * on a host newer than the tested one, where beating the prompt's layers is unverified.
   */
  const peekActive = (modes: (mode: string) => boolean) => {
    const id = peeked();
    const route = router.current();
    return (
      !tuiSettingsFor(context).hostGuarded(context.app.version) &&
      id !== undefined &&
      route.type === 'session' &&
      route.sessionID === id &&
      modes(context.keymap.mode.current())
    );
  };
  /**
   * Hands the user the built-in list after the browser crashed in a render or a key action,
   * which on an untested host is the likely way a host change shows. Without its own boundary
   * the browser would hit the host's boundary around the `app` slot, which only toasts and
   * then draws nothing for that claim until a restart
   * (packages/tui/src/plugin/render.tsx:27 in OpenCode v2.2.5), while `<leader>l` kept toggling
   * an invisible browser.
   */
  const fail = (error: unknown) => {
    // The list memos recompute on session events even while the browser is closed; one report
    // per failure is enough, and nothing opens unless the user was in the browser or a peek.
    if (failing) return;
    failing = true;
    console.error('[opencode-super-sessions] The session browser failed', error);
    const shown = origin() !== undefined || peeked() !== undefined;
    endPeek();
    close();
    if (!shown) return;
    context.ui.toast.show({
      message: 'Super Sessions failed; showing the built-in list',
      variant: 'error'
    });
    context.keymap.dispatch(SESSION_LIST, CLASSIC_LIST);
  };
  /** Whether the focused prompt holds text, so the arrows belong to it. */
  const typing = () => editorHasText(context);

  const unclaimOverlay = context.ui.slot({
    append: SLOTS.app,
    render: () => {
      // Lives with the slot, which the host keeps mounted, so it sees every route change.
      createEffect(
        on(
          () => routeKey(router.current()),
          () => {
            const route = router.current();
            if (route.type !== 'session' || route.sessionID !== peeked()) endPeek();
            // Sessions opened anywhere, the quick switch keys and tabs included. Deferred, so
            // the session the TUI starts on is not scanned until the user moves.
            if (route.type === 'session') history.open(route.sessionID);
          },
          { defer: true }
        )
      );
      // A new boundary on every open, so one crash does not keep the browser away for good.
      return createMemo(() => {
        if (origin() === undefined) return undefined;
        return createComponent(ErrorBoundary, {
          fallback: (error: unknown) => {
            // Not during the render that failed: closing writes the signal this memo reads.
            queueMicrotask(() => fail(error));
            return undefined;
          },
          get children() {
            return lazyNode(View, { context, options, pins, model, history, close, peek, fail });
          }
        });
      });
    }
  });
  const unclaimBanner = context.ui.slot({
    append: SLOTS.composerTop,
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
    if (event.data.sessionID === peeked() && isUserPrompt(event)) endPeek();
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
    commands: guardActions(fail, [
      {
        id: 'super-sessions.peek.return',
        title: 'Back to sessions',
        group: COMMAND_GROUP,
        bind: 'escape',
        enabled: () => peekActive((mode) => mode !== DIALOG_MODE),
        run: () => open()
      },
      {
        id: 'super-sessions.peek.previous',
        title: 'Peek previous session',
        group: COMMAND_GROUP,
        bind: 'up',
        enabled: () => peekActive((mode) => mode === BASE_MODE),
        run: () => (typing() ? false : step(-1))
      },
      {
        id: 'super-sessions.peek.next',
        title: 'Peek next session',
        group: COMMAND_GROUP,
        bind: 'down',
        enabled: () => peekActive((mode) => mode === BASE_MODE),
        run: () => (typing() ? false : step(1))
      }
    ])
  }));

  return {
    isOpen: () => origin() !== undefined,
    open,
    close,
    toggle: () => (origin() === undefined ? open() : close()),
    async scopeSessions() {
      const scope = model.scope();
      // "This project" is the project under the browser, which follows the route while it is
      // closed, as when the next open would set it.
      if (origin() === undefined) model.setOrigin(copyRoute(router.current()));
      const filters = scope === 'all' ? {} : listFilters(await model.resolveScope());
      return { scope, sessions: await listSessions(context.client, filters) };
    },
    dispose: () => {
      endPeek();
      offInbox();
      offScanned();
      unclaimOverlay();
      unclaimBanner();
      model.dispose();
    }
  };
}

/**
 * Wraps each command's `run` so a synchronous throw goes to `fail` instead of the host's keymap.
 * The result passes through untouched, so a literal `false` still falls through.
 */
export function guardActions(
  fail: (error: unknown) => void,
  commands: KeymapCommand[]
): KeymapCommand[] {
  return commands.map((command) => {
    const run = command.run;
    if (run === undefined) return command;
    return {
      ...command,
      run: (...args: Parameters<typeof run>) => {
        try {
          return run(...args);
        } catch (error) {
          fail(error);
          return undefined;
        }
      }
    };
  });
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
