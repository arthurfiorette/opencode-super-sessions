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
import type { Pins } from '../pins.js';

/** Everything the browser view needs from the plugin entry. */
export interface PageProps {
  context: Plugin.Context;
  options: Options;
  pins: Pins;
  /** Route on screen when the browser opened. "This project" means its project. */
  origin: Route;
  /** Closes the browser. */
  close(): void;
  /** Closes the browser and shows the session, with `esc` coming back to the browser. */
  peek(sessionID: string): void;
}

/** Opens and closes the session browser drawn over the current route. */
export interface Browser {
  isOpen(): boolean;
  open(): void;
  close(): void;
  toggle(): void;
  /** Removes the overlay's slot claim and the peek listeners. */
  dispose(): void;
}

/** Host keymap mode of its dialogs. */
const DIALOG_MODE = 'modal';

// Importing `./tui` from Node must not load OpenTUI, so the view and its OpenTUI imports load
// only when the browser first opens inside the TUI.
const View = lazy(() => import('./view.js'));

/**
 * Claims the host's `app` slot, which the host renders after the route inside the main column,
 * and draws the browser there as an overlay while it is open. The route underneath stays
 * mounted, so closing the browser costs nothing to redraw.
 */
export function installBrowser(context: Plugin.Context, options: Options, pins: Pins): Browser {
  const router = context.ui.router;
  const [origin, setOrigin] = createSignal<Route>();
  // Session shown by a peek. Its browser state stays in `storage.memory`, so reopening restores it.
  const [peeking, setPeeking] = createSignal<string>();
  const close = () => setOrigin(undefined);
  const open = () => {
    setPeeking(undefined);
    if (origin() !== undefined) return;
    setOrigin(copyRoute(router.current()));
  };
  const peek = (sessionID: string) => {
    close();
    router.navigate({ type: 'session', sessionID });
    setPeeking(sessionID);
    context.ui.toast.show({ message: 'Peeking. esc returns to sessions.' });
  };

  const unclaim = context.ui.slot({
    append: 'app',
    render: () => {
      // Lives with the slot, which the host keeps mounted, so it sees every route change.
      createEffect(
        on(
          () => routeKey(router.current()),
          () => {
            const route = router.current();
            if (route.type !== 'session' || route.sessionID !== peeking()) setPeeking(undefined);
          },
          { defer: true }
        )
      );
      return createMemo(() => {
        const from = origin();
        if (from === undefined) return undefined;
        return renderView({ context, options, pins, origin: from, close, peek });
      });
    }
  });

  // Writing in the peeked session means the user is working there now, so esc interrupts again.
  const offInbox = context.data.on('session.inbox.enqueued', (event) => {
    if (event.data.sessionID === peeking() && event.data.item.type === 'user') {
      setPeeking(undefined);
    }
  });

  // Global with priority 1, so it wins over the host's `session.interrupt` and
  // `prompt.autocomplete.hide` on esc while peeking. Tradeoff: esc in a running peeked session
  // returns to the list instead of interrupting it; sending a message or opening the session
  // with enter ends the peek and gives esc back to the host.
  context.keymap.layer(() => ({
    mode: 'global',
    priority: 1,
    commands: [
      {
        id: 'super-sessions.peek.return',
        title: 'Back to sessions',
        group: 'Session',
        bind: 'escape',
        enabled: () => {
          const id = peeking();
          const route = router.current();
          return (
            id !== undefined &&
            route.type === 'session' &&
            route.sessionID === id &&
            context.keymap.mode.current() !== DIALOG_MODE
          );
        },
        // Synchronous: the keymap treats a returned Promise as handled either way.
        run: () => open()
      }
    ]
  }));

  return {
    isOpen: () => origin() !== undefined,
    open,
    close,
    toggle: () => (origin() === undefined ? open() : close()),
    dispose: () => {
      offInbox();
      unclaim();
    }
  };
}

/** Renders the lazily loaded view. */
function renderView(props: PageProps): JSX.Element {
  const view = createComponent(View, props);
  return createMemo(() => {
    const node = typeof view === 'function' ? view() : view;
    // Solid lazy() returns an empty string while loading; OpenTUI boxes cannot contain text nodes.
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
