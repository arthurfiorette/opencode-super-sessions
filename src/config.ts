import path from 'node:path';
import { z } from 'zod';
import { providerIdSchema, type RefStatus } from './refs/ref.js';

// Mirrors opencode-zero-trust: executables run without a shell, so arguments in the value would be
// treated as part of the program name and are rejected up front.
const executable = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value) || /^[\w.-]+$/.test(value), {
    message: 'Use an absolute executable path or a command name on PATH, without shell arguments.'
  });

// A bare DNS name: refs and remotes compare hosts without scheme, port or path.
const hostname = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i, {
    message: 'Use a host name such as code.example.com, without scheme, port or path.'
  });

const days = z.number().int().min(0).max(365);

const hex = z.string().regex(/^#[0-9a-f]{6}$/i, { message: 'Use a #rrggbb color.' });
const color = z.union([hex, z.strictObject({ dark: hex, light: hex })]);

// GitHub Primer foreground colors for each state, so the list reads like GitHub in either mode.
const githubColors: Record<RefStatus, { dark: string; light: string }> = {
  open: { dark: '#3fb950', light: '#1a7f37' },
  draft: { dark: '#9198a1', light: '#59636e' },
  merged: { dark: '#ab7df8', light: '#8250df' },
  closed: { dark: '#f85149', light: '#d1242f' },
  completed: { dark: '#ab7df8', light: '#8250df' },
  not_planned: { dark: '#9198a1', light: '#59636e' }
};

export const optionsSchema = z
  .strictObject({
    ghPath: executable.default('gh'),
    glabPath: executable.default('glab'),
    providers: z.array(providerIdSchema).min(1).default(['github']),
    gitlab: z
      .strictObject({
        /** Self-managed GitLab hosts whose names have no `gitlab` label, e.g. `code.acme.io`. */
        hosts: z.array(hostname).default([])
      })
      .default({ hosts: [] }),
    detect: z
      .strictObject({
        mentions: z.boolean().default(true),
        prompts: z.boolean().default(true)
      })
      .default({ mentions: true, prompts: true }),
    /** Tell the agent, with the user's next message, what was linked without it. */
    notices: z.boolean().default(true),
    search: z
      .strictObject({
        /** Index message text in the plugin's data directory and match it in search. */
        body: z.boolean().default(true)
      })
      .default({ body: true }),
    /** Archive a session and strip this suffix when its title ends with it, e.g. " !". */
    archiveSuffix: z.string().min(1).max(10).optional(),
    closeTabOnArchive: z.boolean().default(true),
    previewWidth: z.number().min(0.2).max(0.7).default(0.4),
    // Defaults for the settings dialog. A value changed in the dialog overrides these.
    /** Which sessions the browser lists when it opens. */
    scope: z.enum(['project', 'all']).default('project'),
    /**
     * Show the PR and issue lines on browser rows; `groupIssues` joins a row's issues on one
     * line instead of one line each.
     */
    rows: z
      .strictObject({
        refs: z.boolean().default(true),
        groupIssues: z.boolean().default(false)
      })
      .default({ refs: true, groupIssues: false }),
    /** Scroll a hovered title that does not fit. `auto` follows the host's `animations`. */
    titleScroll: z.enum(['auto', 'on', 'off']).default('auto'),
    /** Show the preview pane on wide terminals. */
    preview: z.boolean().default(true),
    /** Take over the session list on OpenCode releases newer than the tested one. */
    untestedHosts: z.boolean().default(false),
    /** Archive Done sessions this many days after they become Done. Unset keeps them. */
    autoArchiveDays: days.optional(),
    cleanup: z
      .strictObject({
        deletedSessions: z.boolean().default(false),
        merged: z.boolean().default(false),
        inactiveDays: days.min(1).optional(),
        doneDays: days.optional(),
        unchanged: z.boolean().default(false)
      })
      .default({ deletedSessions: false, merged: false, unchanged: false }),
    colors: z
      .strictObject({
        open: color.optional(),
        draft: color.optional(),
        merged: color.optional(),
        closed: color.optional(),
        completed: color.optional(),
        not_planned: color.optional()
      })
      .default({})
  })
  .default({
    ghPath: 'gh',
    glabPath: 'glab',
    providers: ['github'],
    gitlab: { hosts: [] },
    detect: { mentions: true, prompts: true },
    notices: true,
    search: { body: true },
    closeTabOnArchive: true,
    previewWidth: 0.4,
    scope: 'project',
    rows: { refs: true, groupIssues: false },
    titleScroll: 'auto',
    preview: true,
    untestedHosts: false,
    cleanup: { deletedSessions: false, merged: false, unchanged: false },
    colors: {}
  });

export type Options = z.output<typeof optionsSchema>;

/** Parses plugin options. Throws a zod error naming the bad field. */
export function parseOptions(input: unknown): Options {
  return optionsSchema.parse(input ?? undefined);
}

/** Resolves the hex color for a ref state in the current theme mode, honoring user overrides. */
export function stateColor(options: Options, status: RefStatus, mode: 'dark' | 'light'): string {
  const override = options.colors[status];
  if (typeof override === 'string') return override;
  return (override ?? githubColors[status])[mode];
}
