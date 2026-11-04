import { Rpc } from '@opencode/plugin/rpc';
import { z } from 'zod';
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
  states: z.record(z.string(), refStateSchema)
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
  /** Higher sorts first. Ties keep the server's most-recently-updated order. */
  score: z.number()
});

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
        unavailable: z.strictObject({ reason: z.string() })
      }
    },
    /** Removes a link and records the key as dismissed so detection never re-adds it. */
    unlink: {
      input: z.strictObject({ sessionID: z.string(), key: z.string() }),
      output: z.strictObject({})
    }
  },
  events: {}
});
