import path from 'node:path';
import type { SessionInfo } from '@opencode/client';
import type { Plugin } from '@opencode/plugin/tui';
import type { ResolvedTheme } from '@opencode/theme/tui';
import { type RGBA, TextAttributes } from '@opentui/core';
import { jsx } from '@opentui/solid/jsx-runtime';
import { createComponent, createMemo, For, type JSX } from 'solid-js';
import type { Options } from '../config.js';
import { marqueeText } from '../marquee.js';
import { type Ref, refKey, refNumber } from '../refs/ref.js';
import { trackedRefs } from '../refs/summary.js';
import type { SessionRefView } from '../rpc.js';
import { ICONS, refColor, refIcon, STATE_WORDS } from './icons.js';
import { cells, fitText } from './row.js';

/** Nerd Font octicons of the header rows, drawn in the same 2-cell slot as the ref icons. */
const HEADER_ICONS = {
  project: '\uf401',
  directory: '\uf413',
  model: '\uf4bc',
  idle: '\uf4c3',
  failed: '\uf52f'
} as const;

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** A run of text with one color, as drawn inside a line. */
interface Segment {
  text: string;
  fg: string | RGBA;
  bold?: boolean;
}

/** Scrolls one key's text at a time while the mouse hovers it. */
export interface Hover {
  active(): string | undefined;
  offset(): number;
  enter(key: string, text: string, width: number): void;
  leave(key: string): void;
}

/** Inputs of the header, a subset of the pane's own. */
export interface HeaderProps {
  context: Plugin.Context;
  options: Options;
  theme(): ResolvedTheme;
  session(): SessionInfo | undefined;
  refs(): SessionRefView | undefined;
  branch(session: SessionInfo): string | undefined;
  running(): boolean;
  /** Current spinner glyph, ticking only while the session runs. */
  spinner(): string;
  width(): number;
  marquee: Hover;
  agentColor(session: SessionInfo, agent: string): RGBA;
}

/**
 * Title, then one icon/value row each for the project, the worktree directory, the branch, the
 * model and agent, and the run state with tokens and cost; then the session's refs.
 */
export function PreviewHeader(props: HeaderProps): JSX.Element {
  const context = props.context;
  const theme = props.theme;
  const muted = () => theme().text.muted;

  const title = () => props.session()?.title || 'Untitled session';
  const titleLine = jsx('text', {
    height: 1,
    flexShrink: 0,
    wrapMode: 'none',
    attributes: TextAttributes.BOLD,
    get fg() {
      return theme().text.base;
    },
    // Only hovering scrolls a cut title; nothing moves when the pane opens or follows the list.
    onMouseOver: () => props.marquee.enter('title', title(), props.width()),
    onMouseOut: () => props.marquee.leave('title'),
    get children() {
      return scrolled(props.marquee, 'title', title(), props.width());
    }
  });

  const rows = createMemo((): Segment[][] => {
    const session = props.session();
    if (!session) return [];
    const value = (text: string): Segment => ({ text, fg: theme().text.base });
    const icon = (glyph: string, fg: string | RGBA = muted()): Segment => ({
      text: `${glyph} `,
      fg
    });
    const place = placeOf(context, session);
    const branch = props.branch(session);
    const model = modelName(context, session);
    const lines: Segment[][] = [[icon(HEADER_ICONS.project), value(place.project)]];
    if (place.directory) lines.push([icon(HEADER_ICONS.directory), value(place.directory)]);
    if (branch) lines.push([icon(ICONS.branch), value(branch)]);
    if (model || session.agent) {
      const line = [icon(HEADER_ICONS.model)];
      if (model) line.push(value(model));
      if (session.agent) {
        if (model) line.push({ text: ' · ', fg: muted() });
        line.push({ text: titlecase(session.agent), fg: props.agentColor(session, session.agent) });
      }
      lines.push(line);
    }
    lines.push(statusLine(session));
    return lines;
  });

  /** Run state colored by outcome, then tokens and cost. */
  const statusLine = (session: SessionInfo): Segment[] => {
    const live = context.data.session.get(session.id) ?? session;
    const tail = {
      text: ` · ${formatTokens(totalTokens(live))} tokens · ${formatCost(live.cost)}`,
      fg: muted()
    };
    if (props.running()) {
      const fg = theme().text.feedback.warning.base;
      return [{ text: `${props.spinner()} `, fg }, { text: 'running', fg }, tail];
    }
    if (live.outcome === 'failed') {
      const fg = theme().text.feedback.error.base;
      return [{ text: `${HEADER_ICONS.failed} `, fg }, { text: 'failed', fg }, tail];
    }
    const word = live.outcome === 'interrupted' ? 'interrupted' : 'idle';
    return [{ text: `${HEADER_ICONS.idle} `, fg: muted() }, { text: word, fg: muted() }, tail];
  };

  const info = createComponent(For, {
    get each() {
      return rows();
    },
    children: (segments: Segment[]) =>
      jsx('text', {
        height: 1,
        flexShrink: 0,
        wrapMode: 'none',
        get children() {
          return fitSegments(segments, props.width()).map((segment) =>
            jsx('span', {
              style: { fg: segment.fg, ...(segment.bold ? { bold: true } : {}) },
              children: segment.text
            })
          );
        }
      })
  });

  const work = createMemo(() => {
    const view = props.refs();
    return view === undefined ? [] : workLines(view);
  });
  // Every column lines up across rows, nested issues included, like a table without borders.
  const columns = createMemo(() => {
    const lines = work().filter((line) => line.kind === 'ref');
    return {
      number: Math.max(0, ...lines.map((line) => line.indent + 2 + cells(refNumber(line.ref)))),
      state: Math.max(0, ...lines.map((line) => cells(stateWord(line))))
    };
  });
  const refs = createComponent(For, {
    get each() {
      return work();
    },
    children: (line: WorkLine) => {
      if (line.kind === 'label') {
        return jsx('text', {
          height: 1,
          flexShrink: 0,
          get fg() {
            return muted();
          },
          children: line.text
        });
      }
      const key = `ref:${refKey(line.ref)}`;
      const fg = () => refColor(props.options, line.status, theme(), context.themeMode);
      const lead = () => ({
        indent: ' '.repeat(line.indent),
        icon: `${refIcon(line.ref.kind, line.status)} `,
        number: refNumber(line.ref).padEnd(columns().number - line.indent - 2),
        state: stateWord(line).padEnd(columns().state)
      });
      const titleWidth = () => props.width() - columns().number - columns().state - 4;
      return jsx('text', {
        height: 1,
        flexShrink: 0,
        wrapMode: 'none',
        onMouseOver: () => props.marquee.enter(key, line.title, titleWidth()),
        onMouseOut: () => props.marquee.leave(key),
        get children() {
          const parts = lead();
          return [
            jsx('span', { children: parts.indent }),
            jsx('span', { style: { fg: fg() }, children: parts.icon }),
            jsx('span', { style: { fg: theme().text.base }, children: `${parts.number}  ` }),
            jsx('span', { style: { fg: fg() }, children: `${parts.state}  ` }),
            jsx('span', {
              style: { fg: theme().text.base },
              children: scrolled(props.marquee, key, line.title, titleWidth())
            })
          ];
        }
      });
    }
  });

  return jsx('box', {
    flexDirection: 'column',
    flexShrink: 0,
    children: [
      titleLine,
      info,
      jsx('box', {
        flexDirection: 'column',
        flexShrink: 0,
        paddingTop: 1,
        get visible() {
          return work().length > 0;
        },
        children: refs
      })
    ]
  });
}

/** The visible slice of a text: scrolled while hovered, otherwise cut with an ellipsis. */
function scrolled(marquee: Hover, key: string, text: string, width: number): string {
  return marquee.active() === key && marquee.offset() > 0
    ? marqueeText(text, width, marquee.offset())
    : fitText(text, width);
}

/** Cuts colored segments to `width` cells, ending the last visible one with an ellipsis. */
function fitSegments(segments: readonly Segment[], width: number): Segment[] {
  const out: Segment[] = [];
  let left = width;
  for (const segment of segments) {
    const size = cells(segment.text);
    if (size <= left) {
      out.push(segment);
      left -= size;
      continue;
    }
    out.push({ ...segment, text: fitText(segment.text, left) });
    break;
  }
  return out;
}

type WorkLine =
  | { kind: 'label'; text: string }
  | {
      kind: 'ref';
      ref: Ref;
      status: SessionRefView['states'][string]['status'] | undefined;
      title: string;
      indent: number;
    };

/** State word of a ref line, `unknown` before its first snapshot. */
function stateWord(line: Extract<WorkLine, { kind: 'ref' }>): string {
  return line.status ? STATE_WORDS[line.status] : 'unknown';
}

/** Tracked refs with the issues each PR closes nested under it, then mentioned refs. */
function workLines(view: SessionRefView): WorkLine[] {
  const entry = (ref: Ref, indent: number): WorkLine => {
    const state = view.states[refKey(ref)];
    return { kind: 'ref', ref, status: state?.status, title: state?.title ?? '', indent };
  };
  const tracked = trackedRefs(view);
  const trackedKeys = new Set(tracked.map(refKey));
  const nestedKeys = new Set<string>();
  const lines: WorkLine[] = [];
  for (const pr of tracked.filter((ref) => ref.kind === 'pr')) {
    lines.push(entry(pr, 0));
    const key = refKey(pr);
    const closes = new Map<string, Ref>();
    for (const ref of view.states[key]?.closes ?? []) closes.set(refKey(ref), ref);
    for (const link of view.links) {
      if (link.source === 'closes' && link.via === key) closes.set(refKey(link.ref), link.ref);
    }
    for (const [issueKey, ref] of closes) {
      if (nestedKeys.has(issueKey)) continue;
      nestedKeys.add(issueKey);
      lines.push(entry(ref, 2));
    }
  }
  for (const ref of tracked) {
    if (ref.kind === 'issue' && !nestedKeys.has(refKey(ref))) lines.push(entry(ref, 0));
  }
  const mentioned = view.links.filter(
    (link) =>
      link.source === 'mention' &&
      !trackedKeys.has(refKey(link.ref)) &&
      !nestedKeys.has(refKey(link.ref))
  );
  if (mentioned.length > 0) {
    lines.push({ kind: 'label', text: 'mentioned' });
    for (const link of mentioned) lines.push(entry(link.ref, 0));
  }
  return lines;
}

/**
 * Project name, plus the session directory relative to the project root when it is elsewhere
 * (a subdirectory or a worktree), or its full path when it sits outside the project.
 */
function placeOf(
  context: Plugin.Context,
  session: SessionInfo
): { project: string; directory?: string } {
  const project = context.data.project.get(session.projectID);
  const directory = session.location.directory;
  if (!project || project.canonical === '/') return { project: context.ui.format.path(directory) };
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
export function modelName(context: Plugin.Context, session: SessionInfo): string | undefined {
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

/** Cost in dollars with cents, `$0.00` included so the status line keeps its shape. */
function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}
