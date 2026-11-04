import type { PullCheck, PullDetails, Ref } from '../../refs/ref.js';
import { type CheckEntry, foldChecks } from '../checks.js';
import { isRecord } from '../include.js';
import type { ForgeError } from '../provider.js';
import type { GraphQLResponse } from './output.js';

// 100 is the page maximum; a pull request with more checks says so with `checksTruncated`.
const DETAILS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  rateLimit { remaining resetAt }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      author { login } headRefName baseRefName body
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          __typename
          ... on CheckRun {
            name status conclusion detailsUrl startedAt completedAt
            checkSuite { workflowRun { workflow { name } } }
          }
          ... on StatusContext { context state targetUrl createdAt }
        }
      } } } } }
    }
  }
}`;

/** Builds the details lookup of one pull request. */
export function buildDetailsQuery(ref: Ref): {
  query: string;
  variables: Record<string, string | number>;
} {
  const slash = ref.repo.indexOf('/');
  return {
    query: DETAILS_QUERY,
    variables: {
      owner: ref.repo.slice(0, slash),
      name: ref.repo.slice(slash + 1),
      number: ref.number
    }
  };
}

/**
 * Maps a check run or status onto a {@link PullCheck} status, as t3code's `toCheckStatus` does:
 * a check run that has not completed is pending whatever its conclusion says.
 */
function checkStatus(node: Record<string, unknown>): PullCheck['status'] {
  if (typeof node.status === 'string' && node.status !== 'COMPLETED') return 'pending';
  const outcome = node.conclusion ?? node.state;
  switch (outcome) {
    case 'SUCCESS':
      return 'success';
    case 'ACTION_REQUIRED':
      return 'action_required';
    case 'FAILURE':
    case 'ERROR':
    case 'TIMED_OUT':
    case 'STARTUP_FAILURE':
      return 'failure';
    case 'CANCELLED':
      return 'cancelled';
    case 'SKIPPED':
      return 'skipped';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return 'neutral';
  }
}

/** Epoch milliseconds of an ISO time, or 0. */
function time(value: unknown): number {
  const at = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? 0 : at;
}

/** Reads one rollup context into a check entry, or nothing for a context without a name. */
function entryOf(node: unknown): CheckEntry[] {
  if (!isRecord(node)) return [];
  const name = node.__typename === 'CheckRun' ? node.name : node.context;
  if (typeof name !== 'string' || name.trim() === '') return [];
  const status = checkStatus(node);
  const url = node.detailsUrl ?? node.targetUrl;
  const suite = isRecord(node.checkSuite) ? node.checkSuite.workflowRun : undefined;
  const workflow = isRecord(suite) && isRecord(suite.workflow) ? suite.workflow.name : undefined;
  return [
    {
      check: { name, status, ...(typeof url === 'string' && url ? { url } : {}) },
      group: typeof workflow === 'string' ? workflow : undefined,
      at:
        status === 'pending'
          ? Number.POSITIVE_INFINITY
          : time(node.completedAt) || time(node.startedAt) || time(node.createdAt)
    }
  ];
}

/** Reads a details response; a missing pull request or repository is `not-found`. */
export function parseDetailsResponse(response: GraphQLResponse): PullDetails | ForgeError {
  const repository = response.data.repository;
  const pull = isRecord(repository) ? repository.pullRequest : undefined;
  if (!isRecord(pull)) {
    const error = response.errors[0];
    return !error || error.type === 'NOT_FOUND' ? { reason: 'not-found' } : { reason: 'failed' };
  }
  const commits = isRecord(pull.commits) ? pull.commits.nodes : undefined;
  const commit = Array.isArray(commits) && isRecord(commits[0]) ? commits[0].commit : undefined;
  const rollup = isRecord(commit) ? commit.statusCheckRollup : undefined;
  const contexts = isRecord(rollup) ? rollup.contexts : undefined;
  const nodes = isRecord(contexts) && Array.isArray(contexts.nodes) ? contexts.nodes : [];
  const more = isRecord(contexts) && isRecord(contexts.pageInfo) && contexts.pageInfo.hasNextPage;
  const author = isRecord(pull.author) ? pull.author.login : undefined;
  return {
    ...(typeof author === 'string' ? { author } : {}),
    ...(typeof pull.headRefName === 'string' ? { head: pull.headRefName } : {}),
    ...(typeof pull.baseRefName === 'string' ? { base: pull.baseRefName } : {}),
    body: typeof pull.body === 'string' ? pull.body : '',
    checks: foldChecks(nodes.flatMap(entryOf)),
    ...(more === true ? { checksTruncated: true } : {})
  };
}
