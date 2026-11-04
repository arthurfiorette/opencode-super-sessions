import type { RunResult } from '../../process.js';
import { isRecord, parseJson, splitInclude } from '../include.js';
import type { Availability, ForgeError } from '../provider.js';

/** One entry of a GraphQL `errors` array. */
export interface GraphQLError {
  message: string;
  path?: Array<string | number>;
  /** `code` is `undefinedField` when the server's schema lacks `fieldName`. */
  extensions?: { code?: string; fieldName?: string };
}

/** A GraphQL response that carried `data`, possibly with per-field errors next to it. */
export interface GraphQLResponse {
  data: Record<string, unknown>;
  errors: GraphQLError[];
  /** Epoch milliseconds the request quota resets at, set only when it is spent. */
  exhaustedUntil?: number;
}

/**
 * A whole-document failure. `missingFields` names fields an older GitLab does not have, so the
 * caller can ask again without them.
 */
export interface GitLabFailure extends ForgeError {
  missingFields?: string[];
}

// Used when GitLab reports a rate limit without telling when it resets.
const DEFAULT_BACKOFF_MS = 60_000;

/** Keeps only well-formed GraphQL errors so later lookups by `path` can trust the shape. */
function readErrors(value: unknown): GraphQLError[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (error): error is GraphQLError => isRecord(error) && typeof error.message === 'string'
  );
}

/** `RateLimit-Reset` as epoch milliseconds, when it is a future Unix time. */
function resetTime(headers: Record<string, string>, now: number): number | undefined {
  const reset = Number(headers['ratelimit-reset']);
  return headers['ratelimit-reset'] && Number.isFinite(reset) && reset * 1000 > now
    ? reset * 1000
    : undefined;
}

/** Picks the earliest safe retry time: `Retry-After` on a 429, else the quota reset. */
function retryAt(headers: Record<string, string>, now: number): number {
  const after = Number(headers['retry-after']);
  if (headers['retry-after'] && Number.isFinite(after)) return now + after * 1000;
  return resetTime(headers, now) ?? now + DEFAULT_BACKOFF_MS;
}

/**
 * Interprets one `glab api graphql --include` run. Returns the response whenever GitLab sent
 * `data`, because glab exits non-zero on any GraphQL error while every other alias still
 * resolved. Otherwise the whole document failed and the result says why.
 */
export function parseGraphQLOutput(
  result: RunResult,
  now: number
): GraphQLResponse | GitLabFailure {
  if (result.failure === 'missing') return { reason: 'missing-tool' };
  if (result.failure) return { reason: 'failed' };

  const { status, headers, body } = splitInclude(result.stdout);
  const json = parseJson(body);
  const errors = readErrors(isRecord(json) ? json.errors : undefined);
  // Non-JSON bodies (`Retry later` on a 429) and glab's own messages both explain failures.
  const message = `${json === undefined ? body : ''}\n${errors.map((error) => error.message).join('\n')}\n${result.stderr}`;

  // Rack::Attack throttles answer 429 with a plain-text body; glab then prints `HTTP 429`.
  if (status === 429 || /\bHTTP 429\b|retry later/i.test(message)) {
    return { reason: 'rate-limited', retryAt: retryAt(headers, now) };
  }

  if (isRecord(json) && isRecord(json.data)) {
    const exhausted = headers['ratelimit-remaining'] === '0' ? resetTime(headers, now) : undefined;
    return {
      data: json.data,
      errors,
      ...(exhausted === undefined ? {} : { exhaustedUntil: exhausted })
    };
  }

  // glab names `glab auth login` when a stored token is missing or cannot be refreshed, and
  // GitLab answers a rejected token with HTTP 401 and `Invalid token`.
  if (
    status === 401 ||
    /glab auth login|invalid[_ ]token|invalid_grant|\bHTTP 401\b/i.test(message)
  ) {
    return { reason: 'unauthenticated' };
  }
  if (status === 403 || /\bHTTP 403\b/i.test(message)) return { reason: 'forbidden' };

  const missingFields = errors.flatMap((error) =>
    error.extensions?.code === 'undefinedField' && typeof error.extensions.fieldName === 'string'
      ? [error.extensions.fieldName]
      : []
  );
  return missingFields.length > 0 ? { reason: 'failed', missingFields } : { reason: 'failed' };
}

/**
 * Interprets `glab auth status --hostname <host>`. glab exits 1 for every failed check, so the
 * text decides: a rejected or missing token is `unauthenticated`, while timeouts and network or
 * server errors count as `ok` because the next request reports the real failure per ref.
 */
export function parseAuthStatus(result: RunResult): Availability {
  if (result.failure === 'missing') return 'missing-tool';
  if (result.code === 0) return 'ok';
  if (result.failure === 'timeout') return 'ok';
  const text = `${result.stdout}\n${result.stderr}`;
  const unreachable = /API call failed/i.test(text);
  const rejected = /\b401\b|unauthori[sz]ed|invalid[_ ]token|invalid_grant/i.test(text);
  return unreachable && !rejected ? 'ok' : 'unauthenticated';
}
