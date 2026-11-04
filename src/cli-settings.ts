import { type FSWatcher, readFileSync, watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { onCleanup } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { cliConfigPath } from './host/files.js';

// The host's TUI settings, which the plugin API does not expose. Read-only: the file belongs to
// the host, which writes it from its own commands ("Toggle session scrollbar" and the like).
// Mirrors packages/cli/src/config/config.ts (file, env overlay, deep merge) and the defaults the
// session view applies in packages/tui/src/routes/session/index.tsx (MIT).

/** The subset of the host's `cli.json` the plugin follows, with the host's defaults applied. */
export interface CliSettings {
  session: {
    /** Draw a scrollbar on scrolling transcripts and lists. */
    scrollbar: boolean;
    /** `show` opens every thought; `hide` folds each run of thoughts into one line. */
    thinking: 'show' | 'hide';
    /** `rendered` conceals Markdown markers; `source` shows them. */
    markdown: 'source' | 'rendered';
    /** `low` folds each run of tools and thoughts into one summary; `high` opens groups. */
    verbosity: 'low' | 'medium' | 'high';
    /** `none` lists reads and searches one by one instead of as one `Explored` line. */
    grouping: 'auto' | 'none';
  };
  /** Spinners, scrolling titles and other motion. */
  animations: boolean;
}

/** What the host's session view uses when a setting is unset. */
const DEFAULTS: CliSettings = {
  session: {
    scrollbar: false,
    thinking: 'hide',
    markdown: 'rendered',
    verbosity: 'medium',
    grouping: 'auto'
  },
  animations: true
};

const CHOICES = {
  thinking: ['show', 'hide'],
  markdown: ['source', 'rendered'],
  verbosity: ['low', 'medium', 'high'],
  grouping: ['auto', 'none']
} as const;

// The host saves through a temp file and a rename, which fires several events per save.
const RELOAD_DELAY = 50;

/**
 * Settings from the file's text (undefined when there is no file) with the
 * `OPENCODE_CLI_CONFIG_CONTENT` overlay merged over it key by key. Undefined when the file
 * exists but the host would reject it (bad JSONC, or a wrong value in one of these settings), so
 * the caller can keep the last good values while the file is mid-edit. An invalid overlay is
 * ignored, as in the host.
 */
export function parseCliSettings(
  file: string | undefined,
  content: string | undefined
): CliSettings | undefined {
  const base = file === undefined ? {} : valid(parseJsonc(file));
  if (base === undefined) return undefined;
  const overlay = content ? (valid(parseJsonc(content)) ?? {}) : {};
  const merged = merge(base, overlay);
  const session = isRecord(merged.session) ? merged.session : {};
  return {
    session: {
      scrollbar:
        typeof session.scrollbar === 'boolean' ? session.scrollbar : DEFAULTS.session.scrollbar,
      thinking: choice(session.thinking, CHOICES.thinking) ?? DEFAULTS.session.thinking,
      markdown: choice(session.markdown, CHOICES.markdown) ?? DEFAULTS.session.markdown,
      verbosity: choice(session.verbosity, CHOICES.verbosity) ?? DEFAULTS.session.verbosity,
      grouping: choice(session.grouping, CHOICES.grouping) ?? DEFAULTS.session.grouping
    },
    animations: typeof merged.animations === 'boolean' ? merged.animations : DEFAULTS.animations
  };
}

const [settings, setSettings] = createStore<CliSettings>(structuredClone(DEFAULTS));
let users = 0;
let stop: (() => void) | undefined;

/**
 * The host's settings as a read-only store, current with the file. Call it inside a component:
 * the first caller starts watching the config directory and the last one to unmount stops it,
 * so the watch ends with the plugin's views.
 */
export function useCliSettings(): Readonly<CliSettings> {
  if (users++ === 0) stop = start();
  onCleanup(() => {
    if (--users > 0) return;
    stop?.();
    stop = undefined;
  });
  return settings;
}

/** Loads the file now, then reloads it on every change until the returned function runs. */
function start(): () => void {
  const file = cliConfigPath();
  const apply = (text: string | undefined) => {
    const next = parseCliSettings(text, process.env.OPENCODE_CLI_CONFIG_CONTENT);
    if (next) setSettings(reconcile(next));
  };
  // Synchronous once, so the first frame already uses the user's settings.
  apply(readText(() => readFileSync(file, 'utf8')));

  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reload = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const current = ++generation;
      void readFile(file, 'utf8').then(
        (text) => {
          if (current === generation) apply(text);
        },
        (error: NodeJS.ErrnoException) => {
          // A deleted file means defaults, as in the host; other read errors keep the values.
          if (current === generation && error.code === 'ENOENT') apply(undefined);
        }
      );
    }, RELOAD_DELAY);
  };
  const watcher = watchDirectory(path.dirname(file), reload);
  return () => {
    generation++;
    clearTimeout(timer);
    watcher?.close();
  };
}

/** The file's text, or undefined when it does not exist or cannot be read. */
function readText(read: () => string): string | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * Watches the directory, as the host does, so a file created or replaced by a rename is still
 * seen. Honors the host's watcher switch. A failed watch only loses live reload.
 */
function watchDirectory(directory: string, listener: () => void): FSWatcher | undefined {
  const disabled =
    process.env.OPENCODE_FILEWATCHER_DISABLE ?? process.env.OPENCODE_DISABLE_FILEWATCHER;
  if (disabled === '1' || disabled?.toLowerCase() === 'true') return undefined;
  try {
    const watcher = watch(directory, listener);
    watcher.on('error', () => watcher.close());
    // Never keeps the process alive on its own, for example in tests.
    watcher.unref();
    return watcher;
  } catch {
    return undefined;
  }
}

/** The parsed record when it fits the host's schema for these settings, else undefined. */
function valid(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (value.animations !== undefined && typeof value.animations !== 'boolean') return undefined;
  const session = value.session;
  if (session === undefined) return value;
  if (!isRecord(session)) return undefined;
  if (session.scrollbar !== undefined && typeof session.scrollbar !== 'boolean') return undefined;
  for (const [key, options] of Object.entries(CHOICES)) {
    if (session[key] !== undefined && choice(session[key], options) === undefined) return undefined;
  }
  return value;
}

/** `value` when it is one of `options`. */
function choice<const Option extends string>(
  value: unknown,
  options: readonly Option[]
): Option | undefined {
  return options.find((option) => option === value);
}

/** `overlay` over `base`, merging nested records instead of replacing them (`mergeRecords`). */
function merge(base: Record<string, unknown>, overlay: Record<string, unknown>) {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = result[key];
    result[key] = isRecord(current) && isRecord(value) ? merge(current, value) : value;
  }
  return result;
}

/** A plain object, not an array or null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * JSON with comments and trailing commas, like `jsonc-parser` with `allowTrailingComma`, which
 * the host uses. Undefined on any syntax error.
 */
function parseJsonc(text: string): unknown {
  const stripped = withoutTrailingCommas(withoutComments(text));
  if (stripped === undefined) return undefined;
  try {
    return JSON.parse(stripped);
  } catch {
    return undefined;
  }
}

/** The text with comments replaced by spaces; strings, which may hold `//` in URLs, are kept. */
function withoutComments(text: string): string | undefined {
  let out = '';
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === '"') {
      const end = stringEnd(text, at);
      out += text.slice(at, end);
      at = end - 1;
      continue;
    }
    if (char === '/' && text[at + 1] === '/') {
      const end = text.indexOf('\n', at);
      at = (end === -1 ? text.length : end) - 1;
      out += ' ';
      continue;
    }
    if (char === '/' && text[at + 1] === '*') {
      const end = text.indexOf('*/', at + 2);
      if (end === -1) return undefined;
      at = end + 1;
      out += ' ';
      continue;
    }
    out += char;
  }
  return out;
}

/** The text without commas that only whitespace separates from a closing `}` or `]`. */
function withoutTrailingCommas(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const closes = /\s*[}\]]/y;
  let out = '';
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === '"') {
      const end = stringEnd(text, at);
      out += text.slice(at, end);
      at = end - 1;
      continue;
    }
    if (char === ',') {
      closes.lastIndex = at + 1;
      if (closes.test(text)) continue;
    }
    out += char;
  }
  return out;
}

/** Index just past the string literal that opens at `start`, or the text's end if unclosed. */
function stringEnd(text: string, start: number): number {
  for (let at = start + 1; at < text.length; at++) {
    if (text[at] === '\\') at++;
    else if (text[at] === '"') return at + 1;
  }
  return text.length;
}
