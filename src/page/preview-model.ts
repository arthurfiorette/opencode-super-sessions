import type {
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageInfo
} from '@opencode/client';

// The session preview's data side that both browsers share: the context usage of the TUI's
// header (src/page/preview-header.ts), the tool helpers of its transcript
// (src/page/transcript-model.ts) and the Desktop preview's chat lines. It imports neither OpenTUI
// nor `node:*`, so the Desktop window can bundle it.

/** Context window usage: tokens in it now, and their share of the model's limit when known. */
export interface ContextUsage {
  tokens: number;
  percent: number | undefined;
}

/**
 * Tokens in the context window now, from the latest assistant step with usage after the last
 * completed compaction and before the revert boundary, with the share of the model's limit
 * (`contextUsage` in packages/tui/src/util/session.ts and `lastAssistantWithUsage` in
 * packages/client/src/solid/usage.ts, MIT). Only the loaded pages are searched.
 */
export function contextUsage(
  messages: readonly SessionMessageInfo[],
  models: readonly { providerID: string; id: string; limit: { context: number } }[] | undefined,
  boundary: string | undefined
): ContextUsage | undefined {
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

/** One line of the Desktop preview's chat: a prompt, assistant text, or a tool call. */
export type ChatLine =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'text'; key: string; text: string }
  | { kind: 'tool'; key: string; text: string; failed: boolean; running: boolean };

/**
 * The chat lines of messages in chronological order: user prompts, assistant text, and one line
 * per tool call or `!` command, labelled by {@link toolSummary}. Thoughts, notices and step
 * footers stay out, since the preview is a glance at the conversation. `directory` shortens the
 * paths under the session's directory.
 */
export function chatLines(
  messages: readonly SessionMessageInfo[],
  directory: string | undefined
): ChatLine[] {
  const lines: ChatLine[] = [];
  for (const message of messages) {
    if (message.type === 'user') {
      if (message.text.trim()) lines.push({ kind: 'user', key: message.id, text: message.text });
    } else if (message.type === 'shell') {
      lines.push({
        kind: 'tool',
        key: message.id,
        text: `$ ${firstLine(message.command)}`,
        failed:
          message.status === 'killed' ||
          message.status === 'timeout' ||
          (message.exit !== undefined && message.exit !== 0),
        running: message.status === 'running'
      });
    } else if (message.type === 'assistant') {
      let ordinal = 0;
      for (const part of message.content) {
        if (part.type === 'text') {
          const key = `${message.id}:text:${ordinal++}`;
          if (part.text.trim()) lines.push({ kind: 'text', key, text: part.text });
        } else if (part.type === 'tool') {
          const status = part.state.status;
          lines.push({
            kind: 'tool',
            key: `${message.id}:${part.id}`,
            text: toolSummary(part, directory),
            failed: status === 'error',
            running: status === 'streaming' || status === 'running'
          });
        }
      }
    }
  }
  return lines;
}

/**
 * A tool call in one line, with the labels the TUI's transcript gives its inline and block tools
 * (`toolView` in src/page/transcript.ts, from packages/tui/src/routes/session, MIT): `Read
 * src/a.ts:1-40`, `Grep "x" in src (3 matches)`, `$ pnpm test`, `Edit src/a.ts`. Tools the TUI
 * draws as a block show their header only.
 */
export function toolSummary(part: SessionMessageAssistantTool, directory?: string): string {
  const input = toolInput(part);
  const metadata = toolMetadata(part);
  const text = (key: string) => {
    const value = input[key];
    return typeof value === 'string' ? value : undefined;
  };
  const path = (value: string | undefined) => shortPath(value ?? '', directory);
  const where = text('path') ? ` in ${path(text('path'))}` : '';
  const matches = (value: unknown) =>
    typeof value === 'number' && value > 0
      ? ` (${value} ${value === 1 ? 'match' : 'matches'})`
      : '';
  const completed = part.state.status === 'completed';
  switch (canonicalTool(part.name)) {
    case 'shell':
      return text('command') ? `$ ${firstLine(text('command') ?? '')}` : 'Writing command…';
    case 'glob':
      return `Glob "${text('pattern') ?? ''}"${where}${matches(metadata.count)}`;
    case 'grep':
      return `Grep "${text('pattern') ?? ''}"${where}${matches(metadata.matches)}`;
    case 'read': {
      const offset = typeof input.offset === 'number' ? input.offset : 0;
      const limit = typeof input.limit === 'number' ? input.limit : 0;
      const range =
        input.offset !== undefined || input.limit !== undefined
          ? `:${offset || 1}-${limit ? (offset || 1) + limit - 1 : ''}`
          : '';
      return text('path') ? `Read ${path(text('path'))}${range}` : 'Reading file…';
    }
    case 'webfetch':
      return `WebFetch ${text('url') ?? ''}`;
    case 'websearch':
      return `Web Search "${text('query') ?? ''}"`;
    case 'write':
      return `${completed ? 'Wrote' : 'Write'} ${path(text('path'))}`;
    case 'edit':
      return `Edit ${path(patchFiles(metadata.files)[0]?.path ?? text('path'))}`;
    case 'patch': {
      const files = patchFiles(metadata.files);
      const first = files[0];
      if (first === undefined) return part.state.status === 'error' ? 'Patch failed' : 'Patching';
      const more = files.length > 1 ? ` +${files.length - 1}` : '';
      const verb =
        first.type === 'add' ? 'Created' : first.type === 'delete' ? 'Deleted' : 'Patched';
      return `${verb} ${path(first.path)}${more}`;
    }
    case 'todowrite':
      return part.state.status === 'error' ? 'Todo update failed' : 'Todos';
    case 'question': {
      const count = Array.isArray(input.questions) ? input.questions.length : 0;
      return `Asked ${count} question${count === 1 ? '' : 's'}`;
    }
    case 'skill': {
      const name = typeof metadata.name === 'string' ? metadata.name : text('id');
      return `Skill "${name ?? ''}"`;
    }
    case 'subagent': {
      const agent = text('agent') ?? text('subagent_type') ?? 'General';
      const name = text('sessionID') ? 'Continue subagent' : `${titlecase(agent)} Subagent`;
      return `${name}: ${text('description') ?? 'Subagent'}`;
    }
    case 'execute': {
      const calls = Array.isArray(metadata.toolCalls) ? metadata.toolCalls.length : 0;
      return calls > 0 ? `execute (${calls} call${calls === 1 ? '' : 's'})` : 'execute';
    }
    default: {
      const args = inputSummary(input).replace(/\s+/g, ' ');
      return `${part.name}${args ? ` ${args}` : ''}`;
    }
  }
}

/** A path relative to `directory` when it lies inside it, else as it is. */
function shortPath(value: string, directory: string | undefined): string {
  if (!directory || !value.startsWith(directory)) return value;
  const rest = value.slice(directory.length);
  if (rest === '') return '.';
  return rest.startsWith('/') || rest.startsWith('\\') ? rest.slice(1) : value;
}

/** The first line of a command, with `…` when more follow. */
function firstLine(text: string): string {
  const lines = text.trim().split('\n');
  return lines.length > 1 ? `${lines[0]}…` : (lines[0] ?? '');
}

/** Capitalizes each word, as the host does for agent names (packages/tui/src/util/locale.ts, MIT). */
export function titlecase(text: string): string {
  return text.replace(/\b\w/g, (letter) => letter.toUpperCase());
}
