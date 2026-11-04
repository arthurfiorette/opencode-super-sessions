import type { RunResult } from '../../process.js';
import type { Availability, ForgeError } from '../provider.js';

/** One entry of a GraphQL `errors` array. `type` is GitHub's code, such as `NOT_FOUND`. */
export interface GraphQLError {
  type?: string;
  path?: Array<string | number>;
  message: string;
}

/** A GraphQL response that carried `data`, possibly with per-field errors next to it. */
export interface GraphQLResponse {
  data: Record<string, unknown>;
  errors: GraphQLError[];
}

// Used when GitHub reports a rate limit without telling when it resets.
const DEFAULT_BACKOFF_MS = 60_000;
// gh exits with 4 when a command needs authentication and no token is configured.
const AUTH_REQUIRED_EXIT = 4;

/**
 * Splits `gh api --include` output into the HTTP status, lower-cased headers and body. Output
 * without a status line (gh failed before sending a request) is returned as a bare body.
 */
function splitInclude(stdout: string): {
  status?: number;
  headers: Record<string, string>;
  body: string;
} {
  // gh ends the status line with LF but header lines with CRLF.
  const match = /^HTTP\/[\d.]+ (\d{3})[^\n]*\n([\s\S]*?)\r?\n\r?\n/.exec(stdout);
  if (!match) return { headers: {}, body: stdout };
  const headers: Record<string, string> = {};
  for (const line of (match[2] ?? '').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0)
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status: Number(match[1]), headers, body: stdout.slice(match[0].length) };
}

/** Parses JSON without throwing; gh prints plain text for failures that never reached GitHub. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Narrows an unknown value to a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keeps only well-formed GraphQL errors so later lookups by `path` can trust the shape. */
function readErrors(value: unknown): GraphQLError[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (error): error is GraphQLError => isRecord(error) && typeof error.message === 'string'
  );
}

/**
 * Picks the earliest safe retry time. `retry-after` (secondary limits) wins over
 * `x-ratelimit-reset` (primary limits), which only counts once the quota is spent.
 */
function retryAt(headers: Record<string, string>, now: number): number {
  const after = Number(headers['retry-after']);
  if (headers['retry-after'] && Number.isFinite(after)) return now + after * 1000;
  const reset = Number(headers['x-ratelimit-reset']);
  if (headers['x-ratelimit-remaining'] === '0' && Number.isFinite(reset) && reset * 1000 > now) {
    return reset * 1000;
  }
  return now + DEFAULT_BACKOFF_MS;
}

/**
 * Interprets one `gh api graphql --include` run. Returns the response whenever GitHub sent `data`,
 * because a missing issue number makes gh exit non-zero while every other alias still resolved.
 * Otherwise the whole document failed and the result says why.
 */
export function parseGraphQLOutput(result: RunResult, now: number): GraphQLResponse | ForgeError {
  if (result.failure === 'missing') return { reason: 'missing-tool' };
  if (result.failure) return { reason: 'failed' };

  const { status, headers, body } = splitInclude(result.stdout);
  const json = parseJson(body);
  const errors = readErrors(isRecord(json) ? json.errors : undefined);
  const message = `${isRecord(json) && typeof json.message === 'string' ? json.message : ''}\n${result.stderr}`;

  // GraphQL quota errors arrive as HTTP 200 with a RATE_LIMITED error, REST-style ones as 403/429.
  const rateLimited =
    status === 429 ||
    errors.some((error) => error.type === 'RATE_LIMITED') ||
    (status === 403 && (headers['x-ratelimit-remaining'] === '0' || 'retry-after' in headers)) ||
    /rate limit/i.test(message);
  if (rateLimited) return { reason: 'rate-limited', retryAt: retryAt(headers, now) };

  if (isRecord(json) && isRecord(json.data)) return { data: json.data, errors };

  if (
    status === 401 ||
    result.code === AUTH_REQUIRED_EXIT ||
    /gh auth login|bad credentials/i.test(message)
  ) {
    return { reason: 'unauthenticated' };
  }
  if (status === 403 || errors.some((error) => error.type === 'FORBIDDEN')) {
    return { reason: 'forbidden' };
  }
  return { reason: 'failed' };
}

/**
 * Interprets `gh auth status --active --hostname <host>`. Timeouts and network errors count as
 * `ok`: gh has a token, and the next request reports the real failure per ref instead of hiding
 * every ref behind a misleading "not logged in".
 */
export function parseAuthStatus(result: RunResult): Availability {
  if (result.failure === 'missing') return 'missing-tool';
  if (result.code === 0) return 'ok';
  if (result.failure === 'timeout') return 'ok';
  if (/timeout|error connecting/i.test(`${result.stdout}\n${result.stderr}`)) return 'ok';
  return 'unauthenticated';
}
