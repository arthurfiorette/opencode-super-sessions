import type { Plugin } from '@opencode/plugin/tui';
import { MouseButton, type MouseEvent } from '@opentui/core';
import { openUrl } from './browser.js';

/**
 * Copies a URL to the clipboard through the terminal (OSC 52) and says so in a toast. Terminals
 * that refuse OSC 52, or a renderer that cannot tell, get an error toast instead.
 */
export function copyLink(context: Plugin.Context, url: string): void {
  const copied = context.renderer.copyToClipboardOSC52(url);
  context.ui.toast.show(
    copied
      ? { message: 'Copied link', variant: 'success' }
      : { message: 'This terminal does not allow copying.', variant: 'error' }
  );
}

/**
 * Handles a mouse-up on a drawn link: a left click opens `url` in the web browser, and a left
 * click with ctrl held copies it. Returns whether the event was handled, after stopping its
 * propagation; other buttons and a missing URL are left alone.
 */
export function clickLink(
  context: Plugin.Context,
  url: string | undefined,
  event: MouseEvent
): boolean {
  if (event.button !== MouseButton.LEFT || !url) return false;
  event.stopPropagation();
  if (event.modifiers.ctrl) copyLink(context, url);
  else if (!openUrl(url)) {
    context.ui.toast.show({ message: 'Could not open the browser.', variant: 'error' });
  }
  return true;
}
