import { z } from 'zod';

/** Session metadata key that holds this plugin's links. Other metadata keys are preserved on write. */
export const METADATA_KEY = 'super-sessions';

export const providerIdSchema = z.enum(['github', 'gitlab']);
export const refKindSchema = z.enum(['pr', 'issue']);

/**
 * A pull request (or merge request) or issue on a forge. `repo` is `owner/name`, or a nested
 * GitLab path such as `group/subgroup/name`.
 */
export const refSchema = z.strictObject({
  provider: providerIdSchema,
  host: z.string().min(1),
  repo: z.string().regex(/^[^/\s]+(?:\/[^/\s]+)+$/),
  kind: refKindSchema,
  number: z.number().int().positive()
});

/**
 * How a link entered a session. `branch` refs are never stored: they are recomputed from the
 * session's live branch on every read.
 *
 * - `agent`: the agent called `link_work`.
 * - `created`: the agent ran a forge create command (`gh pr create`) and printed its URL.
 * - `manual`: the user linked it from the session page.
 * - `prompt`: referenced in one of the user's prompts.
 * - `mention`: referenced by URL or `owner/repo#N` in assistant text. Search and preview only.
 * - `closes`: an issue that a tracked PR closes, recorded with `via` set to the PR's key.
 */
export const refSourceSchema = z.enum([
  'agent',
  'created',
  'manual',
  'prompt',
  'mention',
  'closes'
]);

export const refLinkSchema = z.strictObject({
  ref: refSchema,
  source: refSourceSchema,
  linkedAt: z.number().int().nonnegative(),
  via: z.string().optional()
});

/** Value stored under {@link METADATA_KEY} in session metadata. */
export const sessionRefsSchema = z.strictObject({
  v: z.literal(1),
  links: z.array(refLinkSchema),
  // Keys the user or agent unlinked. Detection must never add these back.
  dismissed: z.array(z.string()),
  // The user's Done override: `true` is Done whatever the refs say, `false` never Done, unset
  // follows the rule. `doneAt` is when `true` was set, which auto-archive counts days from.
  done: z.boolean().optional(),
  doneAt: z.number().int().nonnegative().optional(),
  // Set when the history scan finished reading the session's stored messages (`history.scan`),
  // so it runs once per session. `lastMessageID` is the newest message it read; live detection
  // covers the ones after it.
  scanned: z
    .strictObject({
      scannedAt: z.number().int().nonnegative(),
      lastMessageID: z.string().optional()
    })
    .optional()
});

/**
 * Live forge state. Issues use `open`, `completed` or `not_planned`; pull requests use `open`,
 * `draft`, `merged` or `closed`.
 */
export const refStatusSchema = z.enum([
  'open',
  'draft',
  'merged',
  'closed',
  'completed',
  'not_planned'
]);

/**
 * Review and CI summary of a pull or merge request. Every field is optional: a forge or server
 * that does not report one leaves it out, and states cached before this existed stay valid.
 *
 * - `decision`: the forge's review verdict; absent when nobody reviewed and none is required.
 * - `unresolved` / `threads`: resolvable review threads still open, and all of them.
 * - `checks`: the head commit's combined CI result; absent when nothing ran.
 */
export const refReviewSchema = z.strictObject({
  decision: z.enum(['approved', 'changes_requested', 'review_required']).optional(),
  unresolved: z.number().int().nonnegative().optional(),
  threads: z.number().int().nonnegative().optional(),
  checks: z.enum(['passing', 'failing', 'pending']).optional()
});

export const refStateSchema = z.strictObject({
  status: refStatusSchema,
  title: z.string(),
  url: z.string(),
  mergedAt: z.number().int().optional(),
  closedAt: z.number().int().optional(),
  // Pull requests: issues this PR closes when merged.
  closes: z.array(refSchema).optional(),
  // Issues: pull requests that reference this issue as closed by them.
  closedBy: z.array(refSchema).optional(),
  // Pull requests only.
  review: refReviewSchema.optional(),
  // Pull requests only: the head commit, which worktree cleanup compares a local branch with.
  headSha: z
    .string()
    .regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/)
    .optional()
});

export type ProviderId = z.output<typeof providerIdSchema>;
export type RefKind = z.output<typeof refKindSchema>;
export type Ref = z.output<typeof refSchema>;
export type RefSource = z.output<typeof refSourceSchema>;
export type RefLink = z.output<typeof refLinkSchema>;
export type SessionRefs = z.output<typeof sessionRefsSchema>;
export type RefStatus = z.output<typeof refStatusSchema>;
export type RefReview = z.output<typeof refReviewSchema>;
export type RefState = z.output<typeof refStateSchema>;

/** Sources whose refs count toward Done and appear on the row. `mention` is excluded on purpose. */
export const TRACKED_SOURCES: ReadonlySet<RefSource> = new Set([
  'agent',
  'created',
  'manual',
  'prompt',
  'closes'
]);

/**
 * Stable identity of a ref, used for dedupe, dismissal and the snapshot cache.
 * Kind is part of the key because GitLab numbers merge requests and issues separately.
 */
export function refKey(ref: Ref): string {
  return `${ref.provider}:${ref.host}/${ref.repo}/${ref.kind}/${ref.number}`.toLowerCase();
}

/**
 * The short number a forge shows for a ref: `!12` for GitLab merge requests, `#12` otherwise.
 * GitLab numbers merge requests and issues separately, so `#12` there always means an issue.
 */
export function refNumber(ref: Pick<Ref, 'provider' | 'number'> & { kind?: RefKind }): string {
  return `${ref.provider === 'gitlab' && ref.kind === 'pr' ? '!' : '#'}${ref.number}`;
}

/** Empty metadata value for sessions that have no links yet. */
export function emptySessionRefs(): SessionRefs {
  return { v: 1, links: [], dismissed: [] };
}

/**
 * Reads this plugin's value from session metadata. Invalid or foreign values are treated as
 * empty so a malformed write by another client cannot break the session list.
 */
export function readSessionRefs(metadata: Record<string, unknown> | undefined): SessionRefs {
  const parsed = sessionRefsSchema.safeParse(metadata?.[METADATA_KEY]);
  return parsed.success ? parsed.data : emptySessionRefs();
}
