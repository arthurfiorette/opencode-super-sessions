import type { Plugin } from '@opencode/plugin/tui';

// Where the host TUI lets the plugin draw, and what the browser reads from its renderer. Slot
// names are plain strings in the plugin types, so a renamed slot only shows as a missing overlay,
// banner or sidebar section; test/contract/tui.test.ts drives the real TUI through the first two.
// No OpenTUI import: `./tui` loads this from Node. Line numbers refer to the OpenCode repository
// at v2.2.5.

/** Slots the plugin appends to. */
export const SLOTS = {
  /** After the route inside the main column, where the browser overlay draws (packages/tui/src/app.tsx:1466). */
  app: 'app',
  /** Above the composer of a session, with `{ sessionID }` as input (packages/tui/src/routes/session/index.tsx:1597). */
  composerTop: 'session.composer.top',
  /** The session sidebar, where the built-in sections append too (packages/tui/src/feature-plugins/sidebar/todo.tsx:54). */
  sidebar: 'sidebar.content'
} as const;

/**
 * Whether the focused editor, the composer while a session shows, holds text. The host's keymap
 * reads the same renderer field to let typed keys reach the editor
 * (packages/tui/src/context/keymap.tsx:94).
 */
export function editorHasText(context: Plugin.Context): boolean {
  return (context.renderer.currentFocusedEditor?.plainText.length ?? 0) > 0;
}
