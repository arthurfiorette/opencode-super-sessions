// Command ids, modes and priorities of the host TUI keymap that the takeover and the peek keys
// depend on. None of them is a documented plugin API: they are what packages/tui does in OpenCode
// v2.2.5, and test/contract/tui.test.ts drives the real TUI to check that they still win. A
// keymap `run` must return a literal `false` to fall through to the next layer; a returned
// Promise counts as handled (packages/tui/src/context/keymap.tsx:245).

/** The host's session list command (packages/tui/src/app.tsx:765). */
export const SESSION_LIST = 'session.list';

/** Argument the takeover passes on to the built-in list: `/sessions classic`. */
export const CLASSIC_LIST = 'classic';

/**
 * Host command ids the browser reuses, so the user's configured keys for them apply there
 * (packages/tui/src/config/keybind.ts:48, 123, 142).
 */
export const HOST_COMMANDS = {
  rename: 'session.rename',
  delete: 'session.delete',
  pin: 'session.pin.toggle',
  exit: 'app.exit'
} as const;

/**
 * The host's command palette (packages/tui/src/context/keymap.tsx:53, run in app.tsx:756). The
 * browser dispatches it on ctrl+p, which the browser's mode would otherwise swallow; the palette
 * opens as a host dialog above the browser.
 */
export const COMMAND_PALETTE = 'command.palette.show';

/** The quick switch command of slot `slot` (packages/tui/src/config/keybind.ts:143). */
export function quickSwitchCommand(slot: number): string {
  return `session.quick_switch.${slot}`;
}

/**
 * Layers above the host's own commands, which register without a priority. The takeover and the
 * browser use it.
 */
export const OVER_HOST = 1;

/**
 * The prompt's history layer sits at priority 1 and registers again on every cursor move
 * (packages/tui/src/component/prompt/index.tsx:1022), so a priority-1 layer always lost `up` to
 * `prompt.history.previous`. The peek keys go one above it.
 */
export const OVER_PROMPT = 2;

/** The keymap mode with no dialog open (packages/tui/src/context/keymap.tsx:41). */
export const BASE_MODE = 'base';

/** The mode every host dialog pushes (packages/tui/src/ui/dialog.tsx:322). */
export const DIALOG_MODE = 'modal';

/**
 * The host's select dialog commands (packages/tui/src/ui/dialog-select.tsx:480 to 530). The
 * settings dialog registers the same ids, so the keys the user set for them apply there too.
 */
export const DIALOG_SELECT = {
  prev: 'dialog.select.prev',
  next: 'dialog.select.next',
  pageUp: 'dialog.select.page_up',
  pageDown: 'dialog.select.page_down',
  home: 'dialog.select.home',
  end: 'dialog.select.end',
  submit: 'dialog.select.submit'
} as const;
