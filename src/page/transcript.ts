import type { SessionMessageAssistantTool, SessionMessageInfo } from '@opencode/client';
import type { Plugin } from '@opencode/plugin/tui';
import type { ResolvedTheme } from '@opencode/theme/tui';
import { RGBA, type SyntaxStyle, TextAttributes } from '@opentui/core';
import { jsx } from '@opentui/solid/jsx-runtime';
import { createComponent, createMemo, createSignal, For, type JSX, Show, untrack } from 'solid-js';
import type { CliSettings } from '../cli-settings.js';
import { titlecase } from './preview-header.js';
import {
  activitySummary,
  canonicalTool,
  collapseShellOutput,
  explorationLabel,
  filetype,
  formatDuration,
  inputSummary,
  type PatchFile,
  parseTodos,
  patchFiles,
  reasoningContent,
  reasoningTitle,
  stripAnsi,
  type Thought,
  type TranscriptRow,
  todoMarker,
  toolInput,
  toolMetadata,
  toolOutput
} from './transcript-model.js';

// The transcript copies the host session view's structure, props and tokens. The host's components
// are not exported to plugins, so each function below names the one it was ported from in
// packages/tui/src/routes/session/{index,message-parts,group-view}.tsx (MIT).

/** Inputs of the transcript. */
export interface TranscriptProps {
  context: Plugin.Context;
  theme(): ResolvedTheme;
  rows(): TranscriptRow[];
  /** Markdown style for assistant text. */
  syntax(): SyntaxStyle;
  /** Markdown style with every token muted, for expanded thoughts. */
  thinking(): SyntaxStyle;
  /** Cells available for the transcript. */
  width(): number;
  /** Current spinner glyph, `⋯` while animations are off. */
  spinner(): string;
  /** The host's view settings: thinking, Markdown markers, verbosity and grouping. */
  settings: Readonly<CliSettings>;
  agentColor(agent: string): RGBA;
  modelName(model: { providerID: string; id: string }): string;
  /** The session's agent, which colors the border of user messages. */
  agent(): string;
}

type Row<Type extends TranscriptRow['type']> = Extract<TranscriptRow, { type: Type }>;
type Tool = SessionMessageAssistantTool;

// The host's `SplitBorder`: only a heavy left bar (packages/tui/src/ui/border.ts, MIT).
const SPLIT_BORDER = {
  topLeft: '',
  bottomLeft: '',
  vertical: '┃',
  topRight: '',
  bottomRight: '',
  horizontal: ' ',
  bottomT: '',
  topT: '',
  cross: '',
  leftT: '',
  rightT: ''
};

const ICON_WIDTH = 2;
const SHELL_LINES = 10;

/** Every row one blank line below the previous one, as in the host's `SessionRowView`. */
export function Transcript(props: TranscriptProps): JSX.Element {
  return keyedRows(props, props.rows, (view) =>
    jsx('box', { marginTop: 1, flexShrink: 0, children: view })
  );
}

/** One view per row, each in `wrap`. Rows keep their view across reloads: only a new key mounts. */
function keyedRows(
  props: TranscriptProps,
  rows: () => TranscriptRow[],
  wrap: (view: JSX.Element) => JSX.Element
): JSX.Element {
  const byKey = createMemo(() => new Map(rows().map((row) => [row.key, row])));
  const keys = createMemo(() => rows().map((row) => row.key), [], {
    equals: (a, b) => a.length === b.length && a.every((key, index) => key === b[index])
  });
  return createComponent(For, {
    get each() {
      return keys();
    },
    children: (key: string) => {
      let last = byKey().get(key);
      if (!last) return null;
      // A removed key may be read once more before For disposes its row.
      const row = () => {
        last = byKey().get(key) ?? last;
        return last as TranscriptRow;
      };
      return wrap(rowView(props, last.type, row));
    }
  });
}

/**
 * Whether a group is open: the user's last click on it, else `initial()`, which follows the
 * verbosity setting until then (`useDisclosure` and `groupExpanded` in the host).
 */
function disclosure(initial: () => boolean) {
  const [toggled, setToggled] = createSignal<boolean>();
  const expanded = () => toggled() ?? initial();
  return { expanded, toggle: () => setToggled(!expanded()) };
}

/** Whether Markdown markers are hidden, the host's `session.markdown: rendered`. */
function concealed(props: TranscriptProps): boolean {
  return props.settings.session.markdown === 'rendered';
}

/** The component for one row type. `row` keeps returning the same type for a key. */
function rowView(
  props: TranscriptProps,
  type: TranscriptRow['type'],
  row: () => TranscriptRow
): JSX.Element {
  const as =
    <Type extends TranscriptRow['type']>() =>
    () =>
      row() as Row<Type>;
  switch (type) {
    case 'user':
      return userMessage(props, as<'user'>());
    case 'shell':
      return shellMessage(props, as<'shell'>());
    case 'text':
      return textPart(props, as<'text'>());
    case 'thoughts':
      return thoughts(props, as<'thoughts'>());
    case 'exploration':
      return exploration(props, as<'exploration'>());
    case 'tool':
      // Each status draws differently, so the view rebuilds when it changes and reads a snapshot.
      return mount(
        () => (row() as Row<'tool'>).part.state.status,
        () => toolView(props, (row() as Row<'tool'>).part)
      );
    case 'footer':
      return footer(props, as<'footer'>());
    case 'notice':
      return notice(props, (row() as Row<'notice'>).message);
    case 'compaction':
      return compaction(props, as<'compaction'>());
    case 'instructions':
      return instructions(props, as<'instructions'>());
    case 'activity':
      return activityGroup(props, as<'activity'>());
    case 'error':
      return padded(
        3,
        errorText(props, () => `Error: ${(row() as Row<'error'>).text}`)
      );
  }
}

/**
 * Renders `render()` while `when()` is truthy, again each time its value changes. The one-argument
 * child makes Solid's `Show` call it untracked, so reads inside never rebuild the content.
 */
function mount(when: () => unknown, render: () => JSX.Element): JSX.Element {
  return createComponent(Show, {
    keyed: true,
    get when() {
      return when();
    },
    children: (_value: unknown) => untrack(render)
  });
}

/** A user prompt: a raised box with a left bar in the agent's color (`UserMessage`). */
function userMessage(props: TranscriptProps, row: () => Row<'user'>): JSX.Element {
  const theme = props.theme;
  const chip = (label: string, name: string) =>
    jsx('text', {
      get fg() {
        return theme().text.base;
      },
      get children() {
        return [
          jsx('span', {
            style: {
              bg: theme().hue.accent[props.context.themeMode === 'light' ? 300 : 200],
              fg: theme().background.raised.base,
              bold: true
            },
            children: ` ${label} `
          }),
          jsx('span', {
            style: { bg: theme().decrease(theme().background.raised.base), fg: theme().text.muted },
            children: ` ${name} `
          })
        ];
      }
    });
  const chips = (items: () => { label: string; name: string }[]) =>
    jsx('box', {
      flexDirection: 'row',
      paddingTop: 1,
      gap: 1,
      flexWrap: 'wrap',
      get visible() {
        return items().length > 0;
      },
      children: createComponent(For, {
        get each() {
          return items();
        },
        children: (item: { label: string; name: string }) => chip(item.label, item.name)
      })
    });
  return jsx('box', {
    border: ['left'],
    customBorderChars: SPLIT_BORDER,
    get borderColor() {
      return props.agentColor(props.agent());
    },
    get backgroundColor() {
      return theme().background.raised.base;
    },
    children: jsx('box', {
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 2,
      paddingRight: 2,
      flexShrink: 0,
      get backgroundColor() {
        return theme().background.raised.base;
      },
      children: [
        jsx('text', {
          get fg() {
            return theme().text.base;
          },
          get children() {
            return row().message.text;
          }
        }),
        chips(() =>
          (row().message.skills ?? []).map((skill) => ({ label: 'skill', name: skill.name }))
        ),
        chips(() =>
          (row().message.files ?? []).map((file) => ({
            label: file.mime === 'application/x-directory' ? 'dir' : 'file',
            name: file.name ?? (file.source.type === 'uri' ? file.source.uri : 'attachment')
          }))
        )
      ]
    })
  });
}

/** Assistant text with the host's exact markdown props (`TextPart`). */
function textPart(props: TranscriptProps, row: () => Row<'text'>): JSX.Element {
  const theme = props.theme;
  return jsx('box', {
    paddingLeft: 3,
    flexShrink: 0,
    children: jsx('markdown', {
      get syntaxStyle() {
        return props.syntax();
      },
      get content() {
        return row().part.text.trim();
      },
      get streaming() {
        return row().message.time.completed === undefined;
      },
      internalBlockMode: 'top-level',
      tableOptions: { style: 'grid', cellPaddingX: 1 },
      get conceal() {
        return concealed(props);
      },
      get fg() {
        return theme().markdown.text;
      },
      get bg() {
        return theme().background.base;
      }
    })
  });
}

/** Warning color at 60% opacity, the resting color of a finished thought. */
function faded(color: RGBA): RGBA {
  return RGBA.fromValues(color.r, color.g, color.b, 0.6);
}

/**
 * A run of thoughts: every thought open under its own header with `session.thinking: show`,
 * otherwise one folded line. Switching the setting rebuilds the row.
 */
function thoughts(props: TranscriptProps, row: () => Row<'thoughts'>): JSX.Element {
  return mount(
    () => props.settings.session.thinking,
    () =>
      props.settings.session.thinking === 'show'
        ? createComponent(For, {
            get each() {
              return row().items;
            },
            children: (item: Thought) => reasoningPart(props, item)
          })
        : foldedThoughts(props, row)
  );
}

/**
 * One open thought: a `Thought: 4.2s` header, or `Thinking` with the spinner while it runs, over
 * its text, each behind a left bar (`ReasoningPart` and `ReasoningHeader` outside "hide" mode).
 */
function reasoningPart(props: TranscriptProps, item: Thought): JSX.Element {
  const theme = props.theme;
  const message = item.message;
  const part = item.part;
  const done = part.time?.completed !== undefined || message.time.completed !== undefined;
  const end = part.time?.completed ?? message.time.completed;
  const start = part.time?.created ?? message.time.created;
  const duration = end === undefined ? 0 : Math.max(0, end - start);
  const bar = (child: JSX.Element) =>
    jsx('box', {
      border: ['left'],
      customBorderChars: SPLIT_BORDER,
      get borderColor() {
        return theme().decrease(theme().background.base);
      },
      paddingLeft: 1,
      children: child
    });
  return jsx('box', {
    paddingLeft: 3,
    flexDirection: 'column',
    flexShrink: 0,
    children: [
      bar(
        jsx('text', {
          wrapMode: 'none',
          get fg() {
            return faded(theme().text.feedback.warning.base);
          },
          get children() {
            return done ? `Thought: ${formatDuration(duration)}` : `${props.spinner()} Thinking`;
          }
        })
      ),
      jsx('box', {
        marginTop: 1,
        children: bar(
          jsx('code', {
            filetype: 'markdown',
            drawUnstyledText: false,
            streaming: true,
            get syntaxStyle() {
              return props.thinking();
            },
            content: reasoningContent(part),
            get conceal() {
              return concealed(props);
            },
            get fg() {
              return theme().text.muted;
            }
          })
        )
      })
    ]
  });
}

/**
 * A run of thoughts as one `Thought: title · N steps · 4.2s` line that opens on click, the
 * host's "hide" thinking mode (`GroupContent` for reasoning, `ThoughtEntry`).
 */
function foldedThoughts(props: TranscriptProps, row: () => Row<'thoughts'>): JSX.Element {
  const theme = props.theme;
  const open = disclosure(() => false);
  const expanded = open.expanded;
  const [hover, setHover] = createSignal(false);
  const latest = () => {
    for (const item of [...row().items].reverse()) {
      const title = reasoningTitle(reasoningContent(item.part));
      if (title) return title;
    }
    return undefined;
  };
  const duration = () =>
    row().items.reduce((total, { part }) => {
      const start = part.time?.created;
      const end = part.time?.completed;
      return total + (start === undefined || end === undefined ? 0 : Math.max(0, end - start));
    }, 0);
  const label = () => {
    const current = latest();
    if (!row().completed) return current ? `Thinking: ${current}` : 'Thinking';
    let text = 'Thought';
    if (!expanded() && current) text += `: ${current}`;
    if (row().items.length > 1) text += ` · ${row().items.length} steps`;
    if (duration()) text += ` · ${formatDuration(duration())}`;
    return text;
  };
  const warning = () => theme().text.feedback.warning.base;
  return jsx('box', {
    flexDirection: 'column',
    flexShrink: 0,
    children: [
      inlineRow(props, {
        icon: () => (expanded() ? '-' : '+'),
        color: () =>
          !row().completed
            ? theme().text.base
            : hover() || expanded()
              ? warning()
              : faded(warning()),
        spinner: () => !row().completed,
        text: label,
        onMouseOver: () => setHover(true),
        onMouseOut: () => setHover(false),
        onMouseUp: open.toggle
      }),
      mount(expanded, () =>
        jsx('box', {
          paddingLeft: 3,
          children: createComponent(For, {
            get each() {
              return row().items;
            },
            children: (item: Row<'thoughts'>['items'][number]) =>
              jsx('box', {
                marginTop: 1,
                flexShrink: 0,
                border: ['left'],
                customBorderChars: SPLIT_BORDER,
                get borderColor() {
                  return theme().decrease(theme().background.raised.base);
                },
                paddingLeft: 1,
                children: jsx('code', {
                  filetype: 'markdown',
                  drawUnstyledText: false,
                  streaming:
                    item.part.time?.completed === undefined &&
                    item.message.time.completed === undefined,
                  get syntaxStyle() {
                    return props.thinking();
                  },
                  content: reasoningContent(item.part),
                  get conceal() {
                    return concealed(props);
                  },
                  get fg() {
                    return theme().text.muted;
                  }
                })
              })
          })
        })
      )
    ]
  });
}

/**
 * Reads and searches: each call on its own with `session.grouping: none`, otherwise one
 * `Explored: 2 reads, 1 search` line that opens on click, open from the start at `high`
 * verbosity (`GroupContent`).
 */
function exploration(props: TranscriptProps, row: () => Row<'exploration'>): JSX.Element {
  return mount(
    () => props.settings.session.grouping,
    () =>
      props.settings.session.grouping === 'none'
        ? toolList(props, () => row().tools)
        : groupedExploration(props, row)
  );
}

/** Tool calls one after another, with no gap, as inside a host group. */
function toolList(props: TranscriptProps, tools: () => Tool[]): JSX.Element {
  return createComponent(For, {
    get each() {
      return tools();
    },
    children: (tool: Tool) => toolView(props, tool)
  });
}

/** The folded `Explored` line and, once opened, its calls. */
function groupedExploration(props: TranscriptProps, row: () => Row<'exploration'>): JSX.Element {
  const theme = props.theme;
  const open = disclosure(() => props.settings.session.verbosity === 'high');
  const [hover, setHover] = createSignal(false);
  const completed = () =>
    row().completed || row().tools.every((tool) => tool.time.completed !== undefined);
  return jsx('box', {
    flexDirection: 'column',
    flexShrink: 0,
    children: [
      inlineRow(props, {
        icon: () => (completed() ? '→' : '✱'),
        color: () => (hover() ? theme().text.base : theme().text.muted),
        spinner: () => !completed(),
        text: () => explorationLabel(row().tools, completed()),
        onMouseOver: () => setHover(true),
        onMouseOut: () => setHover(false),
        onMouseUp: open.toggle
      }),
      mount(open.expanded, () => toolList(props, () => row().tools))
    ]
  });
}

/**
 * `Instructions: 2 files`, opening on click to the notice of each load, open from the start at
 * `high` verbosity (`InstructionsGroup`).
 */
function instructions(props: TranscriptProps, row: () => Row<'instructions'>): JSX.Element {
  const theme = props.theme;
  const open = disclosure(() => props.settings.session.verbosity === 'high');
  const [hover, setHover] = createSignal(false);
  return jsx('box', {
    flexDirection: 'column',
    flexShrink: 0,
    children: [
      inlineRow(props, {
        icon: () => '◈',
        color: () => (hover() ? theme().text.base : theme().text.muted),
        text: () => {
          const files = row().files.size;
          return `Instructions: ${files} ${files === 1 ? 'file' : 'files'}`;
        },
        onMouseOver: () => setHover(true),
        onMouseOut: () => setHover(false),
        onMouseUp: open.toggle
      }),
      mount(open.expanded, () =>
        createComponent(For, {
          get each() {
            // The host leaves out instruction loads with no description.
            return row().messages.filter((message) => message.description?.trim());
          },
          children: (message: Row<'instructions'>['messages'][number]) =>
            completionNotice(props, message)
        })
      )
    ]
  });
}

/**
 * At `low` verbosity, a run of tools, thoughts and instruction loads as one
 * `+ 3 commands, 1 edit, 2 thoughts` line that opens on click to the groups and calls inside it
 * (`ActivityGroup`).
 */
function activityGroup(props: TranscriptProps, row: () => Row<'activity'>): JSX.Element {
  const theme = props.theme;
  const open = disclosure(() => false);
  const [hover, setHover] = createSignal(false);
  const summary = createMemo(() => activitySummary(row()));
  return jsx('box', {
    flexDirection: 'column',
    flexShrink: 0,
    get visible() {
      return summary().label !== '';
    },
    children: [
      inlineRow(props, {
        icon: () => (open.expanded() ? '−' : '+'),
        color: () => (hover() ? theme().text.base : theme().text.muted),
        spinner: () => !open.expanded() && summary().active,
        text: () => summary().label,
        onMouseOver: () => setHover(true),
        onMouseOut: () => setHover(false),
        onMouseUp: open.toggle
      }),
      mount(open.expanded, () =>
        jsx('box', {
          flexDirection: 'column',
          gap: 1,
          marginTop: 1,
          children: keyedRows(
            props,
            () => row().children,
            (view) => jsx('box', { flexShrink: 0, children: view })
          )
        })
      )
    ]
  });
}

interface InlineRowInput {
  icon(): string;
  color(): RGBA;
  text(): string;
  iconColor?(): RGBA;
  /** Shows the spinner and `pending` (or the text) instead of the icon. */
  spinner?(): boolean;
  pending?(): string;
  failed?(): boolean;
  denied?(): boolean;
  error?(): string | undefined;
  errorExpanded?(): boolean;
  onMouseOver?(): void;
  onMouseOut?(): void;
  onMouseUp?(): void;
}

/** A 2-cell icon column and a wrapping label, 3 cells in (`InlineToolRow`). */
function inlineRow(props: TranscriptProps, input: InlineRowInput): JSX.Element {
  const theme = props.theme;
  const failed = () => input.failed?.() ?? false;
  const strike = () => (input.denied?.() ? TextAttributes.STRIKETHROUGH : 0);
  const color = () => (failed() ? theme().text.feedback.error.base : input.color());
  return jsx('box', {
    paddingLeft: 3,
    flexShrink: 0,
    ...(input.onMouseOver ? { onMouseOver: input.onMouseOver } : {}),
    ...(input.onMouseOut ? { onMouseOut: input.onMouseOut } : {}),
    ...(input.onMouseUp ? { onMouseUp: input.onMouseUp } : {}),
    children: [
      jsx('box', {
        flexDirection: 'row',
        children: [
          jsx('text', {
            width: ICON_WIDTH,
            flexShrink: 0,
            get fg() {
              return input.spinner?.() || failed() ? color() : (input.iconColor?.() ?? color());
            },
            get attributes() {
              return strike();
            },
            get children() {
              return input.spinner?.() ? props.spinner() : input.icon();
            }
          }),
          jsx('text', {
            flexGrow: 1,
            get fg() {
              return color();
            },
            get attributes() {
              return strike();
            },
            get children() {
              return input.spinner?.() ? (input.pending?.() ?? input.text()) : input.text();
            }
          })
        ]
      }),
      jsx('box', {
        paddingLeft: ICON_WIDTH,
        get visible() {
          return failed() && (input.errorExpanded?.() ?? false);
        },
        children: errorText(props, () => input.error?.() ?? '')
      })
    ]
  });
}

/** Text in the error color. */
function errorText(props: TranscriptProps, text: () => string): JSX.Element {
  return jsx('text', {
    get fg() {
      return props.theme().text.feedback.error.base;
    },
    get children() {
      return text();
    }
  });
}

/** A box indented by `cells`. */
function padded(cells: number, child: JSX.Element): JSX.Element {
  return jsx('box', { paddingLeft: cells, flexShrink: 0, children: child });
}

/** One tool call, drawn by its own view or the generic one (`ToolPart`). */
function toolView(props: TranscriptProps, part: Tool): JSX.Element {
  const input = toolInput(part);
  const metadata = toolMetadata(part);
  const text = (key: string) => {
    const value = input[key];
    return typeof value === 'string' ? value : undefined;
  };
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const path = (value: string | undefined) =>
    value === undefined ? '' : props.context.ui.format.path(value);
  const status = part.state.status;
  const where = text('path') ? `in ${path(text('path'))} ` : '';
  const matches = (value: number | undefined) =>
    value ? `(${value} ${value === 1 ? 'match' : 'matches'})` : '';

  switch (canonicalTool(part.name)) {
    case 'shell':
      return shellBlock(props, {
        part,
        command: text('command'),
        workdir: text('workdir'),
        status,
        background: status === 'completed' && metadata.status === 'running',
        output: typeof metadata.shellID === 'string' ? undefined : toolOutput(part)
      });
    case 'glob':
      return inlineTool(props, part, {
        icon: '✱',
        pending: 'Finding files…',
        complete: Boolean(text('pattern')),
        text: `Glob "${text('pattern') ?? ''}" ${where}${matches(count(metadata.count))}`
      });
    case 'grep':
      return inlineTool(props, part, {
        icon: '✱',
        pending: 'Searching content…',
        complete: Boolean(text('pattern')),
        text: `Grep "${text('pattern') ?? ''}" ${where}${matches(count(metadata.matches))}`
      });
    case 'read':
      return readTool(props, part, input, path);
    case 'webfetch':
      return inlineTool(props, part, {
        icon: '%',
        pending: 'Fetching from the web…',
        complete: Boolean(text('url')),
        text: `WebFetch ${text('url') ?? ''}`
      });
    case 'websearch': {
      const provider = typeof metadata.provider === 'string' ? metadata.provider : '';
      const name =
        provider === 'opencode'
          ? 'OpenCode'
          : `${provider.slice(0, 1).toUpperCase()}${provider.slice(1)}`;
      return inlineTool(props, part, {
        icon: '◈',
        pending: 'Searching web…',
        complete: Boolean(text('query')),
        text: `${name ? `Web Search via ${name}` : 'Web Search'} "${text('query') ?? ''}"`
      });
    }
    case 'write':
      if (status !== 'completed') {
        return inlineTool(props, part, {
          icon: '←',
          pending: 'Preparing write…',
          complete: Boolean(text('path')),
          text: `Write ${path(text('path'))}`
        });
      }
      return blockTool(props, {
        part,
        path: { label: '# Wrote', value: path(text('path')) },
        children: [
          jsx('line_number', {
            get fg() {
              return props.theme().text.muted;
            },
            minWidth: 3,
            paddingRight: 1,
            children: jsx('code', {
              conceal: false,
              get fg() {
                return props.theme().text.base;
              },
              filetype: filetype(text('path')),
              get syntaxStyle() {
                return props.syntax();
              },
              content: text('content') ?? ''
            })
          })
        ]
      });
    case 'edit': {
      const file = patchFiles(metadata.files)[0];
      const value = path(file?.path ?? text('path'));
      if (file) {
        return blockTool(props, {
          part,
          path: { label: '← Edit', value },
          children: [diffView(props, file)]
        });
      }
      return blockTool(props, {
        part,
        ...(text('path') ? { path: { label: '← Edit', value } } : { title: '# Preparing edit…' }),
        spinner: status === 'streaming'
      });
    }
    case 'patch':
      return patchTool(props, part, metadata, path);
    case 'todowrite': {
      const todos = parseTodos(input.todos);
      if (status === 'completed' && todos.length > 0) {
        return blockTool(props, {
          part,
          title: '# Todos',
          children: [
            jsx('box', {
              children: todos.map((todo) => {
                const fg = () =>
                  todo.status === 'in_progress'
                    ? props.theme().text.feedback.warning.base
                    : todo.status === 'cancelled'
                      ? props.theme().text.faint
                      : props.theme().text.muted;
                return jsx('box', {
                  flexDirection: 'row',
                  children: [
                    jsx('text', {
                      flexShrink: 0,
                      get fg() {
                        return fg();
                      },
                      children: `${todoMarker(todo.status)} `
                    }),
                    jsx('text', {
                      flexGrow: 1,
                      wrapMode: 'word',
                      get fg() {
                        return fg();
                      },
                      attributes: todo.status === 'cancelled' ? TextAttributes.STRIKETHROUGH : 0,
                      children: todo.content
                    })
                  ]
                });
              })
            })
          ]
        });
      }
      return inlineTool(props, part, {
        icon: '⚙',
        pending: 'Updating todos…',
        complete: status === 'completed' || status === 'error',
        text: status === 'error' ? 'Todo update failed' : 'Cleared todos'
      });
    }
    case 'question':
      return questionTool(props, part, input, metadata);
    case 'skill': {
      const name = typeof metadata.name === 'string' ? metadata.name : text('id');
      return inlineTool(props, part, {
        icon: '→',
        pending: 'Loading skill…',
        complete: Boolean(name),
        text: `Skill "${name ?? ''}"`
      });
    }
    case 'subagent':
      return subagentTool(props, part, input, metadata);
    case 'execute':
      return executeTool(props, part, metadata);
    default:
      return genericTool(props, part, input);
  }
}

interface InlineToolInput {
  icon: string;
  pending: string;
  complete: boolean;
  text: string;
  spinner?: boolean;
  /** Keeps a still-running call from showing a stale error. */
  running?: boolean;
  color?: RGBA;
  onClick?(): void;
}

// Errors the host shows struck through as a refusal instead of in the error color.
const DENIED = [
  'QuestionRejectedError',
  'rejected permission',
  'specified a rule',
  'user dismissed'
];

/** A tool call as one inline row that shows its error on click (`InlineTool`). */
function inlineTool(props: TranscriptProps, part: Tool, input: InlineToolInput): JSX.Element {
  const theme = props.theme;
  const [hover, setHover] = createSignal(false);
  const [errorExpanded, setErrorExpanded] = createSignal(false);
  const error =
    !input.running && part.state.status === 'error'
      ? stripAnsi(part.state.error.message)
      : undefined;
  const denied = Boolean(error && DENIED.some((item) => error.includes(item)));
  const failed = Boolean(error && !denied);
  const clickable = Boolean(input.onClick || failed);
  const loading = input.spinner ?? false;
  return inlineRow(props, {
    icon: () => input.icon,
    color: () => {
      if (input.color) return input.color;
      if (hover() && input.onClick) return theme().text.base;
      return theme().text.muted;
    },
    // Mirrors the host: a call neither complete nor failed shows the spinner with its pending text.
    spinner: () => loading || (!input.complete && !failed),
    pending: () => (loading ? input.text : input.pending),
    text: () => input.text,
    failed: () => failed,
    denied: () => denied,
    error: () => error,
    errorExpanded,
    onMouseOver: () => clickable && setHover(true),
    onMouseOut: () => setHover(false),
    onMouseUp: () => {
      if (failed) return setErrorExpanded((value) => !value);
      input.onClick?.();
    }
  });
}

interface BlockToolInput {
  part?: Tool;
  title?: string;
  path?: { label: string; value: string };
  headerColor?: RGBA;
  children?: JSX.Element[];
  onClick?(): void;
  spinner?: boolean;
  error?: string;
}

/** A raised block with a muted header, for writes, edits, todos and shells (`BlockTool`). */
function blockTool(props: TranscriptProps, input: BlockToolInput): JSX.Element {
  const theme = props.theme;
  const [hover, setHover] = createSignal(false);
  const error = stripAnsi(
    input.error ?? (input.part?.state.status === 'error' ? input.part.state.error.message : '')
  );
  // A spinning header drops the `# ` marker, as the host's Spinner label does.
  const label = input.path ? `${input.path.label} ${input.path.value}` : input.title;
  const header = () => (input.spinner ? `${props.spinner()} ${label?.replace(/^# /, '')}` : label);
  return jsx('box', {
    border: ['left'],
    flexShrink: 0,
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    paddingRight: 2,
    gap: 1,
    customBorderChars: SPLIT_BORDER,
    get borderColor() {
      return theme().background.base;
    },
    get backgroundColor() {
      const background = theme().background.raised.base;
      return hover() ? theme().decrease(background) : background;
    },
    onMouseOver: () => input.onClick && setHover(true),
    onMouseOut: () => setHover(false),
    onMouseUp: () => input.onClick?.(),
    children: [
      ...(label === undefined
        ? []
        : [
            jsx('text', {
              wrapMode: 'none',
              get fg() {
                return input.headerColor ?? theme().text.muted;
              },
              get children() {
                return header();
              }
            })
          ]),
      ...(input.children ?? []),
      ...(error ? [errorText(props, () => error)] : [])
    ]
  });
}

interface ShellInput {
  part?: Tool;
  command: string | undefined;
  workdir?: string | undefined;
  status: Tool['state']['status'];
  background?: boolean;
  output: string | undefined;
  error?: string | undefined;
}

/**
 * `$ command` and the tail of its output, at most 10 lines until clicked (`ShellDisplay`).
 * Output of a background shell is not fetched: the preview shows only what the call returned.
 */
function shellBlock(props: TranscriptProps, input: ShellInput): JSX.Element {
  const theme = props.theme;
  const [expanded, setExpanded] = createSignal(false);
  const running = input.status === 'running';
  const workdir = input.workdir ? props.context.ui.format.path(input.workdir) : '';
  const prefix = workdir && workdir !== '.' ? `cd ${workdir} && ` : '';
  const command = input.command ? `${running ? '' : '$ '}${prefix}${input.command}` : '';
  const output = input.status === 'streaming' ? '' : stripAnsi(input.output?.trim() ?? '');
  const collapsed = createMemo(() =>
    collapseShellOutput(
      command,
      output,
      SHELL_LINES,
      SHELL_LINES * Math.max(20, props.width() - 8 - (running ? 2 : 0))
    )
  );
  const shownOutput = () => (expanded() ? output : collapsed().output);
  const commandLine = jsx('text', {
    get fg() {
      return theme().text.base;
    },
    get wrapMode() {
      return expanded() ? 'word' : 'char';
    },
    get maxHeight() {
      return expanded() ? undefined : 2;
    },
    flexGrow: 1,
    minWidth: 0,
    get children() {
      return expanded() ? command : collapsed().input;
    }
  });
  const body = input.command
    ? [
        running
          ? jsx('box', {
              flexDirection: 'row',
              gap: 1,
              children: [
                jsx('text', {
                  flexShrink: 0,
                  get fg() {
                    return theme().text.base;
                  },
                  get children() {
                    return props.spinner();
                  }
                }),
                commandLine
              ]
            })
          : commandLine,
        jsx('text', {
          get visible() {
            return shownOutput().length > 0;
          },
          get fg() {
            return theme().text.muted;
          },
          get children() {
            return shownOutput();
          }
        })
      ]
    : [
        jsx('text', {
          get fg() {
            return theme().text.muted;
          },
          children: 'Writing command…'
        })
      ];
  if (input.background) {
    body.push(
      jsx('text', {
        flexShrink: 0,
        get bg() {
          return theme().decrease(theme().background.raised.base);
        },
        get fg() {
          return theme().text.muted;
        },
        children: ' Background '
      })
    );
  }
  return blockTool(props, {
    ...(input.part ? { part: input.part } : {}),
    ...(input.error ? { error: input.error } : {}),
    ...(collapsed().overflow ? { onClick: () => setExpanded((value) => !value) } : {}),
    children: [jsx('box', { gap: 1, children: body })]
  });
}

/** A `!command` the user ran from the prompt (`ShellMessage`). */
function shellMessage(props: TranscriptProps, row: () => Row<'shell'>): JSX.Element {
  return mount(
    () => row().message.status,
    () => {
      const message = row().message;
      const exit = message.exit;
      const error =
        message.status === 'killed'
          ? 'Command cancelled'
          : message.status === 'timeout'
            ? 'Command timed out'
            : exit !== undefined && exit !== 0
              ? `Command exited with code ${exit}`
              : undefined;
      return shellBlock(props, {
        command: message.command,
        status: message.status === 'running' ? 'running' : 'completed',
        output: message.output?.output,
        error
      });
    }
  );
}

/** `→ Read path:1-40`, plus the instruction files it loaded (`Read`). */
function readTool(
  props: TranscriptProps,
  part: Tool,
  input: Record<string, unknown>,
  path: (value: string | undefined) => string
): JSX.Element {
  const file = typeof input.path === 'string' ? input.path : undefined;
  const offset = typeof input.offset === 'number' ? input.offset : 0;
  const limit = typeof input.limit === 'number' ? input.limit : 0;
  const range =
    input.offset !== undefined || input.limit !== undefined
      ? `:${offset || 1}-${limit ? (offset || 1) + limit - 1 : ''}`
      : '';
  const loaded = toolMetadata(part).loaded;
  const files =
    part.state.status === 'completed' && Array.isArray(loaded)
      ? loaded.filter((item): item is string => typeof item === 'string')
      : [];
  return jsx('box', {
    flexShrink: 0,
    children: [
      inlineTool(props, part, {
        icon: '→',
        pending: 'Reading file…',
        complete: Boolean(file),
        spinner: part.state.status === 'running',
        text: `Read ${path(file)}${range}`
      }),
      ...files.map((item) =>
        padded(
          6,
          jsx('text', {
            get fg() {
              return props.theme().text.muted;
            },
            children: `↳ Loaded ${path(item)}`
          })
        )
      )
    ]
  });
}

/** A unified or split diff of one changed file, like the host's `PatchDiff` without virtualization. */
function diffView(props: TranscriptProps, file: PatchFile): JSX.Element {
  const theme = props.theme;
  return jsx('box', {
    paddingLeft: 1,
    paddingRight: 1,
    children: jsx('diff', {
      diff: file.patch,
      get view() {
        return props.width() > 120 ? 'split' : 'unified';
      },
      filetype: filetype(file.path),
      get syntaxStyle() {
        return props.syntax();
      },
      showLineNumbers: true,
      width: '100%',
      wrapMode: 'word',
      get fg() {
        return theme().text.base;
      },
      get addedBg() {
        return theme().diff.background.added;
      },
      get removedBg() {
        return theme().diff.background.removed;
      },
      get contextBg() {
        return theme().diff.background.context;
      },
      get addedSignColor() {
        return theme().diff.highlight.added;
      },
      get removedSignColor() {
        return theme().diff.highlight.removed;
      },
      get lineNumberFg() {
        return theme().diff.lineNumber.text;
      },
      get lineNumberBg() {
        return theme().diff.background.context;
      },
      get addedLineNumberBg() {
        return theme().diff.lineNumber.background.added;
      },
      get removedLineNumberBg() {
        return theme().diff.lineNumber.background.removed;
      }
    })
  });
}

/** One block per patched file, or a pending header while the patch streams (`ApplyPatch`). */
function patchTool(
  props: TranscriptProps,
  part: Tool,
  metadata: Record<string, unknown>,
  path: (value: string | undefined) => string
): JSX.Element {
  const files = patchFiles(metadata.files);
  if (files.length > 0) {
    return jsx('box', {
      flexDirection: 'column',
      gap: 1,
      children: files.map((file) =>
        blockTool(props, {
          part,
          path: {
            label:
              file.type === 'add'
                ? '# Created'
                : file.type === 'delete'
                  ? '# Deleted'
                  : '← Patched',
            value: path(file.path)
          },
          children: [
            file.type === 'delete'
              ? jsx('text', {
                  get fg() {
                    return props.theme().diff.text.removed;
                  },
                  children: `-${file.deletions} line${file.deletions === 1 ? '' : 's'}`
                })
              : diffView(props, file)
          ]
        })
      )
    });
  }
  const failed = part.state.status === 'error';
  const patch = toolInput(part).patchText;
  const targets =
    typeof patch === 'string'
      ? [...patch.matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^\r\n]+)/g)].map((match) =>
          (match[1] ?? '').trim()
        )
      : [];
  const label = failed ? '# Patch failed' : 'Patching';
  return blockTool(props, {
    part,
    ...(targets.length === 1 ? { path: { label, value: path(targets[0]) } } : { title: label }),
    spinner: part.state.status === 'streaming' || part.state.status === 'running',
    ...(failed ? { headerColor: props.theme().text.feedback.error.base } : {})
  });
}

/** Answered questions as a block, otherwise `→ Asked N questions` (`Question`). */
function questionTool(
  props: TranscriptProps,
  part: Tool,
  input: Record<string, unknown>,
  metadata: Record<string, unknown>
): JSX.Element {
  const questions = Array.isArray(input.questions)
    ? input.questions.flatMap((item: unknown) => {
        const question = (item as { question?: unknown } | null)?.question;
        return typeof question === 'string' ? [question] : [];
      })
    : [];
  const answers = Array.isArray(metadata.answers)
    ? metadata.answers.map((answer: unknown) =>
        Array.isArray(answer) ? answer.filter((item) => typeof item === 'string').join(', ') : ''
      )
    : undefined;
  if (answers) {
    return blockTool(props, {
      part,
      title: '# Questions',
      children: [
        jsx('box', {
          gap: 1,
          children: questions.map((question, index) =>
            jsx('box', {
              flexDirection: 'column',
              children: [
                jsx('text', {
                  get fg() {
                    return props.theme().text.muted;
                  },
                  children: question
                }),
                jsx('text', {
                  get fg() {
                    return props.theme().text.base;
                  },
                  children: answers[index] || '(no answer)'
                })
              ]
            })
          )
        })
      ]
    });
  }
  return inlineTool(props, part, {
    icon: '→',
    pending: 'Asking questions…',
    complete: questions.length > 0,
    text: `Asked ${questions.length} question${questions.length === 1 ? '' : 's'}`
  });
}

/**
 * One line naming the subagent and its task, with the host's exact label and its em dash
 * (`Subagent`, packages/tui/src/routes/session/index.tsx:3294).
 */
function subagentTool(
  props: TranscriptProps,
  part: Tool,
  input: Record<string, unknown>,
  metadata: Record<string, unknown>
): JSX.Element {
  const string = (value: unknown) => (typeof value === 'string' ? value : undefined);
  const childID =
    string(metadata.sessionID) ??
    (part.state.status === 'error' ? undefined : string(input.sessionID));
  const running =
    part.state.status === 'running' ||
    Boolean(childID && props.context.data.session.status(childID) === 'running');
  const continuation = Boolean(string(input.sessionID));
  const description = string(input.description);
  const agent = string(input.agent) ?? string(input.subagent_type) ?? 'General';
  const name = continuation ? 'Continue subagent' : `${titlecase(agent)} Subagent`;
  return inlineTool(props, part, {
    icon: running ? '│' : continuation ? '↳' : part.state.status === 'completed' ? '✓' : '│',
    pending: 'Delegating…',
    complete: Boolean(description),
    spinner: running,
    running,
    text: `${name} — ${description ?? 'Subagent'}`
  });
}

/** `execute` with one `› tool [args]` line per call it made (`Execute`, `ExecuteCallView`). */
function executeTool(
  props: TranscriptProps,
  part: Tool,
  metadata: Record<string, unknown>
): JSX.Element {
  const theme = props.theme;
  const status = part.state.status;
  const failed = metadata.error === true || status === 'error';
  const calls = Array.isArray(metadata.toolCalls)
    ? metadata.toolCalls.flatMap((call: unknown) => {
        const record = call as { tool?: unknown; status?: unknown; input?: unknown } | null;
        if (typeof record?.tool !== 'string') return [];
        const args =
          typeof record.input === 'object' && record.input !== null
            ? inputSummary(record.input as Record<string, unknown>).replace(/\s+/g, ' ')
            : '';
        return [
          { error: record.status === 'error', text: `${record.tool}${args ? ` ${args}` : ''}` }
        ];
      })
    : [];
  return jsx('box', {
    flexShrink: 0,
    children: [
      inlineTool(props, part, {
        icon: failed ? '✗' : status === 'completed' ? '✓' : '│',
        pending: 'execute',
        complete: true,
        spinner: status === 'streaming' || status === 'running',
        ...(failed ? { color: theme().text.feedback.error.base } : {}),
        text: 'execute'
      }),
      ...calls.map((call) =>
        jsx('box', {
          paddingLeft: 3,
          flexDirection: 'row',
          children: [
            jsx('text', {
              width: ICON_WIDTH,
              flexShrink: 0,
              get fg() {
                return call.error ? theme().text.feedback.error.base : theme().text.muted;
              },
              children: call.error ? '✗' : '›'
            }),
            jsx('text', {
              flexGrow: 1,
              wrapMode: 'none',
              truncate: true,
              get fg() {
                return call.error ? theme().text.feedback.error.base : theme().text.muted;
              },
              children: call.text
            })
          ]
        })
      )
    ]
  });
}

/** `✓ tool [key=value]`, opening to every input and the output on click (`GenericTool`). */
function genericTool(props: TranscriptProps, part: Tool, input: Record<string, unknown>) {
  const theme = props.theme;
  const [expanded, setExpanded] = createSignal(false);
  const output = stripAnsi(toolOutput(part)?.trim() ?? '');
  const entries = Object.entries(input);
  const args = inputSummary(input).replace(/\s+/g, ' ');
  const field = (key: string, value: string) =>
    jsx('box', {
      flexDirection: 'row',
      children: [
        jsx('text', {
          flexShrink: 0,
          get fg() {
            return theme().text.muted;
          },
          children: `${key}: `
        }),
        jsx('text', {
          flexGrow: 1,
          wrapMode: 'word',
          get fg() {
            return theme().text.base;
          },
          children: value
        })
      ]
    });
  return jsx('box', {
    flexShrink: 0,
    children: [
      inlineTool(props, part, {
        icon: part.state.status === 'error' ? '✗' : '✓',
        pending: part.name,
        complete: part.state.status === 'completed',
        spinner: part.state.status === 'streaming' || part.state.status === 'running',
        text: `${part.name}${args ? ` ${args}` : ''}`,
        ...(entries.length > 0 || output ? { onClick: () => setExpanded((value) => !value) } : {})
      }),
      mount(expanded, () =>
        jsx('box', {
          paddingLeft: 3 + ICON_WIDTH,
          children: [
            ...entries.map(([key, value]) =>
              field(key, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
            ),
            ...(output ? [field('output', output)] : [])
          ]
        })
      )
    ]
  });
}

/** Agent, model and turn duration under a finished turn, after its error if any (`AssistantFooter`). */
function footer(props: TranscriptProps, row: () => Row<'footer'>): JSX.Element {
  const theme = props.theme;
  const message = () => row().message;
  const interrupted = () => message().error?.message === 'Step interrupted';
  const failed = () => Boolean(message().error && !interrupted() && !message().retry);
  const muted = (text: string) =>
    jsx('span', { style: { fg: theme().text.muted }, children: text });
  return jsx('box', {
    flexDirection: 'column',
    flexShrink: 0,
    children: [
      jsx('box', {
        paddingLeft: 3,
        get visible() {
          return failed();
        },
        children: errorText(props, () => `Error: ${message().error?.message ?? ''}`)
      }),
      jsx('box', {
        paddingLeft: 3,
        get visible() {
          return message().retry !== undefined;
        },
        children: jsx('text', {
          get fg() {
            return theme().text.feedback.warning.base;
          },
          get children() {
            const retry = message().retry;
            return retry ? `⚠ Retry due · attempt ${retry.attempt} · ${retry.error.message}` : '';
          }
        })
      }),
      jsx('box', {
        paddingLeft: 3,
        get marginTop() {
          return message().retry || (message().error && !interrupted()) ? 1 : 0;
        },
        children: jsx('text', {
          get children() {
            const current = message();
            return [
              jsx('span', {
                style: {
                  fg: current.error ? theme().text.muted : props.agentColor(current.agent)
                },
                children: titlecase(current.agent)
              }),
              muted(` · ${props.modelName(current.model)}`),
              ...(row().duration ? [muted(` · ${formatDuration(row().duration)}`)] : []),
              ...(interrupted() ? [muted(' · interrupted')] : [])
            ];
          }
        })
      })
    ]
  });
}

/** Agent and model switches, moves, instruction and completion notices, skills. */
function notice(props: TranscriptProps, message: Row<'notice'>['message']): JSX.Element {
  const theme = props.theme;
  const muted = (text: string) =>
    padded(
      3,
      jsx('text', {
        get fg() {
          return theme().text.muted;
        },
        children: text
      })
    );
  switch (message.type) {
    case 'agent-switched': {
      // `SessionSwitchMessageV2`
      const agent = titlecase(message.agent);
      return muted(
        message.previous && message.previous !== message.agent
          ? `Switched agent from ${titlecase(message.previous)} to ${agent}`
          : `Switched agent to ${agent}`
      );
    }
    case 'model-switched': {
      // `switchLabel` in packages/tui/src/util/model.ts
      const model = message.model;
      if (message.previous?.providerID === model.providerID && message.previous.id === model.id) {
        return muted(`Switched variant to ${model.variant ?? 'default'}`);
      }
      const variant = model.variant && model.variant !== 'default' ? ` (${model.variant})` : '';
      return muted(`Switched model to ${props.modelName(model)}${variant}`);
    }
    case 'location-switched':
      return padded(
        3,
        jsx('text', {
          get children() {
            return [
              jsx('span', { style: { fg: theme().text.muted }, children: '↳ Moved to ' }),
              jsx('span', {
                style: { fg: theme().text.feedback.info.base },
                children: message.location.directory
              })
            ];
          }
        })
      );
    case 'skill':
      return inlineRow(props, {
        icon: () => '→',
        color: () => theme().text.muted,
        text: () => `Skill ${message.name}`
      });
    default:
      return completionNotice(props, message);
  }
}

/**
 * `↳ Shell finished · description` for a background shell or subagent that completed, otherwise
 * the notice text after a `◈` (`SessionNoticeMessageV2`).
 */
function completionNotice(
  props: TranscriptProps,
  message: Extract<SessionMessageInfo, { type: 'synthetic' | 'system' }>
): JSX.Element {
  const theme = props.theme;
  const metadata = message.type === 'synthetic' ? (message.metadata ?? {}) : {};
  const string = (value: unknown) => (typeof value === 'string' ? value : undefined);
  const source = string(metadata.source);
  const text =
    message.type === 'system'
      ? (message.description ?? 'Instructions updated')
      : (message.description ?? '');
  if (source !== 'subagent' && source !== 'shell') {
    return inlineRow(props, {
      icon: () => (source === 'goal' ? '◎' : '◈'),
      color: () => theme().text.muted,
      text: () => text
    });
  }
  const state = string(metadata.state);
  const actor = source === 'shell' ? 'Shell' : titlecase(string(metadata.agent) ?? 'Subagent');
  const word =
    state === 'completed' ? 'finished' : state === 'error' ? 'failed' : (state ?? 'finished');
  const heading = `${state === 'completed' ? '↳' : '!'} ${actor} ${word}`;
  const description = source === 'shell' ? text.replace(/\s+/g, ' ').trim() : text;
  return jsx('box', {
    marginLeft: 3,
    children: jsx('text', {
      wrapMode: 'none',
      get children() {
        const color =
          state === 'error'
            ? theme().text.feedback.error.base
            : state === 'cancelled'
              ? theme().text.feedback.warning.base
              : theme().text.feedback.info.base;
        return [
          jsx('span', { style: { fg: color }, children: heading }),
          jsx('span', { style: { fg: theme().text.muted }, children: ` · ${description}` })
        ];
      }
    })
  });
}

/** A rule with `Compaction` in its middle, then the summary as markdown (`CompactionMessage`). */
function compaction(props: TranscriptProps, row: () => Row<'compaction'>): JSX.Element {
  const theme = props.theme;
  const message = () => row().message;
  const cancelled = () => {
    const current = message();
    return current.status === 'failed' && current.error.type === 'aborted';
  };
  const color = () =>
    message().status === 'failed' && !cancelled()
      ? theme().text.feedback.error.base
      : theme().text.muted;
  const content = () => {
    const current = message();
    if (current.status === 'failed') return cancelled() ? '' : current.error.message.trim();
    return current.summary.trim();
  };
  const label = () => {
    const current = message();
    const parts = [
      current.status === 'completed' && current.native?.messages
        ? 'Provider compaction'
        : 'Compaction'
    ];
    if (cancelled()) parts.push('cancelled');
    const tokens = current.status === 'running' ? undefined : current.tokens;
    if (tokens) {
      const input = tokens.input + tokens.cache.read + tokens.cache.write;
      const output = tokens.output + tokens.reasoning;
      if (input + output > 0) parts.push(`${compact(input)} in · ${compact(output)} out`);
    }
    const lead =
      current.status === 'running'
        ? `${props.spinner()} `
        : current.status === 'failed' && !cancelled()
          ? '✗ '
          : '';
    return `${lead}${parts.join(' · ')}`;
  };
  const rule = () =>
    jsx('box', {
      border: ['top'],
      flexGrow: 1,
      get borderColor() {
        return color();
      }
    });
  return jsx('box', {
    flexShrink: 0,
    children: [
      jsx('box', {
        flexDirection: 'row',
        alignItems: 'center',
        children: [
          rule(),
          jsx('box', {
            paddingLeft: 1,
            paddingRight: 1,
            children: jsx('text', {
              get fg() {
                return color();
              },
              get children() {
                return label();
              }
            })
          }),
          rule()
        ]
      }),
      jsx('box', {
        paddingTop: 1,
        paddingLeft: 3,
        get visible() {
          return content().length > 0;
        },
        children: jsx('markdown', {
          get syntaxStyle() {
            return props.syntax();
          },
          get content() {
            return content();
          },
          internalBlockMode: 'top-level',
          tableOptions: { style: 'grid', cellPaddingX: 1 },
          get conceal() {
            return concealed(props);
          },
          get fg() {
            return theme().markdown.text;
          },
          get bg() {
            return theme().background.base;
          }
        })
      })
    ]
  });
}

/** `12.3K`-style token counts (`Locale.number` in packages/tui/src/util/locale.ts, MIT). */
function compact(count: number): string {
  if (count >= 999_950) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return String(count);
}
