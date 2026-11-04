import { Rpc } from '@opencode/plugin/rpc';
import { z } from 'zod';
import { keepModeSchema } from './config.js';
import { providerIdSchema, refLinkSchema, refSchema, refStateSchema } from './refs/ref.js';

export const availabilitySchema = z.enum(['ok', 'missing-tool', 'unauthenticated']);

/** Everything the TUI needs to draw one session's refs. */
export const sessionRefViewSchema = z.strictObject({
  links: z.array(refLinkSchema),
  /** Current branch of the session's directory, when it is a git checkout. */
  branch: z.string().optional(),
  /** Default branch of the session's repository. The row hides the branch when they match. */
  defaultBranch: z.string().optional(),
  /** Pull requests whose head is `branch`. Recomputed, never stored. */
  branchRefs: z.array(refSchema),
  /** Live state by `refKey`. Missing entries are unknown (not fetched yet, or the fetch failed). */
  states: z.record(z.string(), refStateSchema),
  /** The user's Done override (see `done.set`); absent follows the refs. */
  done: z.boolean().optional(),
  /** When the user marked the session Done. */
  doneAt: z.number().int().optional()
});

export const searchScopeSchema = z.union([
  z.strictObject({ type: z.literal('all') }),
  z.strictObject({ type: z.literal('directory'), directory: z.string() }),
  z.strictObject({ type: z.literal('project'), project: z.string(), subpath: z.string() })
]);

export const searchMatchSchema = z.enum(['title', 'ref-number', 'ref-title', 'body']);

export const searchHitSchema = z.strictObject({
  sessionID: z.string(),
  match: searchMatchSchema,
  /** `refKey` of the ref that matched, for `ref-number` and `ref-title` matches. */
  ref: z.string().optional(),
  /** Higher sorts first. Ties keep the server's most-recently-updated order. */
  score: z.number()
});

// Settings the server plugin applies, changed from the TUI's settings dialog.

export const providerChoiceSchema = z.enum(['github', 'gitlab', 'both']);
const days = z.number().int().min(0).max(365);

/** Every server setting. `null` days mean the rule is off. */
export const serverSettingsSchema = z.strictObject({
  /** Days after a session becomes Done before it is archived; 0 archives at the next sweep. */
  autoArchiveDays: days.nullable(),
  trackMentions: z.boolean(),
  trackPrompts: z.boolean(),
  providers: providerChoiceSchema,
  cleanupDeleted: z.boolean(),
  cleanupMerged: z.boolean(),
  cleanupInactiveDays: days.min(1).nullable(),
  cleanupDoneDays: days.nullable(),
  cleanupUnchanged: z.boolean(),
  keepLocalChanges: keepModeSchema
});

/** Effective values and the plugin-option defaults they override. */
export const serverSettingsViewSchema = z.strictObject({
  values: serverSettingsSchema,
  defaults: serverSettingsSchema
});

export const cleanupRuleSchema = z.enum(['deleted', 'merged', 'inactive', 'done', 'unchanged']);

/** What cleanup would do with one worktree OpenCode knows, and why. */
export const worktreeDecisionSchema = z.strictObject({
  directory: z.string(),
  action: z.enum(['remove', 'keep']),
  /** The rule that selected a removal. */
  rule: cleanupRuleSchema.optional(),
  /** Short reason in plain words, shown in the dry run and logs. */
  reason: z.string()
});

const directories = z.array(z.string()).max(200);

export type ProviderChoice = z.output<typeof providerChoiceSchema>;
export type ServerSettings = z.output<typeof serverSettingsSchema>;
export type ServerSettingsView = z.output<typeof serverSettingsViewSchema>;
export type CleanupRule = z.output<typeof cleanupRuleSchema>;
export type WorktreeDecision = z.output<typeof worktreeDecisionSchema>;

export type Availability = z.output<typeof availabilitySchema>;
export type SessionRefView = z.output<typeof sessionRefViewSchema>;
export type SearchScope = z.output<typeof searchScopeSchema>;
export type SearchMatch = z.output<typeof searchMatchSchema>;
export type SearchHit = z.output<typeof searchHitSchema>;

const sessionIDs = z.array(z.string()).max(200);

/**
 * RPC contract between the TUI and the server plugin. Kept free of OpenTUI imports so
 * any client can call it.
 */
export const SuperSessions = Rpc.define({
  id: 'opencode-super-sessions',
  methods: {
    status: {
      input: z.strictObject({}),
      output: z.strictObject({ providers: z.partialRecord(providerIdSchema, availabilitySchema) })
    },
    /** Cached refs and states. Never waits on the forge; stale entries refresh in the background. */
    refs: {
      input: z.strictObject({ sessionIDs }),
      output: z.record(z.string(), sessionRefViewSchema)
    },
    /** Like `refs`, but waits for a forge refresh of entries whose cache expired, or all with `force`. */
    refresh: {
      input: z.strictObject({ sessionIDs, force: z.boolean().optional() }),
      output: z.record(z.string(), sessionRefViewSchema)
    },
    search: {
      input: z.strictObject({
        query: z.string().min(1).max(500),
        scope: searchScopeSchema,
        archived: z.boolean(),
        limit: z.number().int().positive().max(200).optional()
      }),
      output: z.array(searchHitSchema)
    },
    /** Links a pasted URL, `owner/repo#N` or `#N` (resolved against the session's repository). */
    link: {
      input: z.strictObject({ sessionID: z.string(), reference: z.string().min(1).max(500) }),
      output: refLinkSchema,
      errors: {
        invalid_reference: z.strictObject({}),
        not_found: z.strictObject({}),
        /** `provider` names the forge that could not be asked, when the reference named one. */
        unavailable: z.strictObject({
          reason: z.string(),
          provider: providerIdSchema.optional()
        })
      }
    },
    /** Removes a link and records the key as dismissed so detection never re-adds it. */
    unlink: {
      input: z.strictObject({ sessionID: z.string(), key: z.string() }),
      output: z.strictObject({})
    },
    /**
     * Overrides whether the session is Done: `true` makes an idle, unarchived session Done
     * whatever its refs say, `false` keeps it out of Done, `null` goes back to the refs.
     */
    'done.set': {
      input: z.strictObject({ sessionID: z.string(), done: z.boolean().nullable() }),
      output: z.strictObject({})
    },
    'settings.get': {
      input: z.strictObject({}),
      output: serverSettingsViewSchema
    },
    /** Overrides the given settings. A value equal to its default drops the override. */
    'settings.set': {
      input: z.strictObject({ values: serverSettingsSchema.partial() }),
      output: serverSettingsViewSchema
    },
    /**
     * What one TUI shows: its pins and the sessions it has open. Auto-archive skips pins and
     * cleanup keeps worktrees of open sessions. Entries expire when a TUI stops reporting.
     */
    presence: {
      input: z.strictObject({
        clientID: z.string().min(1).max(100),
        pinned: z.array(z.string()).max(500),
        open: z.array(z.string()).max(200)
      }),
      output: z.strictObject({})
    },
    /**
     * Hands out sessions due for auto-archive. The server plugin cannot archive, so a TUI does it
     * over HTTP. Each session goes to one TUI at a time, and comes back after a lease if that TUI
     * never reports it.
     */
    'archive.claim': {
      input: z.strictObject({ clientID: z.string().min(1).max(100) }),
      output: z.strictObject({
        sessions: z.array(z.strictObject({ sessionID: z.string(), title: z.string() }))
      })
    },
    'archive.report': {
      input: z.strictObject({
        clientID: z.string().min(1).max(100),
        archived: z.array(z.string()).max(200),
        skipped: z.array(z.string()).max(200)
      }),
      output: z.strictObject({})
    },
    /** Never auto-archives these sessions again, for example after the user undid it. */
    'archive.exclude': {
      input: z.strictObject({ sessionIDs: z.array(z.string()).max(200) }),
      output: z.strictObject({})
    },
    /** Dry run: what cleanup would remove and keep now. Removes nothing. */
    'cleanup.plan': {
      input: z.strictObject({}),
      output: z.strictObject({
        /** Whether the user already confirmed a removal once, so sweeps remove on their own. */
        confirmed: z.boolean(),
        worktrees: z.array(worktreeDecisionSchema)
      })
    },
    /**
     * Removes the listed worktrees that still qualify when checked again, and marks cleanup as
     * confirmed. Directories that no longer qualify are kept and listed with their reason.
     */
    'cleanup.run': {
      input: z.strictObject({ directories }),
      output: z.strictObject({
        removed: z.array(z.string()),
        kept: z.array(z.strictObject({ directory: z.string(), reason: z.string() }))
      })
    }
  },
  events: {
    /** Sessions are due for auto-archive; TUIs call `archive.claim`. */
    'archive.due': { schema: z.strictObject({ count: z.number().int() }) },
    /** A sweep would remove worktrees but the user has not confirmed cleanup yet. */
    'cleanup.confirm': { schema: z.strictObject({ worktrees: z.array(worktreeDecisionSchema) }) },
    /** A sweep removed worktrees. */
    'cleanup.removed': { schema: z.strictObject({ directories: z.array(z.string()) }) }
  }
});
