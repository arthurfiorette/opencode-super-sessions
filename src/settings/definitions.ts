import { z } from 'zod';
import type { Options } from '../config.js';
import type { ServerSettings } from '../rpc.js';

// The rows of the settings dialog and the TUI's own settings. No OpenTUI imports: the store and
// the tests load this from Node.

/** Preview width choices: the preview's fraction of the browser width. */
export const PREVIEW_WIDTHS = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6] as const;

export const tuiValuesSchema = z.strictObject({
  scope: z.enum(['project', 'all']),
  refLine: z.boolean(),
  /** `auto` follows the host's `animations` setting. */
  titleScroll: z.enum(['auto', 'on', 'off']),
  previewPane: z.boolean(),
  // The option's range, which is wider than the dialog's steps.
  previewWidth: z.number().min(0.2).max(0.7),
  closeTabOnArchive: z.boolean(),
  /** Null turns suffix archiving off. */
  archiveSuffix: z.string().min(1).max(10).nullable(),
  /** Take over the session list and the peek keys even on a host newer than TESTED_UP_TO. */
  untestedHosts: z.boolean()
});

export type TuiValues = z.output<typeof tuiValuesSchema>;

/** TUI defaults from the plugin entry's options. */
export function tuiDefaults(options: Options): TuiValues {
  return {
    scope: options.scope,
    refLine: options.rows.refs,
    titleScroll: options.titleScroll,
    previewPane: options.preview,
    previewWidth: options.previewWidth,
    closeTabOnArchive: options.closeTabOnArchive,
    archiveSuffix: options.archiveSuffix ?? null,
    untestedHosts: options.untestedHosts
  };
}

/** Parses each stored TUI value on its own, dropping invalid ones. */
export function readTuiOverrides(stored: unknown): Partial<TuiValues> {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
  const shape = tuiValuesSchema.shape;
  const valid: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (!(key in shape)) continue;
    const parsed = shape[key as keyof typeof shape].safeParse(value);
    if (parsed.success) valid[key] = parsed.data;
  }
  return valid as Partial<TuiValues>;
}

/** Where a setting is stored and applied. */
export type SettingSide = 'tui' | 'server';

/** One row of the dialog. */
export type SettingRow =
  | ({ side: 'tui'; key: keyof TuiValues } & RowShape)
  | ({ side: 'server'; key: keyof ServerSettings } & RowShape)
  | {
      side: 'action';
      key: 'cleanup.run';
      group: string;
      title: string;
      description: string;
      keywords?: readonly string[];
    };

interface RowShape {
  group: string;
  title: string;
  /** Muted line under the list while the row is selected. A function reads the current value. */
  description: string | ((value: unknown) => string);
  /** Values `←/→` cycle through, in order. */
  values: readonly unknown[];
  labels?: readonly string[];
  /** Label for any value, used instead of `labels`. */
  format?: (value: unknown) => string;
  keywords?: readonly string[];
  /** Enter opens a text prompt for a custom value instead of cycling. */
  prompt?: { title: string; placeholder: string };
}

const onOff = { values: [false, true], labels: ['off', 'on'] } as const;
const afterDays = (days: readonly (number | null)[], zero: string) => ({
  values: days,
  labels: days.map((day) =>
    day === null ? 'off' : day === 0 ? zero : `after ${day} ${day === 1 ? 'day' : 'days'}`
  )
});

/** Every row, in display order. Groups follow the order of their first row. */
export const SETTINGS: readonly SettingRow[] = [
  {
    side: 'tui',
    key: 'scope',
    group: 'List',
    title: 'Default scope',
    description: 'Which sessions the browser lists when it opens',
    values: ['project', 'all'],
    labels: ['this project', 'all projects'],
    keywords: ['projects', 'filter']
  },
  {
    side: 'tui',
    key: 'refLine',
    group: 'List',
    title: 'PR and issue line',
    description: 'Whether rows show the pull requests and issues of the session',
    ...onOff,
    keywords: ['pull request', 'refs']
  },
  {
    side: 'tui',
    key: 'titleScroll',
    group: 'List',
    title: 'Title scrolling on hover',
    description:
      'Whether a long title in the sidebar and preview Work rows scrolls while the mouse is over it',
    values: ['auto', 'off', 'on'],
    labels: ['follow animations', 'off', 'on'],
    keywords: ['marquee', 'animation']
  },
  {
    side: 'tui',
    key: 'previewPane',
    group: 'Preview',
    title: 'Preview pane',
    description: 'Whether the browser shows the selected session next to the list',
    ...onOff,
    keywords: ['transcript']
  },
  {
    side: 'tui',
    key: 'previewWidth',
    group: 'Preview',
    title: 'Preview width',
    description: 'Share of the browser width the preview takes',
    values: PREVIEW_WIDTHS,
    // Any number, since the options may set a width between the listed steps.
    format: (value) => `${Math.round(Number(value) * 100)}%`,
    keywords: ['size', 'columns']
  },
  {
    side: 'tui',
    key: 'closeTabOnArchive',
    group: 'Archiving',
    title: 'Close tab when archiving',
    description: 'Whether archiving a session also closes its tab',
    ...onOff,
    keywords: ['tabs']
  },
  {
    side: 'tui',
    key: 'archiveSuffix',
    group: 'Archiving',
    title: 'Archive on title suffix',
    description: 'Archives a session when its title ends with this text, and removes the text',
    values: [null, ' !'],
    labels: ['off', '" !"'],
    prompt: {
      title: 'Archive on title suffix',
      placeholder: 'Text at the end of a title, e.g. " !"'
    },
    keywords: ['rename', 'mark']
  },
  {
    side: 'server',
    key: 'autoArchiveDays',
    group: 'Archiving',
    title: 'Auto-archive Done sessions',
    description:
      'Archives Done sessions after this long, except pinned ones. Needs a terminal open.',
    ...afterDays([null, 0, 1, 3, 7], 'immediately'),
    keywords: ['done', 'automatic']
  },
  {
    side: 'server',
    key: 'trackMentions',
    group: 'Tracking',
    title: 'Record mentioned refs',
    description: 'Whether links in assistant replies are kept for search and the preview',
    ...onOff,
    keywords: ['mentions', 'links']
  },
  {
    side: 'server',
    key: 'trackPrompts',
    group: 'Tracking',
    title: 'Record refs from prompts',
    description: 'Whether pull requests and issues named in your prompts are tracked',
    ...onOff,
    keywords: ['prompts', 'issues']
  },
  {
    side: 'server',
    key: 'providers',
    group: 'Tracking',
    title: 'Providers',
    description: 'Which forges are asked for pull request and issue state',
    values: ['github', 'gitlab', 'both'],
    labels: ['GitHub', 'GitLab', 'both'],
    keywords: ['github', 'gitlab', 'forge']
  },
  {
    side: 'server',
    key: 'cleanupDeleted',
    group: 'Cleanup',
    title: 'Delete worktrees of deleted sessions',
    description:
      'Removes unused worktrees when their sessions are deleted. Worktrees with local changes are kept.',
    ...onOff,
    keywords: ['worktree', 'delete']
  },
  {
    side: 'server',
    key: 'cleanupMerged',
    group: 'Cleanup',
    title: 'Delete merged worktrees',
    description:
      'Removes worktrees whose pull request is merged, including squash and rebase merges, when the branch has no commits the pull request did not include.',
    ...onOff,
    keywords: ['worktree', 'merged']
  },
  {
    side: 'server',
    key: 'cleanupInactiveDays',
    group: 'Cleanup',
    title: 'Delete inactive worktrees',
    description:
      'Removes worktrees after their sessions have been inactive this many days. Branches and session history are kept.',
    ...afterDays([null, 3, 7, 14, 30], 'immediately'),
    keywords: ['worktree', 'inactive', 'stale']
  },
  {
    side: 'server',
    key: 'cleanupDoneDays',
    group: 'Cleanup',
    title: 'Delete worktrees of Done sessions',
    description:
      'Removes worktrees this long after their session becomes Done. Branches and session history are kept.',
    ...afterDays([null, 0, 1, 3, 7], 'immediately'),
    keywords: ['worktree', 'done', 'settled']
  },
  {
    side: 'server',
    key: 'cleanupUnchanged',
    group: 'Cleanup',
    title: 'Delete unchanged worktrees',
    description: 'Removes worktrees with no commits beyond the default branch.',
    ...onOff,
    keywords: ['worktree', 'empty']
  },
  {
    side: 'server',
    key: 'keepLocalChanges',
    group: 'Cleanup',
    title: 'Keep worktrees with local changes',
    description: (value) =>
      value === 'tracked'
        ? 'Keeps worktrees with edited tracked files. Ignored files such as .env are deleted.'
        : value === 'uncommitted'
          ? 'Keeps worktrees with edited or staged files. Ignored files such as .env are deleted.'
          : 'Keeps worktrees with edited, staged or untracked files. Ignored files such as .env are deleted.',
    values: ['any', 'uncommitted', 'tracked'],
    labels: ['any local files', 'uncommitted changes', 'edited tracked files'],
    keywords: ['worktree', 'dirty', 'untracked']
  },
  {
    side: 'action',
    key: 'cleanup.run',
    group: 'Cleanup',
    title: 'Run cleanup now',
    description: 'Lists what the rules above would remove and asks before removing anything',
    keywords: ['worktree', 'dry run', 'clean']
  },
  {
    side: 'tui',
    key: 'untestedHosts',
    group: 'Compatibility',
    title: 'Use on untested OpenCode versions',
    description:
      'Whether the browser replaces the session list and takes the peek keys on an OpenCode release newer than the one this plugin was tested with',
    ...onOff,
    keywords: ['version', 'upgrade', 'takeover']
  }
];

/**
 * Rows matching a search, keeping display order: every word of the query must appear in the
 * row's title, group or keywords.
 */
export function filterRows(rows: readonly SettingRow[], query: string): SettingRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...rows];
  return rows.filter((row) => {
    const text = [row.title, row.group, ...(row.keywords ?? [])].join(' ').toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** The label of a row's value: its own label, a quoted custom suffix, or the plain value. */
export function displayValue(row: Exclude<SettingRow, { side: 'action' }>, value: unknown): string {
  if (row.format) return row.format(value);
  const index = row.values.indexOf(value);
  if (index !== -1) return row.labels?.[index] ?? String(value);
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
}

/**
 * The value after `value` in `direction` (1 or -1), wrapping around. A value outside the list,
 * such as a custom suffix or a preview width from the options, steps into the list: a number to
 * its nearest listed neighbor that way, anything else to the first or last value.
 */
export function stepValue(values: readonly unknown[], value: unknown, direction: number): unknown {
  const index = values.indexOf(value);
  if (index !== -1) {
    return values[(index + direction + values.length) % values.length];
  }
  if (typeof value === 'number') {
    // Snap a fixed width the options set (0.42) to the next listed width that way.
    const numbers = values.filter((item): item is number => typeof item === 'number');
    const next =
      direction > 0
        ? numbers.find((item) => item > value)
        : [...numbers].reverse().find((item) => item < value);
    return next ?? values[direction > 0 ? 0 : values.length - 1];
  }
  return values[direction > 0 ? 0 : values.length - 1];
}
