import { stripVTControlCharacters } from 'node:util';
import type {
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionMessageInfo
} from '@opencode/client';
import { cells } from './row.js';

// The transcript's data side: which rows to draw and their text, with no rendering. Most of it
// is ported from the host's session view (packages/tui/src/routes/session, MIT).

type Message<Type extends SessionMessageInfo['type']> = Extract<SessionMessageInfo, { type: Type }>;

/** One reasoning part with its message, which supplies the fallback timestamps. */
export interface Thought {
  message: SessionMessageAssistant;
  part: SessionMessageAssistantReasoning;
}

/** One visible row of the transcript. `key` stays the same across reloads of the same content. */
export type TranscriptRow =
  | { type: 'user'; key: string; message: Message<'user'> }
  | { type: 'shell'; key: string; message: Message<'shell'> }
  | {
      type: 'notice';
      key: string;
      message: Message<
        'agent-switched' | 'model-switched' | 'location-switched' | 'synthetic' | 'system' | 'skill'
      >;
    }
  | { type: 'compaction'; key: string; message: Message<'compaction'> }
  | { type: 'error'; key: string; text: string }
  | {
      type: 'text';
      key: string;
      message: SessionMessageAssistant;
      part: SessionMessageAssistantText;
    }
  | {
      type: 'tool';
      key: string;
      message: SessionMessageAssistant;
      part: SessionMessageAssistantTool;
    }
  | { type: 'thoughts'; key: string; items: Thought[]; completed: boolean }
  | { type: 'exploration'; key: string; tools: SessionMessageAssistantTool[]; completed: boolean }
  | {
      type: 'instructions';
      key: string;
      files: Set<string>;
      messages: Message<'synthetic'>[];
    }
  | { type: 'activity'; key: string; children: TranscriptRow[]; completed: boolean }
  | { type: 'footer'; key: string; message: SessionMessageAssistant; duration: number };

/** The host's `session.verbosity`. */
export type Verbosity = 'low' | 'medium' | 'high';

// Tools that the host folds into one "Explored" line (grouping/session.ts `explorationTools`).
const EXPLORATION = new Set(['read', 'glob', 'grep', 'webfetch', 'websearch']);

/**
 * Rows for messages in chronological order: each run of thoughts, of reads and searches and of
 * instruction loads becomes one group row. At `low` verbosity every run of tools, thoughts and
 * instruction loads is also wrapped in one `activity` row; text, questions and other messages
 * stand alone and end the run. Whether a group draws folded is the view's choice, as in the
 * host. Ported from `reduceSessionRows`, `partPath`, `messagePath` and `projectEntries` in
 * packages/tui/src/routes/session (MIT).
 */
export function transcriptRows(
  messages: readonly SessionMessageInfo[],
  verbosity: Verbosity = 'medium'
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  // An idle failure that repeats the error the last step already showed is not drawn twice.
  let shownError: SessionMessageAssistant['error'];
  const index = new Map(messages.map((message, position) => [message.id, position]));
  const legacy = !messages.some((message) => message.type === 'idle');

  for (const message of messages) {
    switch (message.type) {
      case 'assistant':
        shownError = message.error;
        assistantRows(rows, message, verbosity === 'low');
        if (
          (message.finish && !NON_TERMINAL.has(message.finish)) ||
          message.error ||
          message.retry
        ) {
          rows.push({
            type: 'footer',
            key: `footer:${message.id}`,
            message,
            duration: turnDuration(messages, index.get(message.id) ?? -1, legacy)
          });
        }
        break;
      case 'idle':
        if (
          message.error &&
          (message.error.type !== shownError?.type || message.error.message !== shownError.message)
        ) {
          rows.push({ type: 'error', key: `idle:${message.id}`, text: message.error.message });
        }
        shownError = undefined;
        break;
      case 'user':
        if (message.text.trim() || message.files?.length || message.skills?.length) {
          rows.push({ type: 'user', key: message.id, message });
        }
        break;
      case 'shell':
        rows.push({ type: 'shell', key: message.id, message });
        break;
      case 'compaction':
        if (message.status !== 'running') {
          shownError = message.status === 'failed' ? message.error : undefined;
        }
        rows.push({ type: 'compaction', key: message.id, message });
        break;
      case 'synthetic': {
        const files = instructionPaths(message);
        if (files.length > 0) {
          const key = `instructions:${message.id}`;
          const into = verbosity === 'low' ? activity(rows, key) : rows;
          const last = into.at(-1);
          if (last?.type === 'instructions') {
            for (const file of files) last.files.add(file);
            last.messages.push(message);
          } else {
            into.push({
              type: 'instructions',
              key,
              files: new Set(files),
              messages: [message]
            });
          }
          break;
        }
        if (message.description?.trim()) rows.push({ type: 'notice', key: message.id, message });
        break;
      }
      default:
        rows.push({ type: 'notice', key: message.id, message });
    }
  }
  markCompleted(rows);
  return rows;
}

const NON_TERMINAL = new Set(['tool-calls', 'unknown']);

/**
 * Appends a message's parts, merging thoughts and explorations into the row before them. With
 * `low`, every part but text and questions goes into the activity row at the end.
 */
function assistantRows(rows: TranscriptRow[], message: SessionMessageAssistant, low: boolean) {
  let text = 0;
  let reasoning = 0;
  for (const part of message.content) {
    if (part.type === 'text') {
      const ordinal = text++;
      if (!part.text.trim()) continue;
      rows.push({ type: 'text', key: `${message.id}:text:${ordinal}`, message, part });
      continue;
    }
    if (part.type === 'reasoning') {
      const ordinal = reasoning++;
      if (!reasoningContent(part)) continue;
      const key = `${message.id}:reasoning:${ordinal}`;
      const into = low ? activity(rows, key) : rows;
      const last = into.at(-1);
      const item = { message, part };
      if (last?.type === 'thoughts') last.items.push(item);
      else into.push({ type: 'thoughts', key, items: [item], completed: false });
      continue;
    }
    const key = `${message.id}:${part.id}`;
    // Questions always stand alone, so an answer is never folded away.
    if (part.name.toLowerCase() === 'question') {
      rows.push({ type: 'tool', key, message, part });
      continue;
    }
    const into = low ? activity(rows, key) : rows;
    const last = into.at(-1);
    if (!EXPLORATION.has(part.name.toLowerCase())) {
      into.push({ type: 'tool', key, message, part });
      continue;
    }
    if (last?.type === 'exploration') last.tools.push(part);
    else into.push({ type: 'exploration', key, tools: [part], completed: false });
  }
}

/** The children of the activity row at the end, which starts a new one keyed after `first`. */
function activity(rows: TranscriptRow[], first: string): TranscriptRow[] {
  const last = rows.at(-1);
  if (last?.type === 'activity') return last.children;
  const row: TranscriptRow = {
    type: 'activity',
    key: `activity:${first}`,
    children: [],
    completed: false
  };
  rows.push(row);
  return row.children;
}

/**
 * A group is complete once anything follows it, inside an activity row too, or when its parent
 * is complete; a run of thoughts also once every thought has finished. Ported from
 * `projectEntries` (grouping/session.ts) and the nested `Children` rule (group-view.tsx), MIT.
 */
function markCompleted(rows: TranscriptRow[], parent = false) {
  rows.forEach((row, position) => {
    if (row.type !== 'thoughts' && row.type !== 'exploration' && row.type !== 'activity') return;
    row.completed =
      parent ||
      position < rows.length - 1 ||
      (row.type === 'thoughts' &&
        row.items.every(({ part }) => part.time?.completed !== undefined));
    if (row.type === 'activity') markCompleted(row.children, row.completed);
  });
}

type ActivityItem =
  | { type: 'reasoning'; thought: Thought }
  | { type: 'tool'; part: SessionMessageAssistantTool };

/**
 * The label of a `low` activity row, such as `3 commands, 1 edit, 2 thoughts, 4 reads`, counting
 * finished work only; until something finishes, the first running item's status. `active` while
 * anything still runs. Ported from `summarizeActivity` and `activitySummary` in
 * packages/tui/src/routes/session/activity-summary.ts (MIT).
 */
export function activitySummary(row: Extract<TranscriptRow, { type: 'activity' }>) {
  const closed = row.completed;
  const items = row.children.flatMap((child): ActivityItem[] => {
    if (child.type === 'thoughts')
      return child.items.map((thought) => ({ type: 'reasoning', thought }));
    if (child.type === 'exploration') return child.tools.map((part) => ({ type: 'tool', part }));
    if (child.type === 'tool') return [{ type: 'tool', part: child.part }];
    return [];
  });
  const files = new Set(
    row.children.flatMap((child) => (child.type === 'instructions' ? [...child.files] : []))
  );
  const counts = { command: 0, edit: 0, thought: 0, read: 0, tool: 0, instruction: files.size };
  for (const item of items) {
    if (item.type === 'reasoning') {
      if (!activeItem(item, closed)) counts.thought++;
      continue;
    }
    const name = canonicalTool(item.part.name);
    if (name === 'execute') {
      // Code mode counts the nested calls it finished rather than itself.
      const calls = executeCalls(toolMetadata(item.part).toolCalls).filter(
        (call) => call.status !== 'running'
      );
      for (const call of calls) {
        if (canonicalTool(call.tool) === 'read') counts.read++;
        else counts.tool++;
      }
      if (calls.length === 0 && !activeItem(item, closed)) counts.tool++;
      continue;
    }
    if (activeItem(item, closed)) continue;
    if (name === 'shell') counts.command++;
    else if (name === 'read') counts.read++;
    else if (name === 'edit' || name === 'write' || name === 'patch') counts.edit++;
    else counts.tool++;
  }
  const label = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${count} ${name}${count === 1 ? '' : 's'}`)
    .join(', ');
  const current = items.find((item) => activeItem(item, closed));
  return {
    label: label || (current ? busyLabel(current) : ''),
    active: current !== undefined
  };
}

/** Whether an activity item still runs. Thoughts count as done once the row is closed. */
function activeItem(item: ActivityItem, closed: boolean): boolean {
  if (item.type === 'reasoning') {
    const { message, part } = item.thought;
    return !closed && part.time?.completed === undefined && message.time.completed === undefined;
  }
  return item.part.state.status === 'streaming' || item.part.state.status === 'running';
}

/** Status of a running item, independent of its details so it does not flicker (`busyLabel`). */
function busyLabel(item: ActivityItem): string {
  if (item.type === 'reasoning') return 'Thinking…';
  const name = canonicalTool(item.part.name);
  const noun = name === 'shell' ? 'command' : name === 'execute' ? 'code' : name;
  return `${item.part.state.status === 'streaming' ? 'Preparing' : 'Running'} ${noun}…`;
}

/** Nested calls of a code-mode `execute` (util/tool-display.ts `executeCalls`, MIT). */
function executeCalls(value: unknown): { tool: string; status: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((call: unknown) => {
    if (typeof call !== 'object' || call === null) return [];
    const record = call as Record<string, unknown>;
    const status = record.status;
    if (typeof record.tool !== 'string') return [];
    if (status !== 'running' && status !== 'completed' && status !== 'error') return [];
    return [{ tool: record.tool, status }];
  });
}

/** Files an instruction load carried (grouping/session.ts `instructionPaths`, MIT). */
function instructionPaths(message: Message<'synthetic'>): string[] {
  const instruction = message.metadata?.instruction;
  if (typeof instruction !== 'object' || instruction === null || Array.isArray(instruction))
    return [];
  const paths = instruction.paths;
  return Array.isArray(paths)
    ? paths.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * Milliseconds from the prompt that started the turn until `message` completed, or 0 while it
 * runs. Ported from `SessionTurn.duration` in packages/util/src/session-turn.ts (MIT). Only the
 * loaded pages are searched, so the first turn of a page may measure from its first step.
 */
function turnDuration(messages: readonly SessionMessageInfo[], position: number, legacy: boolean) {
  const message = messages[position];
  if (message?.type !== 'assistant' || message.time.completed === undefined) return 0;
  let input = -1;
  for (let at = position - 1; at >= 0; at--) {
    const item = messages[at];
    if (!item || item.type === 'idle') break;
    if (item.type !== 'user' && item.type !== 'synthetic') continue;
    input = at;
    if (legacy) break;
  }
  const start = messages[input]?.time.created ?? message.time.created;
  return Math.max(0, message.time.completed - start);
}

/** Reasoning text without OpenRouter's encrypted placeholder (message-parts.tsx, MIT). */
export function reasoningContent(part: SessionMessageAssistantReasoning): string {
  return part.text.replace('[REDACTED]', '').trim();
}

/** The bold first line some models open a thought with (context/thinking.ts, MIT). */
export function reasoningTitle(text: string): string | undefined {
  return text
    .trim()
    .match(/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/)?.[1]
    ?.trim();
}

/** Compact elapsed time: `850ms`, `12.4s`, `3m 5s`, `2h 10m`, `1d 4h` (util/duration.ts, MIT). */
export function formatDuration(input: number): string {
  if (input < 1000) return `${input}ms`;
  if (input < 60_000) return `${(input / 1000).toFixed(1)}s`;
  if (input < 3_600_000) {
    return `${Math.floor(input / 60_000)}m ${Math.floor((input % 60_000) / 1000)}s`;
  }
  if (input < 86_400_000) {
    return `${Math.floor(input / 3_600_000)}h ${Math.floor((input % 3_600_000) / 60_000)}m`;
  }
  return `${Math.floor(input / 86_400_000)}d ${Math.floor((input % 86_400_000) / 3_600_000)}h`;
}

/** Host tool name for legacy aliases (util/tool-display.ts `canonicalToolName`, MIT). */
export function canonicalTool(name: string): string {
  if (name === 'bash') return 'shell';
  if (name === 'task') return 'subagent';
  if (name === 'apply_patch') return 'patch';
  return name;
}

/** `[key=value, ...]` for the primitive inputs of a tool (util/tool-display.ts, MIT). */
export function inputSummary(input: Record<string, unknown>): string {
  const entries = Object.entries(input).filter(([, value]) =>
    ['string', 'number', 'boolean'].includes(typeof value)
  );
  if (entries.length === 0) return '';
  return `[${entries.map(([key, value]) => `${key}=${String(value)}`).join(', ')}]`;
}

/** The exploration label: `Explored: 2 reads, 1 search` (group-view.tsx, MIT). */
export function explorationLabel(
  tools: readonly SessionMessageAssistantTool[],
  completed: boolean
) {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const name = canonicalTool(tool.name);
    const label =
      name === 'grep' || name === 'glob' || name === 'websearch'
        ? 'search'
        : name === 'webfetch'
          ? 'fetch'
          : name;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const names = [...counts].map(([name, count]) => {
    if (count === 1) return `${count} ${name}`;
    return `${count} ${name === 'search' || name === 'fetch' ? `${name}es` : `${name}s`}`;
  });
  return `${completed ? 'Explored' : 'Exploring'}: ${names.join(', ')}`;
}

/** Text of a tool's result content, the way the host joins it for display (index.tsx, MIT). */
export function toolOutput(part: SessionMessageAssistantTool): string | undefined {
  const state = part.state;
  if (state.status === 'streaming' || state.status === 'running') return undefined;
  return (state.content ?? [])
    .map((content) => (content.type === 'text' ? content.text : (content.name ?? content.uri)))
    .join('\n');
}

/** Tool metadata, empty while the call still streams (util/tool-display.ts, MIT). */
export function toolMetadata(part: SessionMessageAssistantTool): Record<string, unknown> {
  const state = part.state;
  if (state.status === 'streaming') return {};
  return state.metadata ?? {};
}

/** Tool input as a record; a streaming call has only raw text so far. */
export function toolInput(part: SessionMessageAssistantTool): Record<string, unknown> {
  return typeof part.state.input === 'string' ? {} : part.state.input;
}

/** Text without the ANSI escape sequences a shell may print. */
export function stripAnsi(text: string): string {
  return stripVTControlCharacters(text);
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Cuts tool output to `maxLines` lines and `maxChars` characters (util/collapse-tool-output.ts, MIT). */
function collapseToolOutput(output: string, maxLines: number, maxChars: number) {
  const lines = output.split('\n');
  if (lines.length <= maxLines && Array.from(output).length <= maxChars) {
    return { output, overflow: false };
  }
  const visible = lines.slice(0, maxLines);
  if (lines.length > maxLines && visible.length > 0) visible[visible.length - 1] += '…';
  const preview = visible.join('\n');
  if (Array.from(preview).length > maxChars) {
    return {
      output: `${Array.from(preview)
        .slice(0, Math.max(0, maxChars - 1))
        .join('')}…`,
      overflow: true
    };
  }
  return { output: preview, overflow: true };
}

/**
 * The command (at most 2 lines) and the tail of its output that fit `maxLines` lines, with an
 * `(N earlier lines)` label when output was dropped. Ported from `collapseShellOutput` in
 * packages/tui/src/util/collapse-tool-output.ts (MIT).
 */
export function collapseShellOutput(
  input: string,
  output: string,
  maxLines: number,
  maxChars: number
) {
  if (!input) {
    const collapsed = collapseToolOutput(output, maxLines, maxChars);
    return {
      input,
      output: collapsed.overflow ? collapseTail(output, maxLines, maxChars) : output,
      overflow: collapsed.overflow
    };
  }
  const lineChars = Math.max(1, Math.floor(maxChars / Math.max(1, maxLines)));
  const command = collapseCommand(input, Math.min(2, maxLines), lineChars);
  if (!output) return { input: command.output, output, overflow: command.overflow };
  const lines = Math.max(1, maxLines - command.lines - 1);
  const chars = Math.max(1, maxChars - Array.from(command.output).length - 2);
  const collapsed = collapseToolOutput(output, lines, chars);
  return {
    input: command.output,
    output: collapsed.overflow ? collapseTail(output, lines, chars) : output,
    overflow: command.overflow || collapsed.overflow
  };
}

/** The command cut to `maxLines` wrapped lines of `lineWidth` cells. */
function collapseCommand(input: string, maxLines: number, lineWidth: number) {
  const visible: string[] = [];
  let lines = 1;
  let width = 0;
  const overflow = Array.from(graphemes.segment(input), (item) => item.segment).some((segment) => {
    if (segment === '\n') {
      if (lines >= maxLines) return true;
      visible.push(segment);
      lines++;
      width = 0;
      return false;
    }
    const next = cells(segment);
    if (width + next > lineWidth) {
      if (lines >= maxLines) return true;
      lines++;
      width = 0;
    }
    visible.push(segment);
    width += next;
    return false;
  });
  if (!overflow) return { output: input, overflow, lines };
  if (width >= lineWidth) visible.pop();
  return { output: `${visible.join('')}…`, overflow, lines };
}

/** The last lines of output under an `(N earlier lines)` label. */
function collapseTail(output: string, maxLines: number, maxChars: number) {
  const lines = output.split('\n');
  if (lines.length <= maxLines && Array.from(output).length <= maxChars) return output;
  const count = Math.max(1, lines.length - Math.max(0, maxLines - 1));
  const label = `(${count} earlier ${count === 1 ? 'line' : 'lines'})`;
  if (maxLines <= 1) return label;
  const preview = Array.from(lines.slice(-(maxLines - 1)).join('\n'));
  const available = maxChars - Array.from(label).length - 1;
  if (available <= 0) return label;
  return `${label}\n${preview.slice(-available).join('')}`;
}

/** A file an edit or patch changed, from its metadata (index.tsx `parseApplyPatchFiles`, MIT). */
export interface PatchFile {
  type: string;
  path: string;
  patch: string;
  deletions: number;
}

/** Changed files listed in an edit or patch call's metadata. */
export function patchFiles(value: unknown): PatchFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const file = item as Record<string, unknown>;
    const status = file.status;
    const type =
      typeof file.type === 'string'
        ? file.type
        : status === 'added'
          ? 'add'
          : status === 'deleted'
            ? 'delete'
            : status === 'modified'
              ? 'update'
              : undefined;
    const path = typeof file.file === 'string' ? file.file : file.relativePath;
    if (!type || typeof path !== 'string' || typeof file.patch !== 'string') return [];
    const deletions = typeof file.deletions === 'number' ? file.deletions : 0;
    return [{ type, path, patch: file.patch, deletions }];
  });
}

// Tree-sitter languages the host highlights, by extension (a subset of util/filetype.ts, MIT).
const LANGUAGES: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'typescript',
  '.jsx': 'typescript',
  '.mjs': 'typescript',
  '.cjs': 'typescript',
  '.json': 'json',
  '.md': 'markdown',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.css': 'css',
  '.html': 'html'
};

/** Highlighting language of a file path, `none` when unknown. */
export function filetype(file: string | undefined): string {
  const extension = file?.match(/\.[^./\\]+$/)?.[0]?.toLowerCase();
  return (extension && LANGUAGES[extension]) || 'none';
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
const TODO_STATUSES = new Set<unknown>(['pending', 'in_progress', 'completed', 'cancelled']);

/** Valid todo items of a `todowrite` input (util/todo.ts, MIT). */
export function parseTodos(value: unknown): { content: string; status: TodoStatus }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.content !== 'string' || !record.content) return [];
    const status = TODO_STATUSES.has(record.status) ? (record.status as TodoStatus) : 'pending';
    return [{ content: record.content, status }];
  });
}

/** Checkbox drawn before a todo (util/todo.ts, MIT). */
export function todoMarker(status: TodoStatus): string {
  if (status === 'completed') return '[✓]';
  if (status === 'in_progress') return '[•]';
  if (status === 'cancelled') return '[-]';
  return '[ ]';
}
