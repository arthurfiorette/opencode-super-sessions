import { createLimiter, run } from '../../process.js';
import type { Availability, ForgeError } from '../provider.js';
import { type GraphQLResponse, parseAuthStatus, parseGraphQLOutput } from './output.js';

export interface GitHubClient {
  /**
   * Runs one GraphQL document against `host`. Returns the response whenever GitHub sent `data`,
   * even with per-alias errors, and a {@link ForgeError} when the whole document failed.
   */
  graphql(
    host: string,
    query: string,
    variables?: Record<string, unknown>
  ): Promise<GraphQLResponse | ForgeError>;
  /** Whether gh is installed and has a working login for `host`. */
  authStatus(host: string): Promise<Availability>;
}

const TIMEOUT_MS = 20_000;
// Caps concurrent gh processes so a page with many sessions cannot fork-bomb the machine or burst
// GitHub's secondary rate limit.
const MAX_CONCURRENT = 4;
const GH_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };

/**
 * Creates a client that shells out to `gh`. One client should exist per process, because the
 * concurrency cap lives in it.
 */
export function createGitHubClient(options: { ghPath: string }): GitHubClient {
  const limit = createLimiter(MAX_CONCURRENT);

  return {
    graphql: (host, query, variables = {}) =>
      limit(async () => {
        // The body goes through stdin as JSON: `-F` would expand `@file` and `{owner}` in values,
        // and long documents would hit the Windows command line limit.
        const result = await run(
          options.ghPath,
          ['api', 'graphql', `--hostname=${host}`, '--include', '--input', '-'],
          { timeoutMs: TIMEOUT_MS, input: JSON.stringify({ query, variables }), env: GH_ENV }
        );
        return parseGraphQLOutput(result, Date.now());
      }),

    authStatus: (host) =>
      limit(async () => {
        // `--active` ignores other accounts on the host; an invalid inactive one would fail the run.
        const result = await run(
          options.ghPath,
          ['auth', 'status', '--active', `--hostname=${host}`],
          { timeoutMs: TIMEOUT_MS, env: GH_ENV }
        );
        return parseAuthStatus(result);
      })
  };
}
