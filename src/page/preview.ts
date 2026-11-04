import type { SessionInfo, SessionMessageInfo } from '@opencode/client';
import type { Plugin } from '@opencode/plugin/tui';
import { generateSyntax, type ResolvedTheme } from '@opencode/theme/tui';
import { type MouseEvent, RGBA, type ScrollBoxRenderable, SyntaxStyle } from '@opentui/core';
import { jsx } from '@opentui/solid/jsx-runtime';
import {
  createComponent,
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  on,
  onCleanup
} from 'solid-js';
import { createStore } from 'solid-js/store';
import { useCliSettings } from '../cli-settings.js';
import type { Options } from '../config.js';
import { createMarquee } from '../marquee.js';
import type { SessionRefView } from '../rpc.js';
import { PreviewHeader, SPINNER } from './preview-header.js';
import { Transcript } from './transcript.js';
import { transcriptRows } from './transcript-model.js';

/** Inputs of the preview pane. */
export interface PreviewProps {
  context: Plugin.Context;
  options: Options;
  /** Selected session id. The pane follows it after a short delay. */
  selected(): string | undefined;
  session(sessionID: string): SessionInfo | undefined;
  refs(sessionID: string): SessionRefView | undefined;
  branch(session: SessionInfo): string | undefined;
  /**
   * The project the browser lists, or undefined while it lists every project. The header names
   * a session's project only when it differs from this one.
   */
  project?(): string | undefined;
  running(sessionID: string): boolean;
  /** `refKey` of the Work row the keyboard selected, while the pane has the focus. */
  selectedRef?(): string | undefined;
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
  const settings = useCliSettings();
  // One spinner clock for the whole pane, ticking only while the shown session runs, so an idle
  // preview or a closed pane keeps no timer. With animations off it stops, and the spinner
  // stands still as `⋯`, like the host's.
  const [frame, setFrame] = createSignal(0);
  createEffect(() => {
    if (!running() || !settings.animations) return;
    const timer = setInterval(() => setFrame((value) => value + 1), SPINNER_INTERVAL);
    onCleanup(() => clearInterval(timer));
  });
  const spinner = () => (settings.animations ? (SPINNER[frame() % SPINNER.length] ?? '') : '⋯');
  const marquee = createMarquee({ animated: () => settings.animations });
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
    messages: () => transcript.state.messages,
    branch: (value: SessionInfo) => props.branch(value),
    project: () => props.project?.(),
    running,
    spinner,
    selectedRef: () => props.selectedRef?.(),
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

  const rows = createMemo(() =>
    transcriptRows(transcript.state.messages, settings.session.verbosity)
  );
  const body = createComponent(Transcript, {
    context,
    theme,
    rows,
    syntax: () => syntax().markdown,
    thinking: () => syntax().thinking,
    width: () => props.width(),
    spinner,
    settings,
    agentColor: (agent: string) => {
      const current = session();
      return current ? agentColor(context, theme(), current, agent) : theme().text.muted;
    },
    modelName: (model: { providerID: string; id: string }) => {
      const current = session();
      const known = current
        ? context.data.location.model
            .list(current.location)
            ?.find((item) => item.id === model.id && item.providerID === model.providerID)
        : undefined;
      // Same fallback as the host's footer when the model is not in the catalog.
      return known?.name ?? `${model.providerID}/${model.id}`;
    },
    agent: () => session()?.agent ?? 'build'
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
      jsx('box', { height: 1, flexShrink: 0 }),
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
        // The host's session transcript bar (routes/session/index.tsx), under the same setting.
        get viewportOptions() {
          return { paddingRight: settings.session.scrollbar ? 1 : 0 };
        },
        get verticalScrollbarOptions() {
          return {
            paddingLeft: 1,
            visible: settings.session.scrollbar,
            trackOptions: {
              backgroundColor: theme().decrease(theme().background.raised.base),
              foregroundColor: theme().border.base
            }
          };
        },
        horizontalScrollbarOptions: { visible: false },
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
        // The cursor carries the first page's order; the API rejects `order` next to it.
        const page = await context.client.message.list({ sessionID, limit: PAGE_SIZE, cursor });
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

interface Syntax {
  markdown: SyntaxStyle;
  /** The same styles in the muted color, for thoughts (routes/session/thinking-syntax.ts, MIT). */
  thinking: SyntaxStyle;
}

/**
 * Syntax styles for the current theme, one set per pane, never per session. A replaced set is
 * destroyed only after the renderer goes idle, because a frame in flight may still draw with it
 * (same as the host's `createSyntaxStyleMemo`).
 */
function createSyntax(context: Plugin.Context, theme: () => ResolvedTheme) {
  const retained = new Set<SyntaxStyle>();
  let current: Syntax | undefined;
  const release = (syntax: Syntax) => {
    const styles = [syntax.markdown, syntax.thinking];
    for (const style of styles) retained.add(style);
    void context.renderer
      .idle()
      .catch(() => {})
      .finally(() => {
        for (const style of styles) if (retained.delete(style)) style.destroy();
      });
  };
  onCleanup(() => {
    if (current) release(current);
  });
  return createMemo(() => {
    const previous = current;
    const owner = context.renderer.nativeScene;
    const markdown = generateSyntax(theme(), owner);
    const muted = theme().text.muted;
    const thinking = SyntaxStyle.fromStyles(
      Object.fromEntries(
        markdown
          .getRegisteredNames()
          .map((name) => [name, { ...markdown.getStyle(name), fg: muted }])
      ),
      owner
    );
    current = { markdown, thinking };
    if (previous) release(previous);
    return current;
  });
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
