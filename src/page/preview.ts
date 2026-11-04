import type { SessionInfo, SessionMessageInfo } from '@opencode/client';
import type { Plugin } from '@opencode/plugin/tui';
import { generateSyntax, type ResolvedTheme } from '@opencode/theme/tui';
import {
  type MouseEvent,
  RGBA,
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
import { createMarquee } from '../marquee.js';
import type { SessionRefView } from '../rpc.js';
import { PreviewHeader } from './preview-header.js';
import { fitText } from './row.js';

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
  /**
   * Theme of the surface the pane draws on, such as `context.theme.surface('dialog')` inside a
   * modal, so raised boxes and markdown backgrounds match it. Defaults to `context.theme`.
   */
  theme?(): ResolvedTheme;
}

const FOLLOW_DELAY = 150;
const PAGE_SIZE = 30;
const SPINNER_INTERVAL = 80;

type Block =
  | { kind: 'label'; text: string }
  | { kind: 'markdown'; text: string }
  | { kind: 'tool'; text: string };

/** Right-hand pane: session summary, refs and a scrollable transcript. */
export function Preview(props: PreviewProps): JSX.Element {
  const context = props.context;
  const theme = () => props.theme?.() ?? context.theme;
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
  const running = () => {
    const id = shown();
    return id !== undefined && props.running(id);
  };
  // One spinner clock for the whole pane, ticking only while the shown session runs, so an idle
  // preview or a closed pane keeps no timer.
  const [frame, setFrame] = createSignal(0);
  createEffect(() => {
    if (!running()) return;
    const timer = setInterval(() => setFrame((value) => value + 1), SPINNER_INTERVAL);
    onCleanup(() => clearInterval(timer));
  });
  const marquee = createMarquee();
  // The hovered line may be replaced without a mouse-out when the pane follows another row, so
  // a scroll in progress stops here instead of carrying over to the next session's title.
  createEffect(on(shown, () => marquee.leave(marquee.active() ?? '')));

  const transcript = createTranscript(context, shown);
  const syntax = createSyntax(context, theme);
  const muted = () => theme().text.muted;

  const header = createComponent(PreviewHeader, {
    context,
    options: props.options,
    theme,
    session,
    refs: () => {
      const id = shown();
      return id === undefined ? undefined : props.refs(id);
    },
    branch: (value: SessionInfo) => props.branch(value),
    running,
    frame,
    width: () => props.width(),
    marquee,
    agentColor: (value: SessionInfo, agent: string) => agentColor(context, theme(), value, agent)
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
      header,
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

/**
 * Color of an agent's name: its configured color, else the categorical palette by its position
 * among visible agents, like the host's `local.agent.color` (packages/tui/src/context/local.tsx,
 * MIT). The classic design reads step 200 of each categorical hue.
 */
function agentColor(
  context: Plugin.Context,
  theme: ResolvedTheme,
  session: SessionInfo,
  agent: string
): RGBA {
  const agents = (context.data.location.agent.list(session.location) ?? []).filter(
    (item) => !item.hidden
  );
  const palette: RGBA[] = [];
  for (const scale of theme.categorical) {
    if (!palette.some((color) => color.equals(scale[200]))) palette.push(scale[200]);
  }
  const index = agents.findIndex((item) => item.id === agent);
  const found = agents[index];
  if (found?.color) return RGBA.fromHex(found.color);
  return palette[index === -1 ? 0 : index % palette.length] ?? theme.text.base;
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
function createSyntax(context: Plugin.Context, theme: () => ResolvedTheme) {
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
    current = generateSyntax(theme(), context.renderer.nativeScene);
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
