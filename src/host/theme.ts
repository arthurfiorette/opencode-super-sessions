import type { Plugin } from '@opencode/plugin/tui';
import { generateSyntax, type ResolvedTheme } from '@opencode/theme/tui';
import { RGBA, type SyntaxStyle } from '@opentui/core';

// Theme surfaces and styles the browser borrows so it looks like the host's own dialogs and
// session view. The tokens are typed; these say which surface the host draws what on. Imported
// only by lazily loaded views, so `./tui` still loads without OpenTUI. Line numbers refer to the
// OpenCode repository at v2.2.5.

/** The dimmed backdrop behind host dialogs (packages/tui/src/ui/dialog.tsx:70). */
export const DIALOG_BACKDROP = RGBA.fromInts(0, 0, 0, 150);

/** The surface host dialogs draw on (packages/tui/src/ui/dialog.tsx:44). */
export function dialogTheme(context: Plugin.Context): ResolvedTheme {
  return context.theme.surface('dialog');
}

/**
 * The background the host's session view shows: the theme's `background.base`, or the terminal's
 * own background when that token is not opaque (themes such as `gruvbox-transparent` leave it
 * `transparent`). Painting a see-through color over the browser's backdrop would show the dimmed
 * route instead.
 */
export function sessionBackground(theme: ResolvedTheme): RGBA {
  const base = theme.background.base;
  return base.a >= 1 ? base : RGBA.defaultBackground();
}

/**
 * Markdown styles as the host builds them for its transcript, owned by the renderer's native scene
 * (packages/tui/src/context/theme.tsx:319). The caller destroys them once a frame no longer uses
 * them.
 */
export function markdownStyles(context: Plugin.Context, theme: ResolvedTheme): SyntaxStyle {
  return generateSyntax(theme, context.renderer.nativeScene);
}
