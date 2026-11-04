import path from 'node:path';
import type { SessionInfo, SessionMessageAssistant, SessionMessageInfo } from '@opencode/client';
import type { Plugin } from '@opencode/plugin/tui';
import type { ResolvedTheme } from '@opencode/theme/tui';
import type { RGBA } from '@opentui/core';
import { jsx } from '@opentui/solid/jsx-runtime';
import { createComponent, createMemo, For, type JSX, Show, untrack } from 'solid-js';
import type { Options } from '../config.js';
import { type createMarquee, marqueeText } from '../marquee.js';
import { type Ref, refKey } from '../refs/ref.js';
import { trackedRefs } from '../refs/summary.js';
import type { SessionRefView } from '../rpc.js';
import { workRow } from '../work-row.js';
import { fitText } from './row.js';

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// The host sidebar's Context section formats cost this way (feature-plugins/sidebar/context.tsx).
const MONEY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
// Context and Session sit side by side, this far apart, while each column gets this many cells.
const SECTION_GAP = 2;
const MIN_SECTION_WIDTH = 24;

/** Inputs of the header, a subset of the pane's own. */
export interface HeaderProps {
  context: Plugin.Context;
  options: Options;
  theme(): ResolvedTheme;
  session(): SessionInfo | undefined;
  /** Loaded messages of the session, newest last, for the context window usage. */
  messages(): readonly SessionMessageInfo[];
  refs(): SessionRefView | undefined;
  branch(session: SessionInfo): string | undefined;
  /** The browser's project, or undefined while it lists every project. */
  project(): string | undefined;
  running(): boolean;
  /** Current spinner glyph, ticking only while the session runs. */
  spinner(): string;
  /** `refKey` of the Work row the keyboard selected, if any. */
  selectedRef(): string | undefined;
  width(): number;
  marquee: ReturnType<typeof createMarquee>;
}

/**
 * Laid out like the host's session sidebar (routes/session/sidebar.tsx and the sections in
 * feature-plugins/sidebar, MIT): the bold title, wrapping, then sections one blank line apart,
 * each a bold heading over muted lines. Context holds usage, cost and run state; Session where
 * the session runs; Work the refs, drawn by the sidebar's own Work row. Context
 * and Session share a row when the pane is wide enough, since both are short.
 */
export function PreviewHeader(props: HeaderProps): JSX.Element {
  const context = props.context;
  const theme = props.theme;
  const muted = () => theme().text.muted;

  /** A muted line, or one in `fg`. */
  const line = (text: () => string, fg: () => string | RGBA = muted) =>
    jsx('text', {
      flexShrink: 0,
      get fg() {
        return fg();
      },
      get children() {
        return text();
      }
    });
  /**
   * A bold `text.base` heading over `children`, hidden while `visible()` is false. A `column`
   * section takes an even share of a row.
   */
  const section = (
    title: string,
    visible: () => boolean,
    children: JSX.Element[],
    column = false
  ) =>
    jsx('box', {
      flexShrink: column ? 1 : 0,
      ...(column ? { flexGrow: 1, flexBasis: 0, minWidth: 0 } : {}),
      get visible() {
        return visible();
      },
      children: [
        jsx('text', {
          get fg() {
            return theme().text.base;
          },
          children: jsx('b', { children: title })
        }),
        ...children
      ]
    });

  const live = () => {
    const session = props.session();
    return session ? (context.data.session.get(session.id) ?? session) : undefined;
  };
  const usage = createMemo(() => {
    const session = live();
    if (!session) return undefined;
    return contextUsage(
      props.messages(),
      context.data.location.model.list(session.location),
      session.revert?.messageID
    );
  });
  const cost = () => {
    const session = live();
    return session ? context.data.session.cost(session.id) || session.cost : 0;
  };
  const status = () => {
    if (props.running())
      return { text: `${props.spinner()} running`, fg: theme().text.feedback.warning.base };
    const outcome = live()?.outcome;
    if (outcome === 'failed') return { text: 'failed', fg: theme().text.feedback.error.base };
    return { text: outcome === 'interrupted' ? 'interrupted' : 'idle', fg: muted() };
  };
  /** Usage, cost and run state. Built again when the layout switches between rows and a stack. */
  const contextSection = (column: boolean) =>
    section(
      'Context',
      () => true,
      [
        jsx('box', {
          get visible() {
            return usage() !== undefined;
          },
          children: [
            line(() => `${usage()?.tokens.toLocaleString() ?? ''} tokens`),
            jsx('box', {
              get visible() {
                return usage()?.percent !== undefined;
              },
              children: line(() => `${usage()?.percent ?? ''}% used`)
            })
          ]
        }),
        jsx('box', {
          get visible() {
            return cost() > 0;
          },
          children: line(() => `${MONEY.format(cost())} spent`)
        }),
        line(
          () => status().text,
          () => status().fg
        )
      ],
      column
    );

  const place = createMemo(() => {
    const session = props.session();
    return session ? placeOf(context, session) : undefined;
  });
  const showProject = () => {
    const session = props.session();
    const project = props.project();
    return (
      place()?.project !== undefined && (project === undefined || session?.projectID !== project)
    );
  };
  const branch = () => {
    const session = props.session();
    return session ? props.branch(session) : undefined;
  };
  /** Whether Context and Session fit side by side; narrower panes stack them as the sidebar does. */
  const sideBySide = () => (props.width() - SECTION_GAP) / 2 >= MIN_SECTION_WIDTH;
  /** Cells a Session line has: half the header beside Context, else all of it. */
  const sessionWidth = () =>
    sideBySide() ? Math.floor((props.width() - SECTION_GAP) / 2) : props.width();
  /**
   * One muted line cut with `…` at the column width, scrolling with the marquee while hovered,
   * hidden while `text()` is undefined. A path never wraps mid-word this way.
   */
  const fitted = (key: string, text: () => string | undefined) =>
    jsx('box', {
      flexShrink: 0,
      get visible() {
        return text() !== undefined;
      },
      onMouseOver: () => props.marquee.enter(key, text() ?? '', sessionWidth()),
      onMouseOut: () => props.marquee.leave(key),
      children: jsx('text', {
        wrapMode: 'none',
        get fg() {
          return muted();
        },
        get children() {
          const value = text() ?? '';
          return props.marquee.active() === key && props.marquee.offset() > 0
            ? marqueeText(value, sessionWidth(), props.marquee.offset())
            : fitText(value, sessionWidth());
        }
      })
    });
  /**
   * Where the session runs, each line only when it differs from the defaults. The model and agent
   * are left to the transcript, whose turn footers name them. Built again on a layout switch,
   * like Context.
   */
  const sessionSection = (column: boolean) =>
    section(
      'Session',
      () => showProject() || place()?.directory !== undefined || branch() !== undefined,
      [
        fitted('session:project', () => (showProject() ? place()?.project : undefined)),
        fitted('session:directory', () => place()?.directory),
        fitted('session:branch', branch)
      ],
      column
    );
  // Show reads both branches inside its own memo; untracked, they rebuild only on a layout switch.
  const sections = createComponent(Show, {
    keyed: true,
    get when() {
      return sideBySide();
    },
    get fallback() {
      return untrack(() => [contextSection(false), sessionSection(false)]);
    },
    children: (_wide: boolean) =>
      untrack(() =>
        jsx('box', {
          flexDirection: 'row',
          flexShrink: 0,
          // Top-aligned halves, so Context does not stretch to the height of Session.
          alignItems: 'flex-start',
          gap: SECTION_GAP,
          children: [contextSection(true), sessionSection(true)]
        })
      )
  });

  const work = createMemo(() => {
    const view = props.refs();
    return view === undefined ? [] : workLines(view);
  });
  const workSection = section('Work', () => work().length > 0, [
    createComponent(For, {
      get each() {
        return work();
      },
      children: (item: WorkLine) => {
        if (item.kind === 'label') return line(() => item.text);
        return workRow({
          context,
          options: props.options,
          theme,
          ref: () => item.ref,
          state: () => props.refs()?.states[refKey(item.ref)],
          width: () => props.width(),
          marquee: props.marquee,
          selected: () => props.selectedRef() === refKey(item.ref)
        });
      }
    })
  ]);

  return jsx('box', {
    flexDirection: 'column',
    flexShrink: 0,
    children: [
      jsx('box', {
        flexShrink: 0,
        paddingBottom: 1,
        children: jsx('text', {
          get fg() {
            return theme().text.base;
          },
          children: jsx('b', {
            get children() {
              return props.session()?.title || 'Untitled session';
            }
          })
        })
      }),
      jsx('box', {
        flexShrink: 0,
        gap: 1,
        children: [sections, workSection]
      })
    ]
  });
}

/** One line of the preview's Work section: a ref row, or the label over mentioned refs. */
export type WorkLine = { kind: 'label'; text: string } | { kind: 'ref'; ref: Ref };

/**
 * Tracked refs with the issues each PR closes right under it, in the same columns, then
 * mentioned refs under a label. Each ref appears once, so its key names its row.
 */
export function workLines(view: SessionRefView): WorkLine[] {
  const tracked = trackedRefs(view);
  const trackedKeys = new Set(tracked.map(refKey));
  const nestedKeys = new Set<string>();
  const lines: WorkLine[] = [];
  for (const pr of tracked.filter((ref) => ref.kind === 'pr')) {
    lines.push({ kind: 'ref', ref: pr });
    const key = refKey(pr);
    const closes = new Map<string, Ref>();
    for (const ref of view.states[key]?.closes ?? []) closes.set(refKey(ref), ref);
    for (const link of view.links) {
      if (link.source === 'closes' && link.via === key) closes.set(refKey(link.ref), link.ref);
    }
    for (const [issueKey, ref] of closes) {
      if (nestedKeys.has(issueKey)) continue;
      nestedKeys.add(issueKey);
      lines.push({ kind: 'ref', ref });
    }
  }
  for (const ref of tracked) {
    if (ref.kind === 'issue' && !nestedKeys.has(refKey(ref))) lines.push({ kind: 'ref', ref });
  }
  const mentioned = view.links.filter(
    (link) =>
      link.source === 'mention' &&
      !trackedKeys.has(refKey(link.ref)) &&
      !nestedKeys.has(refKey(link.ref))
  );
  if (mentioned.length > 0) {
    lines.push({ kind: 'label', text: 'mentioned' });
    for (const link of mentioned) lines.push({ kind: 'ref', ref: link.ref });
  }
  return lines;
}

/**
 * Tokens in the context window now, from the latest assistant step with usage after the last
 * completed compaction and before the revert boundary, with the share of the model's limit
 * (`contextUsage` in packages/tui/src/util/session.ts and `lastAssistantWithUsage` in
 * packages/client/src/solid/usage.ts, MIT). Only the loaded pages are searched.
 */
function contextUsage(
  messages: readonly SessionMessageInfo[],
  models: readonly { providerID: string; id: string; limit: { context: number } }[] | undefined,
  boundary: string | undefined
): { tokens: number; percent: number | undefined } | undefined {
  const boundaryIndex = boundary ? messages.findIndex((message) => message.id === boundary) : -1;
  if (boundary && boundaryIndex === -1) return undefined;
  const end = boundaryIndex === -1 ? messages.length : boundaryIndex;
  const compaction = messages.findLastIndex(
    (message, index) =>
      message.type === 'compaction' && message.status === 'completed' && index < end
  );
  const last = messages.findLast(
    (message, index): message is SessionMessageAssistant =>
      message.type === 'assistant' &&
      message.tokens !== undefined &&
      index > compaction &&
      index < end
  );
  const usage = last?.tokens;
  if (!last || !usage) return undefined;
  const tokens =
    usage.input + usage.output + usage.reasoning + usage.cache.read + usage.cache.write;
  if (tokens <= 0) return undefined;
  const model = models?.find(
    (item) => item.providerID === last.model.providerID && item.id === last.model.id
  );
  return {
    tokens,
    percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : undefined
  };
}

/**
 * Project name, plus the session directory relative to the project root when it is elsewhere
 * (a subdirectory or a worktree), or its full path when it sits outside the project. Sessions
 * of the global project have no project name, only their directory.
 */
function placeOf(
  context: Plugin.Context,
  session: SessionInfo
): { project?: string; directory?: string } {
  const project = context.data.project.get(session.projectID);
  const directory = session.location.directory;
  if (!project || project.canonical === '/')
    return { directory: context.ui.format.path(directory) };
  const name = project.name || path.basename(project.canonical);
  const relative = path.relative(project.canonical, directory);
  if (!relative) return { project: name };
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { project: name, directory: context.ui.format.path(directory) };
  }
  return { project: name, directory: relative };
}

/** Capitalizes each word, as the host does for agent names (packages/tui/src/util/locale.ts, MIT). */
export function titlecase(text: string): string {
  return text.replace(/\b\w/g, (letter) => letter.toUpperCase());
}
