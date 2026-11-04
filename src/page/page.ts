import type { Plugin } from '@opencode/plugin/tui';
import type { Route } from '@opencode/plugin/tui/context';
import { createComponent, createMemo, type JSX, lazy } from 'solid-js';
import type { Options } from '../config.js';
import type { Pins } from '../pins.js';

/** Router name of the session page. */
export const PAGE = 'sessions';

/** Everything the page view needs from the plugin entry. */
export interface PageProps {
  context: Plugin.Context;
  options: Options;
  pins: Pins;
  /** Route data passed to `navigate`. `returnRoute` is where `esc` goes back to. */
  data?: { returnRoute?: Route } | undefined;
}

// Importing `./tui` from Node must not load OpenTUI, so the view and its OpenTUI imports load
// only when the page first renders inside the TUI.
const View = lazy(() => import('./view.js'));

/** Renders the session page through the lazily loaded view. */
export function renderPage(props: PageProps): JSX.Element {
  const view = createComponent(View, props);
  return createMemo(() => {
    const node = typeof view === 'function' ? view() : view;
    // Solid lazy() returns an empty string while loading; OpenTUI boxes cannot contain text nodes.
    return node === '' ? undefined : node;
  });
}

/**
 * Copies a route for later navigation. `router.current()` returns a live store, so keeping the
 * reference would follow the router to the page itself.
 */
export function copyRoute(route: Route): Route {
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
