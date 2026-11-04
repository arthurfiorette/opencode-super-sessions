import type { Plugin } from '@opencode/plugin/tui';
import { createComponent, createMemo, ErrorBoundary, lazy } from 'solid-js';
import type { Options } from './config.js';

/** Everything the sidebar view needs from the plugin entry. */
export interface SidebarProps {
  context: Plugin.Context;
  options: Options;
  /** Session the sidebar belongs to. Reactive: the slot input changes when the user switches. */
  sessionID: () => string;
}

// Importing `./tui` from Node must not load OpenTUI, so the view loads only when the sidebar
// first renders inside the TUI.
const Sidebar = lazy(() => import('./sidebar-view.js'));

/**
 * Adds the Work rows to the session sidebar. Returns the slot's unregister function.
 *
 * Every built-in section (Context, MCP, LSP, Todo) appends to `sidebar.content` in plugin enable
 * order, so a plugin can only sit at the top or the bottom of that slot, never between two of
 * them. The rows go first, right under the session title.
 */
export function installSidebar(context: Plugin.Context, options: Options): () => void {
  return context.ui.slot({
    prepend: 'sidebar.content',
    // A failing section hides itself instead of reaching the host's slot boundary, which would
    // toast a crash in the middle of the user's session (packages/tui/src/plugin/render.tsx:27 in
    // OpenCode v2.2.5).
    render: (input) =>
      createComponent(ErrorBoundary, {
        fallback: (error: unknown) => {
          console.error('[opencode-super-sessions] The Work section failed', error);
          return undefined;
        },
        get children() {
          const view = createComponent(Sidebar, {
            context,
            options,
            sessionID: () => input.sessionID
          });
          return createMemo(() => {
            const node = typeof view === 'function' ? view() : view;
            // Solid lazy() returns an empty string while loading; OpenTUI boxes cannot contain
            // text nodes.
            return node === '' ? undefined : node;
          });
        }
      })
  });
}
