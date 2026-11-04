import type { KeymapCommand } from '@opencode/plugin/tui/context';
import { type InputRenderable, type MouseEvent, RGBA, TextAttributes } from '@opentui/core';
import { jsx } from '@opentui/solid/jsx-runtime';
import {
  createComponent,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  untrack
} from 'solid-js';
import { DIALOG_MODE } from '../host/keymap.js';
import { dialogTheme } from '../host/theme.js';
import { displayValue, filterRows, SETTINGS, type SettingRow, stepValue } from './definitions.js';
import type { SettingsDialogProps } from './install.js';

// Laid out like the host's Settings dialog (packages/tui/src/component/dialog-config.tsx on
// ui/dialog-select.tsx, classic design): the host's dialog panel, a bold title with `esc`, the
// search field, accent group headers, values right-aligned, `←/→` to change. The selected row's
// description shows under the list, like the host's new-designs detail line.

/** Side padding of the dialog layout (the host's DIALOG_INSET). */
const INSET = 3;
/** Rows reserve one more cell than the layout (the host's DIALOG_LIST_INSET). */
const LIST_INSET = INSET + 1;
const TRANSPARENT = RGBA.fromInts(0, 0, 0, 0);

type Line =
  | { kind: 'blank'; key: string }
  | { kind: 'group'; key: string; title: string }
  | { kind: 'row'; key: string; row: SettingRow };

/** Group headers and rows, with a blank line before every header but the first. */
function layout(rows: readonly SettingRow[]): Line[] {
  const lines: Line[] = [];
  let group: string | undefined;
  for (const row of rows) {
    if (row.group !== group) {
      if (group !== undefined) lines.push({ kind: 'blank', key: `blank:${row.group}` });
      lines.push({ kind: 'group', key: `group:${row.group}`, title: row.group });
      group = row.group;
    }
    lines.push({ kind: 'row', key: `row:${row.key}`, row });
  }
  return lines;
}

/** The Super Sessions settings dialog, rendered inside the host's dialog panel. */
export default function SettingsDialog(props: SettingsDialogProps) {
  const context = props.context;
  const theme = () => dialogTheme(context);
  const [terminalHeight, setTerminalHeight] = createSignal(context.renderer.height);
  const onResize = () => setTerminalHeight(context.renderer.height);
  context.renderer.on('resize', onResize);
  onCleanup(() => context.renderer.off('resize', onResize));
  const [query, setQuery] = createSignal('');
  const [selected, setSelected] = createSignal<SettingRow['key'] | undefined>(props.focus);
  const [offset, setOffset] = createSignal(0);
  const [saving, setSaving] = createSignal(false);
  let input: InputRenderable | undefined;

  const rows = createMemo(() => filterRows(SETTINGS, query()));
  const lines = createMemo(() => layout(rows()));
  // The host's list height: half the terminal minus the dialog chrome.
  const height = () => Math.max(1, Math.min(lines().length, Math.floor(terminalHeight() / 2) - 6));
  const current = () => rows().find((row) => row.key === selected()) ?? rows()[0];

  // A search that hides the selected row moves the selection to the first match, like the host.
  createEffect(() => {
    const list = rows();
    if (!list.some((row) => row.key === untrack(selected))) setSelected(list[0]?.key);
  });
  // Keeps the selected row on screen.
  createEffect(() => {
    const index = lines().findIndex(
      (line) => line.kind === 'row' && line.row.key === current()?.key
    );
    if (index === -1) return;
    const top = untrack(offset);
    // The group header above the first row of a group scrolls in with it.
    const first = index > 0 && lines()[index - 1]?.kind === 'group' ? index - 1 : index;
    if (first < top) setOffset(first);
    else if (index >= top + height()) setOffset(index - height() + 1);
    else if (top > Math.max(0, lines().length - height()))
      setOffset(Math.max(0, lines().length - height()));
  });

  const settingValue = (row: SettingRow): unknown => {
    if (row.side === 'tui') return props.tui.values()[row.key];
    if (row.side === 'server') return props.server.view()?.values[row.key];
    return undefined;
  };
  const display = (row: SettingRow): string => {
    if (row.side === 'action') return '↵';
    const value = settingValue(row);
    if (row.side === 'server' && props.server.view() === undefined) {
      return props.server.error() ? 'unavailable' : '…';
    }
    return displayValue(row, value);
  };
  const description = () => {
    const row = current();
    if (row === undefined) return '';
    if (row.side === 'server' && props.server.error()) return props.server.error() ?? '';
    if (row.side === 'action') return row.description;
    return typeof row.description === 'function'
      ? row.description(settingValue(row))
      : row.description;
  };

  const move = (delta: number) => {
    const list = rows();
    if (list.length === 0) return;
    const index = list.findIndex((row) => row.key === current()?.key);
    setSelected(list[(index + delta + list.length * 10) % list.length]?.key);
  };
  const moveTo = (index: number) => setSelected(rows()[index]?.key);

  /** Steps the selected value. Changes queue behind a write in progress, like the host's. */
  const change = async (direction: number, row = current()) => {
    if (row === undefined || row.side === 'action' || saving()) return;
    const value = settingValue(row);
    if (value === undefined && row.side === 'server') return;
    const next = stepValue(row.values, value, direction);
    setSaving(true);
    try {
      if (row.side === 'tui') await props.tui.set(row.key, next as never);
      else await props.server.set(row.key, next as never);
    } catch {
      context.ui.toast.show({ message: 'Could not save the setting.', variant: 'error' });
    } finally {
      setSaving(false);
    }
  };
  /** Enter or a click: run the action, open the custom prompt, or step forward. */
  const activate = (row = current()) => {
    if (row === undefined) return;
    if (row.side === 'action') return props.runCleanup();
    if (row.side === 'tui' && row.prompt) return props.promptSuffix();
    void change(1, row);
  };

  // The host's dialogs use these command ids, so the user's own dialog keys apply here too.
  const commands: KeymapCommand[] = [
    { id: 'dialog.select.prev', title: 'Previous setting', group: 'Dialog', run: () => move(-1) },
    { id: 'dialog.select.next', title: 'Next setting', group: 'Dialog', run: () => move(1) },
    { id: 'dialog.select.page_up', title: 'Page up', group: 'Dialog', run: () => move(-10) },
    { id: 'dialog.select.page_down', title: 'Page down', group: 'Dialog', run: () => move(10) },
    { id: 'dialog.select.home', title: 'First setting', group: 'Dialog', run: () => moveTo(0) },
    {
      id: 'dialog.select.end',
      title: 'Last setting',
      group: 'Dialog',
      run: () => moveTo(rows().length - 1)
    },
    { id: 'dialog.select.submit', title: 'Change setting', group: 'Dialog', run: () => activate() },
    { bind: 'left', title: 'Previous value', group: 'Settings', run: () => void change(-1) },
    { bind: 'right', title: 'Next value', group: 'Settings', run: () => void change(1) }
  ];
  // The host's dialog pushes the "modal" mode; created in the component, so it closes with it.
  context.keymap.layer(() => ({ mode: DIALOG_MODE, commands }));

  onMount(() => {
    // The host focuses its search field one tick after mount; doing it now loses to the
    // dialog's own focus handling.
    setTimeout(() => {
      if (input && !input.isDestroyed) input.focus();
    }, 1);
  });

  const header = jsx('box', {
    paddingLeft: LIST_INSET - INSET,
    paddingRight: LIST_INSET - INSET,
    children: [
      jsx('box', {
        flexDirection: 'row',
        justifyContent: 'space-between',
        children: [
          jsx('text', {
            attributes: TextAttributes.BOLD,
            get fg() {
              return theme().text.base;
            },
            children: 'Super Sessions settings'
          }),
          jsx('text', {
            flexShrink: 0,
            get fg() {
              return theme().text.muted;
            },
            onMouseUp: () => context.ui.dialog.clear(),
            children: 'esc'
          })
        ]
      }),
      jsx('box', {
        paddingTop: 1,
        children: jsx('input', {
          flexGrow: 1,
          placeholder: 'Search',
          get focusedBackgroundColor() {
            return theme().background.formfield.focused;
          },
          get focusedTextColor() {
            return theme().text.formfield.focused;
          },
          get cursorColor() {
            return theme().text.formfield.focused;
          },
          get placeholderColor() {
            return theme().text.muted;
          },
          ref: (value: InputRenderable) => {
            input = value;
          },
          onInput: (value: string) => setQuery(value)
        })
      })
    ]
  });

  /** One list line: a blank, a group header in the accent, or a setting row. */
  const renderLine = (line: Line) => {
    if (line.kind === 'blank') return jsx('text', { height: 1, flexShrink: 0, children: ' ' });
    if (line.kind === 'group') {
      return jsx('box', {
        height: 1,
        flexShrink: 0,
        paddingLeft: LIST_INSET - 1,
        children: jsx('text', {
          attributes: TextAttributes.BOLD,
          // The token the host's select dialog uses for its category headers.
          get fg() {
            return theme().hue.accent[200];
          },
          children: line.title
        })
      });
    }
    const row = line.row;
    const active = () => current()?.key === row.key;
    const fg = () => (active() ? theme().text.action.primary.focused : theme().text.base);
    return jsx('box', {
      id: `super-sessions-setting-${row.key}`,
      flexDirection: 'row',
      height: 1,
      flexShrink: 0,
      gap: 1,
      paddingLeft: LIST_INSET - 1,
      paddingRight: LIST_INSET - 1,
      get backgroundColor() {
        return active() ? theme().background.action.primary.focused : TRANSPARENT;
      },
      onMouseMove: () => {
        if (!active()) setSelected(row.key);
      },
      onMouseDown: () => setSelected(row.key),
      onMouseUp: () => activate(row),
      children: [
        jsx('text', {
          flexGrow: 1,
          flexShrink: 1,
          overflow: 'hidden',
          wrapMode: 'none',
          get fg() {
            return fg();
          },
          get attributes() {
            return active() ? TextAttributes.BOLD : undefined;
          },
          children: row.title
        }),
        jsx('text', {
          flexShrink: 0,
          wrapMode: 'none',
          get fg() {
            return active() ? fg() : theme().text.muted;
          },
          get children() {
            return display(row);
          }
        })
      ]
    });
  };

  const visible = createMemo(() => lines().slice(offset(), offset() + height()));
  const body = jsx('box', {
    // Bleeds across the layout's padding so the selection band spans the panel, as in the host.
    marginLeft: -INSET,
    marginRight: -INSET,
    children: [
      jsx('box', {
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: 'column',
        get height() {
          return rows().length === 0 ? 1 : height();
        },
        onMouseScroll: (event: MouseEvent) => {
          const direction = event.scroll?.direction;
          if (direction !== 'up' && direction !== 'down') return;
          const max = Math.max(0, lines().length - height());
          setOffset((value) => Math.min(max, Math.max(0, value + (direction === 'up' ? -1 : 1))));
        },
        get children() {
          if (rows().length === 0) {
            return jsx('box', {
              paddingLeft: LIST_INSET - 1,
              children: jsx('text', {
                get fg() {
                  return theme().text.muted;
                },
                children: 'No results found'
              })
            });
          }
          return createComponent(For, {
            get each() {
              return visible();
            },
            children: renderLine
          });
        }
      }),
      jsx('box', {
        paddingTop: 1,
        paddingLeft: LIST_INSET,
        paddingRight: LIST_INSET,
        flexShrink: 0,
        // Two lines whatever the row, so the dialog does not change height as the selection moves.
        minHeight: 3,
        children: jsx('text', {
          wrapMode: 'word',
          get fg() {
            return context.theme.surface('dialog.footer').text.muted;
          },
          get children() {
            return description() || ' ';
          }
        })
      })
    ]
  });

  // Key first in the base color, then the action muted, like the host's prompt footer
  // (`ctrl+p commands`).
  const hint = (title: () => string, key: () => string) =>
    jsx('text', {
      wrapMode: 'none',
      children: [
        jsx('span', {
          get style() {
            return { fg: theme().text.base };
          },
          get children() {
            return key();
          }
        }),
        jsx('span', {
          get style() {
            return { fg: theme().text.muted };
          },
          get children() {
            return ` ${title()}`;
          }
        })
      ]
    });
  const footer = jsx('box', {
    flexDirection: 'row',
    justifyContent: 'space-between',
    flexShrink: 0,
    paddingLeft: LIST_INSET - INSET,
    paddingRight: LIST_INSET - INSET,
    children: [
      hint(
        () => 'change',
        () => 'left/right'
      ),
      jsx('box', {
        get visible() {
          const row = current();
          return row?.side === 'action' || (row?.side === 'tui' && row.prompt !== undefined);
        },
        children: hint(
          () => (current()?.side === 'action' ? 'run' : 'custom'),
          () => 'enter'
        )
      })
    ]
  });

  return jsx('box', {
    paddingLeft: INSET,
    paddingRight: INSET,
    paddingBottom: 1,
    gap: 1,
    children: [header, body, footer]
  });
}
