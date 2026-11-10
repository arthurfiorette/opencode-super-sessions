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

/**
 * A web page the session works on outside the forges, such as a Linear issue or any URL (see
 * `src/refs/work-link.ts`). Only explicit links and tracker URLs in prompts are stored; assistant
 * text never adds one. `title` is what the agent gave, which wins over the URL's slug.
 */
export const workLinkSchema = z.strictObject({
  url: z.string().min(1).max(2000),
  source: z.enum(['agent', 'manual', 'prompt']),
  linkedAt: z.number().int().nonnegative(),
  title: z.string().min(1).max(300).optional()
});

/** Value stored under {@link METADATA_KEY} in session metadata. */
export const sessionRefsSchema = z.strictObject({
  v: z.literal(1),
  links: z.array(refLinkSchema),
  // Work links. Optional, so values written before they existed stay valid; versions without it
  // read a value that has it as unparseable and never overwrite it.
  urls: z.array(workLinkSchema).optional(),
  // Keys the user or agent unlinked. Detection must never add these back.
  dismissed: z.array(z.string()),
  // The user's Done override: `true` is Done whatever the refs say, `false` never Done, unset
  // follows the rule. `doneAt` is when `true` was set, which auto-archive counts days from.
  done: z.boolean().optional(),
  doneAt: z.number().int().nonnegative().optional(),
  // Set when the history scan finished reading the session's stored messages (`history.scan`),
  // so it runs once per session. `lastMessageID` is the newest message it read; live detection
  // covers the ones after it. `pushes` says the scan also looked for `git push`, and `links` for
  // work links in prompts; a marker without one is from a version that did not, and earns one
  // more pass for what it missed.
  scanned: z
    .strictObject({
      scannedAt: z.number().int().nonnegative(),
      lastMessageID: z.string().optional(),
      pushes: z.literal(true).optional(),
      links: z.literal(true).optional()
    })
    .optional(),
  // Branches the session pushed with `git push`, oldest first. A branch pull request opened
  // before the session counts for it only when its head is one of these.
  pushed: z.array(z.string().min(1)).optional(),
  // A session's activity time before the plugin first wrote it, for sessions without run times,
  // whose only activity record is `time.updated` and which that write moves. The write queue
  // stamps it; `activityTime` in src/host/session-api.ts reads it.
  activeAt: z.number().int().nonnegative().optional()
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
 * - `checks`: the head commit's combined CI result; absent when nothing ran. `cancelled` when
 *   the only checks that did not pass were cancelled: nothing failed and nothing still runs.
 * - `checksPassed` / `checksTotal`: how many checks passed out of all of them, drawn as `91/93`
 *   unless every check passed.
 *   GitHub counts successful, neutral and skipped check runs and successful statuses as passed;
 *   GitLab counts successful and skipped jobs of the head pipeline, without retried or manual ones.
 * - `checksSkipped` / `checksCancelled` / `checksPending` / `checksFailed`: the rest of the
 *   breakdown (see `tallyOf` in `src/page/checks.ts`); skipped checks are part of
 *   `checksPassed`. GitHub only, where the counts cost nothing; GitLab's come from the details.
 * - `conflicts`: whether the branch conflicts with its base; absent while the forge has not
 *   computed it, which the snapshot cache then fills with the last known answer.
 */
export const refReviewSchema = z.strictObject({
  decision: z.enum(['approved', 'changes_requested', 'review_required']).optional(),
  unresolved: z.number().int().nonnegative().optional(),
  threads: z.number().int().nonnegative().optional(),
  checks: z.enum(['passing', 'failing', 'pending', 'cancelled']).optional(),
  checksPassed: z.number().int().nonnegative().optional(),
  checksTotal: z.number().int().nonnegative().optional(),
  checksSkipped: z.number().int().nonnegative().optional(),
  checksCancelled: z.number().int().nonnegative().optional(),
  checksPending: z.number().int().nonnegative().optional(),
  checksFailed: z.number().int().nonnegative().optional(),
  conflicts: z.boolean().optional()
});

export const refStateSchema = z.strictObject({
  status: refStatusSchema,
  title: z.string(),
  url: z.string(),
  mergedAt: z.number().int().optional(),
  closedAt: z.number().int().optional(),
  // Pull requests only: the last change on the forge, which the Pull requests view groups by.
  updatedAt: z.number().int().optional(),
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

/**
 * One CI check of a pull request's head commit: a GitHub check run or status, or a GitLab job.
 * `url` opens its page.
 */
export const pullCheckSchema = z.strictObject({
  name: z.string(),
  status: z.enum([
    'failure',
    'cancelled',
    'action_required',
    'pending',
    'success',
    'neutral',
    'skipped'
  ]),
  url: z.string().optional()
});

/**
 * What the Pull requests view's preview shows beyond the snapshot, fetched for the selected pull
 * request only. `checksTruncated` says more checks ran than the first page holds.
 */
export const pullDetailsSchema = z.strictObject({
  author: z.string().optional(),
  head: z.string().optional(),
  base: z.string().optional(),
  body: z.string(),
  checks: z.array(pullCheckSchema),
  checksTruncated: z.boolean().optional()
});

export type PullCheck = z.output<typeof pullCheckSchema>;
export type PullDetails = z.output<typeof pullDetailsSchema>;
export type ProviderId = z.output<typeof providerIdSchema>;
export type RefKind = z.output<typeof refKindSchema>;
export type Ref = z.output<typeof refSchema>;
export type RefSource = z.output<typeof refSourceSchema>;
export type RefLink = z.output<typeof refLinkSchema>;
export type WorkLink = z.output<typeof workLinkSchema>;
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

/**
 * Whether the history scan is done with a session: it read every stored message, pushes and work
 * links included. The TUI skips such sessions without a request, and the server answers
 * `skipped`.
 */
export function historyScanned(refs: SessionRefs): boolean {
  return refs.scanned?.pushes === true && refs.scanned.links === true;
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
