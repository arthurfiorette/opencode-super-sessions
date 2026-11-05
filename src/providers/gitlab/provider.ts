import type {
  Availability,
  ForgeDefinition,
  ForgeError,
  ForgeProvider,
  RefCandidate
} from '../provider.js';
import { createGitLabClient } from './client.js';
import { buildDetailsQuery, parseDetailsResponse } from './details.js';
import type { GitLabFailure, GraphQLResponse } from './output.js';
import {
  buildBranchQuery,
  buildSnapshotQuery,
  CLOSES_FIELD,
  parseBranchResponse,
  parseSnapshotResponse,
  REVIEW_FIELDS,
  type SnapshotEntry,
  snapshotBatches
} from './queries.js';

const AVAILABLE_TTL_MS = 5 * 60_000;
// Short, so installing glab or fixing glabPath shows up without restarting the daemon.
const MISSING_TTL_MS = 10_000;

/** Drops fields a {@link GitLabFailure} carries for the provider, so caches store a plain error. */
function plainError(error: GitLabFailure): ForgeError {
  return error.retryAt === undefined
    ? { reason: error.reason }
    : { reason: error.reason, retryAt: error.retryAt };
}

/**
 * Creates the runtime GitLab provider. Create one per daemon process: the glab concurrency cap,
 * the availability cache and the rate limit backoff are all held here.
 */
export function createGitLabProvider(options: {
  definition: ForgeDefinition;
  glabPath: string;
}): ForgeProvider {
  const client = createGitLabClient({ glabPath: options.glabPath });
  const availability = new Map<string, { value: Promise<Availability>; expiresAt: number }>();
  // Per host: no glab call is made before this time, because GitLab said the quota is spent.
  const blockedUntil = new Map<string, number>();
  // Hosts whose GitLab predates the field that lists the issues a merge request closes.
  const withoutCloses = new Set<string>();
  // Hosts whose GitLab predates a field the review summary reads.
  const withoutReview = new Set<string>();

  /** Returns the rate limit error to report while `host` is backing off, if it is. */
  const blocked = (host: string): ForgeError | undefined => {
    const until = blockedUntil.get(host);
    if (until === undefined || until <= Date.now()) return undefined;
    return { reason: 'rate-limited', retryAt: until };
  };

  /** Runs a document unless the host is backing off, and records any new backoff it reports. */
  const query = async (
    host: string,
    document: string,
    variables: Record<string, unknown>
  ): Promise<GraphQLResponse | GitLabFailure> => {
    const backoff = blocked(host);
    if (backoff) return backoff;
    const response = await client.graphql(host, document, variables);
    const until =
      'data' in response
        ? response.exhaustedUntil
        : response.reason === 'rate-limited'
          ? response.retryAt
          : undefined;
    if (until !== undefined) blockedUntil.set(host, until);
    return response;
  };

  /**
   * Fetches one batch on one host. A server without {@link CLOSES_FIELD} or one of the
   * {@link REVIEW_FIELDS} rejects the whole document and names every unknown field at once, so
   * the batch is asked again once without them and the host is remembered.
   */
  const snapshotBatch = async (host: string, batch: RefCandidate[]): Promise<SnapshotEntry[]> => {
    /** Builds the document with only the optional fields `host` is known to have. */
    const build = () =>
      buildSnapshotQuery(batch, {
        closes: !withoutCloses.has(host),
        review: !withoutReview.has(host)
      });
    let document = build();
    let response = await query(host, document.query, document.variables);
    const missing = 'data' in response ? undefined : response.missingFields;
    if (missing) {
      if (missing.includes(CLOSES_FIELD)) withoutCloses.add(host);
      if (missing.some((field) => REVIEW_FIELDS.includes(field))) withoutReview.add(host);
      const retry = build();
      if (retry.closes !== document.closes || retry.review !== document.review) {
        document = retry;
        response = await query(host, document.query, document.variables);
      }
    }
    if ('data' in response) return parseSnapshotResponse(document, batch, response);
    const error = plainError(response);
    return batch.map(() => error);
  };

  return {
    definition: options.definition,

    /** Cached per host: 5 minutes, or 10 seconds while glab is missing. */
    available(host) {
      const key = host.toLowerCase();
      const cached = availability.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      const value = client.authStatus(key);
      // Stored before it settles so concurrent callers share one glab process.
      const entry = { value, expiresAt: Number.POSITIVE_INFINITY };
      availability.set(key, entry);
      value.then(
        (result) => {
          const ttl = result === 'missing-tool' ? MISSING_TTL_MS : AVAILABLE_TTL_MS;
          entry.expiresAt = Date.now() + ttl;
        },
        () => availability.delete(key)
      );
      return value;
    },

    /**
     * Callers skip the default branch and branches without an upstream: both match unrelated
     * merge requests (old merged ones, or forks that reused the name) and cost a request.
     */
    async branchPullRequests(repo, branch, headRepo) {
      const document = buildBranchQuery(repo, branch);
      const response = await query(repo.host.toLowerCase(), document.query, document.variables);
      return 'data' in response
        ? parseBranchResponse(repo, response, headRepo)
        : plainError(response);
    },

    /**
     * Groups candidates by host and splits each host into batches under GitLab's complexity
     * limit. A failed document fails only its own candidates; results keep the input order.
     */
    async snapshot(candidates) {
      const results: SnapshotEntry[] = new Array(candidates.length);
      const byHost = new Map<string, number[]>();
      for (const [index, candidate] of candidates.entries()) {
        const host = candidate.host.toLowerCase();
        byHost.set(host, [...(byHost.get(host) ?? []), index]);
      }

      const chunks: Array<{ host: string; indexes: number[] }> = [];
      for (const [host, indexes] of byHost) {
        const own = indexes.map((index) => candidates[index] as RefCandidate);
        for (const batch of snapshotBatches(own)) {
          chunks.push({ host, indexes: batch.map((position) => indexes[position] as number) });
        }
      }

      // Chunks start together; the client's limiter decides how many glab processes run at once.
      await Promise.all(
        chunks.map(async ({ host, indexes }) => {
          const batch = indexes.map((index) => candidates[index] as RefCandidate);
          const entries = await snapshotBatch(host, batch);
          for (const [position, index] of indexes.entries()) {
            results[index] = entries[position] ?? { reason: 'failed' };
          }
        })
      );
      return results;
    },

    async details(ref) {
      const host = ref.host.toLowerCase();
      const document = buildDetailsQuery(ref);
      const response = await query(host, document.query, document.variables);
      return 'data' in response ? parseDetailsResponse(response, host) : plainError(response);
    }
  };
}
