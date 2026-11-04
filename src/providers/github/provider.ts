import type {
  Availability,
  ForgeDefinition,
  ForgeError,
  ForgeProvider,
  RefCandidate
} from '../provider.js';
import { createGitHubClient } from './client.js';
import type { GraphQLResponse } from './output.js';
import {
  buildBranchQuery,
  buildSnapshotQuery,
  exhaustedUntil,
  MAX_BATCH,
  parseBranchResponse,
  parseSnapshotResponse,
  type SnapshotEntry
} from './queries.js';

const AVAILABLE_TTL_MS = 5 * 60_000;
// Short, so installing gh or fixing ghPath shows up without restarting the daemon.
const MISSING_TTL_MS = 10_000;

/**
 * Creates the runtime GitHub provider. Create one per daemon process: the gh concurrency cap, the
 * availability cache and the rate limit backoff are all held here.
 */
export function createGitHubProvider(options: {
  definition: ForgeDefinition;
  ghPath: string;
}): ForgeProvider {
  const client = createGitHubClient({ ghPath: options.ghPath });
  const availability = new Map<string, { value: Promise<Availability>; expiresAt: number }>();
  // Per host: no gh call is made before this time, because GitHub said the quota is spent.
  const blockedUntil = new Map<string, number>();

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
  ): Promise<GraphQLResponse | ForgeError> => {
    const backoff = blocked(host);
    if (backoff) return backoff;
    const response = await client.graphql(host, document, variables);
    const until =
      'data' in response
        ? exhaustedUntil(response)
        : response.reason === 'rate-limited'
          ? response.retryAt
          : undefined;
    if (until !== undefined) blockedUntil.set(host, until);
    return response;
  };

  return {
    definition: options.definition,

    /** Cached per host: 5 minutes, or 10 seconds while gh is missing. */
    available(host) {
      const key = host.toLowerCase();
      const cached = availability.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      const value = client.authStatus(host);
      // Stored before it settles so concurrent callers share one gh process.
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
     * PRs (old merged ones, or forks that reused the name) and cost a request for nothing.
     */
    async branchPullRequests(repo, branch, headRepo) {
      const document = buildBranchQuery(repo, branch);
      const response = await query(repo.host.toLowerCase(), document.query, document.variables);
      return 'data' in response ? parseBranchResponse(repo, response, headRepo) : response;
    },

    /**
     * Groups candidates by host and sends at most {@link MAX_BATCH} per document. A failed
     * document fails only its own candidates; results keep the input order.
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
        for (let start = 0; start < indexes.length; start += MAX_BATCH) {
          chunks.push({ host, indexes: indexes.slice(start, start + MAX_BATCH) });
        }
      }

      // Chunks start together; the client's limiter decides how many gh processes run at once.
      await Promise.all(
        chunks.map(async ({ host, indexes }) => {
          const batch: RefCandidate[] = indexes.map((index) => candidates[index] as RefCandidate);
          const document = buildSnapshotQuery(batch);
          const response = await query(host, document.query, document.variables);
          const entries =
            'data' in response
              ? parseSnapshotResponse(document, batch, response)
              : batch.map(() => response);
          for (const [position, index] of indexes.entries()) {
            results[index] = entries[position] ?? { reason: 'failed' };
          }
        })
      );
      return results;
    }
  };
}
