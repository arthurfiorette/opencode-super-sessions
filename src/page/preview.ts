import path from 'node:path';
import type { SessionInfo, SessionMessageInfo } from '@opencode/client';
import type { Plugin } from '@opencode/plugin/tui';
import { generateSyntax } from '@opencode/theme/tui';
import {
  type MouseEvent,
  type RGBA,
  type ScrollBoxRenderable,
  type SyntaxStyle,
  TextAttributes
} from '@opentui/core';
import { jsx } from '@opentui/solid/jsx-runtime';
import {
  createComponent,
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup
} from 'solid-js';
import { createStore } from 'solid-js/store';
import type { Options } from '../config.js';
import { type Ref, refKey } from '../refs/ref.js';
import { trackedRefs } from '../refs/summary.js';
import type { SessionRefView } from '../rpc.js';
import { refColor, refIcon, STATE_WORDS } from './icons.js';
import { cells, fitText, formatAge, formatCost } from './row.js';

/** Inputs of the preview pane. */
export interface PreviewProps {
  context: Plugin.Context;
  options: Options;
  /** Selected session id. The pane follows it after a short delay. */
  selected(): string | undefined;
  session(sessionID: string): SessionInfo | undefined;
  refs(sessionID: string): SessionRefView | undefined;
  branch(session: SessionInfo): string | undefined;
  running(sessionID: string): boolean;
  /** Cells available for text inside the pane. */
  width(): number;
}

const FOLLOW_DELAY = 150;
const PAGE_SIZE = 30;

type Block =
  | { kind: 'label'; text: string }
  | { kind: 'markdown'; text: string }
  | { kind: 'tool'; text: string };

/** Right-hand pane: session summary, refs and a scrollable transcript. */
export function Preview(props: PreviewProps): JSX.Element {
  const context = props.context;
  const theme = () => context.theme;
  const [shown, setShown] = createSignal(props.selected());
  let follow: ReturnType<typeof setTimeout> | undefined;
  // Moving through the list quickly would otherwise fetch a transcript for every row passed.
  createEffect(
    on(
      () => props.selected(),
      (id) => {
        clearTimeout(follow);
        follow = setTimeout(() => setShown(id), FOLLOW_DELAY);
      },
      { defer: true }
    )
  );
  onCleanup(() => clearTimeout(follow));

  const session = createMemo(() => {
    const id = shown();
    return id === undefined ? undefined : props.session(id);
  });
  const transcript = createTranscript(context, shown);
  const syntax = createSyntax(context);
  const refLines = createMemo(() => {
    const id = shown();
    const view = id === undefined ? undefined : props.refs(id);
    return view === undefined ? [] : groupRefs(view);
  });

  const line = (children: () => string, fg: () => string | RGBA, attributes = 0) =>
    jsx('text', {
      height: 1,
      flexShrink: 0,
      wrapMode: 'none',
      attributes,
      get visible() {
        return children().trim().length > 0;
      },
      get fg() {
        return fg();
      },
      get children() {
        return fitText(children(), props.width());
      }
    });

  const muted = () => theme().text.muted;
  const header = [
    line(
      () => session()?.title || 'Untitled session',
      () => theme().text.base,
      TextAttributes.BOLD
    ),
    line(() => {
      const current = session();
      return current ? `  ${placeOf(context, current)}` : '';
    }, muted),
    line(() => {
      const current = session();
      if (!current) return '';
      const model = current.model ? modelName(context, current) : undefined;
      return `  ${[props.branch(current), model, current.agent].filter(Boolean).join(' · ')}`;
    }, muted),
    line(() => {
      const current = session();
      if (!current) return '';
      const live = context.data.session.get(current.id) ?? current;
      const running = props.running(current.id);
      return [
        `${formatTokens(totalTokens(live))} tokens`,
        formatCost(live.cost) || '$0.00',
        running
          ? `running ${formatAge(Date.now() - (live.time.busy ?? live.time.updated))}`
          : 'idle'
      ].join(' · ');
    }, muted)
  ];

  const refs = createComponent(For, {
    get each() {
      return refLines();
    },
    children: (entry: RefLine) =>
      jsx('text', {
        height: 1,
        flexShrink: 0,
        wrapMode: 'none',
        get children() {
          if (entry.kind === 'label') {
            return jsx('span', { style: { fg: muted() }, children: entry.text });
          }
          const fg = refColor(props.options, entry.status, theme(), context.themeMode);
          const indent = entry.nested ? '    ' : '  ';
          const number = `${refIcon(entry.ref.kind, entry.status)} #${entry.ref.number}`;
          const rest = `  ${entry.status ? STATE_WORDS[entry.status] : 'unknown'}  ${entry.title}`;
          return [
            jsx('span', { style: { fg: muted() }, children: indent }),
            jsx('span', { style: { fg }, children: number }),
            jsx('span', {
              style: { fg: muted() },
              children: fitText(rest, props.width() - cells(indent + number))
            })
          ];
        }
      })
  });

  let scroll: ScrollBoxRenderable | undefined;
  // A new session starts at its latest message, like the session view does.
  createEffect(
    on(
      () => transcript.state.sessionID,
      () => scroll?.scrollTo(Number.POSITIVE_INFINITY),
      { defer: true }
    )
  );

  const blocks = createMemo(() => toBlocks(transcript.state.messages));
  const body = createComponent(For, {
    get each() {
      return blocks();
    },
    children: (block: Block) => {
      if (block.kind === 'markdown') {
        return jsx('box', {
          paddingLeft: 2,
          flexShrink: 0,
          children: jsx('markdown', {
            get syntaxStyle() {
              return syntax();
            },
            content: block.text,
            conceal: true,
            get fg() {
              return theme().markdown.text;
            }
          })
        });
      }
      const indent = block.kind === 'tool' ? 2 : 0;
      return jsx('box', {
        flexShrink: 0,
        paddingLeft: indent,
        children: jsx('text', {
          wrapMode: 'none',
          attributes: block.kind === 'label' ? TextAttributes.BOLD : 0,
          get fg() {
            return block.kind === 'label' ? theme().text.base : theme().text.muted;
          },
          get children() {
            return fitText(block.text, props.width() - indent);
          }
        })
      });
    }
  });

  return jsx('box', {
    flexDirection: 'column',
    flexGrow: 1,
    minWidth: 0,
    paddingLeft: 1,
    paddingRight: 1,
    get visible() {
      return session() !== undefined;
    },
    children: [
      ...header,
      jsx('box', {
        flexShrink: 0,
        paddingTop: 1,
        get visible() {
          return refLines().length > 0;
        },
        children: refs
      }),
      jsx('box', {
        height: 1,
        flexShrink: 0,
        border: ['bottom'],
        get borderColor() {
          return theme().border.base;
        }
      }),
      jsx('text', {
        flexShrink: 0,
        get visible() {
          return transcript.state.status !== 'ready' || transcript.state.messages.length === 0;
        },
        get fg() {
          return transcript.state.status === 'error' ? theme().text.feedback.error.base : muted();
        },
        get children() {
          if (transcript.state.status === 'loading') return 'Loading messages…';
          if (transcript.state.status === 'error') return 'Could not load messages.';
          return 'No messages yet';
        }
      }),
      jsx('scrollbox', {
        flexGrow: 1,
        stickyScroll: true,
        stickyStart: 'bottom',
        scrollbarOptions: { visible: false },
        ref: (value: ScrollBoxRenderable) => {
          scroll = value;
        },
        onMouseScroll: (event: MouseEvent) => {
          // Older pages load when the wheel reaches the top, which is the only way to scroll
          // here: the keyboard belongs to the session list.
          if (event.scroll?.direction !== 'up' || !scroll || scroll.scrollTop > 1) return;
          const box = scroll;
          const before = box.scrollHeight;
          void transcript.older().then((added) => {
            if (added) box.afterLayout(() => box.scrollTo(box.scrollHeight - before));
          });
        },
        children: body
      })
    ]
  });
}

/** Transcript pages of the shown session, newest page first from the server. */
function createTranscript(context: Plugin.Context, shown: () => string | undefined) {
  const [state, setState] = createStore<{
    sessionID: string | undefined;
    messages: SessionMessageInfo[];
    cursor: string | undefined;
    status: 'loading' | 'ready' | 'error';
  }>({ sessionID: undefined, messages: [], cursor: undefined, status: 'loading' });
  let token = 0;
  let loadingOlder = false;

  const latest = async (sessionID: string | undefined) => {
    const current = ++token;
    if (sessionID === undefined) {
      setState({ sessionID, messages: [], cursor: undefined, status: 'ready' });
      return;
    }
    if (state.sessionID !== sessionID) {
      setState({ sessionID, messages: [], cursor: undefined, status: 'loading' });
    }
    try {
      const page = await context.client.message.list({
        sessionID,
        order: 'desc',
        limit: PAGE_SIZE
      });
      if (current !== token) return;
      setState({
        sessionID,
        messages: [...page.data].reverse(),
        cursor: page.cursor.next ?? undefined,
        status: 'ready'
      });
    } catch {
      if (current === token) setState('status', 'error');
    }
  };

  createEffect(on(shown, (id) => void latest(id)));
  let reload: ReturnType<typeof setTimeout> | undefined;
  const changed = (event: { data: { sessionID: string } }) => {
    if (event.data.sessionID !== state.sessionID) return;
    clearTimeout(reload);
    reload = setTimeout(() => void latest(state.sessionID), 300);
  };
  const offs = [
    context.data.on('session.text.ended', changed),
    context.data.on('session.execution.succeeded', changed),
    context.data.on('session.execution.failed', changed),
    context.data.on('session.execution.interrupted', changed),
    context.data.on('session.inbox.delivered', changed)
  ];
  onCleanup(() => {
    clearTimeout(reload);
    for (const off of offs) off();
  });

  return {
    state,
    /** Prepends the next older page. Resolves true when messages were added. */
    async older(): Promise<boolean> {
      const sessionID = state.sessionID;
      const cursor = state.cursor;
      if (sessionID === undefined || cursor === undefined || loadingOlder) return false;
      loadingOlder = true;
      try {
        const page = await context.client.message.list({
          sessionID,
          order: 'desc',
          limit: PAGE_SIZE,
          cursor
        });
        if (state.sessionID !== sessionID) return false;
        setState({
          messages: [...[...page.data].reverse(), ...state.messages],
          cursor: page.cursor.next ?? undefined
        });
        return page.data.length > 0;
      } catch {
        return false;
      } finally {
        loadingOlder = false;
      }
    }
  };
}

/**
 * Markdown syntax style for the current theme. A replaced style is destroyed only after the
 * renderer goes idle, because a frame in flight may still draw with it (same as the host).
 */
function createSyntax(context: Plugin.Context) {
  const retained = new Set<SyntaxStyle>();
  let current: SyntaxStyle | undefined;
  const release = (style: SyntaxStyle) => {
    retained.add(style);
    void context.renderer
      .idle()
      .catch(() => {})
      .finally(() => {
        if (!retained.delete(style)) return;
        style.destroy();
      });
  };
  onCleanup(() => {
    if (current) release(current);
  });
  return createMemo(() => {
    const previous = current;
    current = generateSyntax(context.theme, context.renderer.nativeScene);
    if (previous) release(previous);
    return current;
  });
}

/** Turns messages into labeled text, markdown and one-line tool blocks. */
function toBlocks(messages: readonly SessionMessageInfo[]): Block[] {
  const blocks: Block[] = [];
  let speaker: string | undefined;
  const say = (who: string) => {
    if (speaker === who) return;
    speaker = who;
    blocks.push({ kind: 'label', text: who });
  };
  for (const message of messages) {
    if (message.type === 'user') {
      if (!message.text.trim()) continue;
      say('you');
      blocks.push({ kind: 'markdown', text: message.text });
    } else if (message.type === 'shell') {
      say('you');
      blocks.push({ kind: 'tool', text: `▸ shell  ${firstLine(message.command)}` });
    } else if (message.type === 'assistant') {
      for (const part of message.content) {
        if (part.type === 'text' && part.text.trim()) {
          say('assistant');
          blocks.push({ kind: 'markdown', text: part.text });
        } else if (part.type === 'tool') {
          say('assistant');
          blocks.push({ kind: 'tool', text: toolSummary(part.name, part.state.input) });
        }
      }
    }
  }
  return blocks;
}

// Input fields that best describe a tool call, in the order they are tried.
const SUMMARY_FIELDS = ['command', 'filePath', 'path', 'pattern', 'query', 'url', 'description'];

/** One line describing a tool call: its name and its most telling argument. */
function toolSummary(name: string, input: unknown): string {
  const record =
    typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const value = SUMMARY_FIELDS.map((field) => record[field]).find(
    (item): item is string => typeof item === 'string' && item.trim().length > 0
  );
  return value === undefined ? `▸ ${name}` : `▸ ${name}  ${firstLine(value)}`;
}

/** First non-empty line, trimmed. */
export function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((item) => item.trim())
      .find((item) => item.length > 0) ?? ''
  );
}

type RefLine =
  | { kind: 'label'; text: string }
  | {
      kind: 'ref';
      ref: Ref;
      status: SessionRefView['states'][string]['status'] | undefined;
      title: string;
      nested: boolean;
    };

/** Tracked refs with the issues each PR closes nested under it, then mentioned refs. */
function groupRefs(view: SessionRefView): RefLine[] {
  const entry = (ref: Ref, nested: boolean): RefLine => {
    const state = view.states[refKey(ref)];
    return { kind: 'ref', ref, status: state?.status, title: state?.title ?? '', nested };
  };
  const tracked = trackedRefs(view);
  const trackedKeys = new Set(tracked.map(refKey));
  const prs = tracked.filter((ref) => ref.kind === 'pr');
  const nestedKeys = new Set<string>();
  const lines: RefLine[] = [];
  for (const pr of prs) {
    lines.push(entry(pr, false));
    const key = refKey(pr);
    const closes = new Map<string, Ref>();
    for (const ref of view.states[key]?.closes ?? []) closes.set(refKey(ref), ref);
    for (const link of view.links) {
      if (link.source === 'closes' && link.via === key) closes.set(refKey(link.ref), link.ref);
    }
    for (const [issueKey, ref] of closes) {
      if (nestedKeys.has(issueKey)) continue;
      nestedKeys.add(issueKey);
      lines.push(entry(ref, true));
    }
  }
  for (const ref of tracked) {
    if (ref.kind === 'issue' && !nestedKeys.has(refKey(ref))) lines.push(entry(ref, false));
  }
  const mentioned = view.links.filter(
    (link) =>
      link.source === 'mention' &&
      !trackedKeys.has(refKey(link.ref)) &&
      !nestedKeys.has(refKey(link.ref))
  );
  if (mentioned.length > 0) {
    lines.push({ kind: 'label', text: 'mentioned' });
    for (const link of mentioned) lines.push(entry(link.ref, false));
  }
  return lines;
}

/** Project name and the session directory relative to the project root. */
function placeOf(context: Plugin.Context, session: SessionInfo): string {
  const project = context.data.project.get(session.projectID);
  const directory = session.location.directory;
  if (!project || project.canonical === '/') return context.ui.format.path(directory);
  const name = project.name || path.basename(project.canonical);
  const relative = path.relative(project.canonical, directory);
  if (!relative) return name;
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return `${name}   ${context.ui.format.path(directory)}`;
  }
  return `${name}   ${relative}`;
}

/** Display name of the session's model, falling back to its id. */
function modelName(context: Plugin.Context, session: SessionInfo): string | undefined {
  const model = session.model;
  if (!model) return undefined;
  const known = context.data.location.model
    .list(session.location)
    ?.find((item) => item.id === model.id && item.providerID === model.providerID);
  return known?.name ?? model.id;
}

/** Every token the session used, cache included. */
function totalTokens(session: SessionInfo): number {
  const tokens = session.tokens;
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;
}

/** Compact token count: `950`, `142k`, `1.2M`. */
function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1000) return `${Math.round(count / 1000)}k`;
  return String(count);
}
