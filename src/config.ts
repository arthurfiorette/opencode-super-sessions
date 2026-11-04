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
    providers: z.array(providerIdSchema).min(1).default(['github']),
    detect: z
      .strictObject({
        mentions: z.boolean().default(true),
        prompts: z.boolean().default(true)
      })
      .default({ mentions: true, prompts: true }),
    /** Archive a session and strip this suffix when its title ends with it, e.g. " !". */
    archiveSuffix: z.string().min(1).max(10).optional(),
    closeTabOnArchive: z.boolean().default(true),
    previewWidth: z.number().min(0.2).max(0.7).default(0.4),
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
    providers: ['github'],
    detect: { mentions: true, prompts: true },
    closeTabOnArchive: true,
    previewWidth: 0.4,
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
