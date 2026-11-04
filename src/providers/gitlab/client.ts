import { createLimiter, run } from '../../process.js';
import type { Availability } from '../provider.js';
import {
  type GitLabFailure,
  type GraphQLResponse,
  parseAuthStatus,
  parseGraphQLOutput
} from './output.js';

export interface GitLabClient {
  /**
   * Runs one GraphQL document against `host`. Returns the response whenever GitLab sent `data`,
   * even with per-alias errors, and a {@link GitLabFailure} when the whole document failed.
   */
  graphql(
    host: string,
    query: string,
    variables?: Record<string, unknown>
  ): Promise<GraphQLResponse | GitLabFailure>;
  /** Whether glab is installed and has a working login for `host`. */
  authStatus(host: string): Promise<Availability>;
}

const TIMEOUT_MS = 20_000;
// Caps concurrent glab processes so a page with many sessions cannot fork-bomb the machine or
// trip GitLab's per-user request throttle.
const MAX_CONCURRENT = 4;
// No prompts, no update check and no usage ping: each would block or add a request to every
// background refresh. Only `GLAB_` names, because glab warns about the unprefixed ones.
const GLAB_ENV = {
  GLAB_NO_PROMPT: 'true',
  GLAB_CHECK_UPDATE: 'false',
  GLAB_SEND_TELEMETRY: 'false'
};

/**
 * Creates a client that shells out to `glab`. One client should exist per process, because the
 * concurrency cap lives in it.
 */
export function createGitLabClient(options: { glabPath: string }): GitLabClient {
  const limit = createLimiter(MAX_CONCURRENT);

  return {
    graphql: (host, query, variables = {}) =>
      limit(async () => {
        // The body goes through stdin as JSON so variables never pass through `-F` parsing,
        // which expands `@file` and `:placeholder` values. glab releases before the `--input`
        // Content-Type default need the header, and an explicit one is never overridden.
        const result = await run(
          options.glabPath,
          [
            'api',
            'graphql',
            '--hostname',
            host,
            '--include',
            '--method',
            'POST',
            '--input',
            '-',
            '--header',
            'Content-Type: application/json'
          ],
          { timeoutMs: TIMEOUT_MS, input: JSON.stringify({ query, variables }), env: GLAB_ENV }
        );
        return parseGraphQLOutput(result, Date.now());
      }),

    authStatus: (host) =>
      limit(async () => {
        const result = await run(options.glabPath, ['auth', 'status', '--hostname', host], {
          timeoutMs: TIMEOUT_MS,
          env: GLAB_ENV
        });
        return parseAuthStatus(result);
      })
  };
}
