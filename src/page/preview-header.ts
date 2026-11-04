import path from 'node:path';
import type { SessionInfo, SessionMessageAssistant, SessionMessageInfo } from '@opencode/client';
import type { Plugin } from '@opencode/plugin/tui';
import type { ResolvedTheme } from '@opencode/theme/tui';
import type { RGBA } from '@opentui/core';
import { jsx } from '@opentui/solid/jsx-runtime';
import { createComponent, createMemo, For, type JSX } from 'solid-js';
import type { Options } from '../config.js';
import type { createMarquee } from '../marquee.js';
import { type Ref, refKey } from '../refs/ref.js';
import { trackedRefs } from '../refs/summary.js';
import type { SessionRefView } from '../rpc.js';
import { workRow } from '../work-row.js';
import { STATE_WORDS } from './icons.js';

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// The host sidebar's Context section formats cost this way (feature-plugins/sidebar/context.tsx).
const MONEY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

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
  width(): number;
  marquee: ReturnType<typeof createMarquee>;
  agentColor(session: SessionInfo, agent: string): RGBA;
}

/**
 * Laid out like the host's session sidebar (routes/session/sidebar.tsx and the sections in
 * feature-plugins/sidebar, MIT): the bold title, wrapping, then sections one blank line apart,
 * each a bold heading over muted lines. Context holds usage, cost and run state; Session where
 * and with what the session runs; Work the refs, drawn by the sidebar's own Work row.
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
  /** A bold `text.base` heading over `children`, hidden while `visible()` is false. */
  const section = (title: string, visible: () => boolean, children: JSX.Element[]) =>
    jsx('box', {
      flexShrink: 0,
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
  const contextSection = section('Context', () => true, [
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
  ]);

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
  const model = () => {
    const session = props.session();
    return session ? modelName(context, session) : undefined;
  };
  const optional = (visible: () => boolean, child: JSX.Element) =>
    jsx('box', {
      get visible() {
        return visible();
      },
      children: child
    });
  const sessionSection = section(
    'Session',
    () =>
      showProject() ||
      place()?.directory !== undefined ||
      branch() !== undefined ||
      model() !== undefined ||
      Boolean(props.session()?.agent),
    [
      optional(
        showProject,
        line(() => place()?.project ?? '')
      ),
      optional(
        () => place()?.directory !== undefined,
        line(() => place()?.directory ?? '')
      ),
      optional(
        () => branch() !== undefined,
        line(() => branch() ?? '')
      ),
      optional(
        () => model() !== undefined || Boolean(props.session()?.agent),
        jsx('text', {
          get fg() {
            return muted();
          },
          get children() {
            const session = props.session();
            const agent = session?.agent;
            return [
              jsx('span', { children: model() ?? '' }),
              jsx('span', { children: model() && agent ? ' · ' : '' }),
              jsx('span', {
                get style() {
                  return {
                    fg: session && agent ? props.agentColor(session, agent) : muted()
                  };
                },
                children: agent ? titlecase(agent) : ''
              })
            ];
          }
        })
      )
    ]
  );

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
          right: () => {
            const status = props.refs()?.states[refKey(item.ref)]?.status;
            return status ? STATE_WORDS[status] : 'unknown';
          }
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
        children: [contextSection, sessionSection, workSection]
      })
    ]
  });
}

type WorkLine = { kind: 'label'; text: string } | { kind: 'ref'; ref: Ref };

/**
 * Tracked refs with the issues each PR closes right under it, in the same columns, then
 * mentioned refs under a label.
 */
function workLines(view: SessionRefView): WorkLine[] {
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

/** Display name of the session's model, falling back to its id. */
function modelName(context: Plugin.Context, session: SessionInfo): string | undefined {
  const model = session.model;
  if (!model) return undefined;
  const known = context.data.location.model
    .list(session.location)
    ?.find((item) => item.id === model.id && item.providerID === model.providerID);
  return known?.name ?? model.id;
}
