import type { Ref, RefReview, RefState, RefStatus } from '../../refs/ref.js';
import { commitSha } from '../include.js';
import type { ForgeError, RefCandidate, RepoRef } from '../provider.js';
import type { GraphQLError, GraphQLResponse } from './output.js';

/** Most candidates one document may carry. Keeps each request well under GitHub's node limits. */
export const MAX_BATCH = 25;

export type SnapshotEntry = { ref: Ref; state: RefState } | ForgeError;

/** A built snapshot document plus the alias path of every input candidate, in input order. */
export interface SnapshotDocument {
  query: string;
  variables: Record<string, string>;
  /** `[repositoryAlias, itemAlias]` per candidate, or undefined when the number is not queryable. */
  paths: Array<readonly [string, string] | undefined>;
}

// `rateLimit` is free to query and tells the provider when the quota runs out before a request fails.
// GitHub has no count of unresolved threads, so threads are read as nodes; 100 is the page
// maximum. At 25 refs the document measured 3,375 nodes (limit 500,000) and cost 1 point. The
// check counts come from `contexts(first: 0)`, which reads no context node.
const SNAPSHOT_FRAGMENTS = `
fragment PullRequestFields on PullRequest {
  state isDraft title url mergedAt closedAt updatedAt reviewDecision headRefOid
  closingIssuesReferences(first: 10) { nodes { number repository { nameWithOwner } } }
  latestReviews(first: 20) { nodes { state } }
  reviewThreads(first: 100) { totalCount nodes { isResolved } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 0) {
    checkRunCountsByState { state count } statusContextCountsByState { state count }
  } } } } }
}
fragment IssueFields on Issue {
  state stateReason title url closedAt
  closedByPullRequestsReferences(first: 5, includeClosedPrs: true) { nodes { number repository { nameWithOwner } } }
}`;

/** Splits `owner/name`. GitHub repositories never nest, so everything after the first slash is the name. */
function splitRepo(repo: string): { owner: string; name: string } {
  const slash = repo.indexOf('/');
  return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
}

/**
 * Builds one aliased document for candidates on a single host. Owners and names travel as
 * variables so user-typed text never becomes GraphQL syntax; numbers are inlined only after the
 * integer check. Repeated candidates share one alias.
 */
export function buildSnapshotQuery(candidates: RefCandidate[]): SnapshotDocument {
  const repos = new Map<string, { alias: string; items: Map<number, string> }>();
  const variables: Record<string, string> = {};
  const declarations: string[] = [];

  const paths = candidates.map((candidate) => {
    if (!Number.isSafeInteger(candidate.number) || candidate.number <= 0) return undefined;
    // GitHub owner and repository names are case-insensitive.
    const key = candidate.repo.toLowerCase();
    let repo = repos.get(key);
    if (!repo) {
      const index = repos.size;
      const { owner, name } = splitRepo(candidate.repo);
      variables[`o${index}`] = owner;
      variables[`n${index}`] = name;
      declarations.push(`$o${index}: String!`, `$n${index}: String!`);
      repo = { alias: `r${index}`, items: new Map() };
      repos.set(key, repo);
    }
    let item = repo.items.get(candidate.number);
    if (!item) {
      item = `i${repo.items.size}`;
      repo.items.set(candidate.number, item);
    }
    return [repo.alias, item] as const;
  });

  const selections = [...repos.values()].map((repo, index) => {
    const items = [...repo.items].map(
      ([number, alias]) =>
        `${alias}: issueOrPullRequest(number: ${number}) { __typename ...PullRequestFields ...IssueFields }`
    );
    return `${repo.alias}: repository(owner: $o${index}, name: $n${index}) { ${items.join(' ')} }`;
  });

  const query = `query(${declarations.join(', ')}) { rateLimit { remaining resetAt } ${selections.join(' ')} }${SNAPSHOT_FRAGMENTS}`;
  return { query, variables, paths };
}

/** Narrows an unknown value to a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Converts an ISO timestamp to epoch milliseconds; null or malformed values become undefined. */
function epoch(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

/** Maps GitHub's pull request and issue states onto the plugin's {@link RefStatus}. */
function statusOf(node: Record<string, unknown>): RefStatus | undefined {
  if (node.__typename === 'PullRequest') {
    if (node.state === 'MERGED') return 'merged';
    if (node.state === 'CLOSED') return 'closed';
    if (node.state === 'OPEN') return node.isDraft === true ? 'draft' : 'open';
    return undefined;
  }
  if (node.state === 'OPEN') return 'open';
  if (node.state !== 'CLOSED') return undefined;
  // GitHub draws duplicates with the same grey icon as not planned.
  return node.stateReason === 'NOT_PLANNED' || node.stateReason === 'DUPLICATE'
    ? 'not_planned'
    : 'completed';
}

/** Turns a connection's `nodes { number repository { nameWithOwner } }` into refs on `host`. */
function linkedRefs(connection: unknown, host: string, kind: Ref['kind']): Ref[] {
  if (!isRecord(connection) || !Array.isArray(connection.nodes)) return [];
  return connection.nodes.flatMap((node) => {
    if (!isRecord(node) || typeof node.number !== 'number' || !isRecord(node.repository)) return [];
    const repo = node.repository.nameWithOwner;
    if (typeof repo !== 'string') return [];
    return [{ provider: 'github' as const, host, repo, kind, number: node.number }];
  });
}

const DECISIONS: Record<string, NonNullable<RefReview['decision']>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  REVIEW_REQUIRED: 'review_required'
};

const CHECKS: Record<string, NonNullable<RefReview['checks']>> = {
  SUCCESS: 'passing',
  FAILURE: 'failing',
  ERROR: 'failing',
  PENDING: 'pending',
  EXPECTED: 'pending'
};

/**
 * Reads the review verdict. `reviewDecision` only counts reviews that branch protection asks for,
 * so it is null in repositories without required reviews and ignores app approvals; then the
 * reviewers' latest opinions decide, as in t3code, with a change request winning over approvals.
 */
function decisionOf(node: Record<string, unknown>): RefReview['decision'] {
  const summary =
    typeof node.reviewDecision === 'string' ? DECISIONS[node.reviewDecision] : undefined;
  if (summary === 'approved' || summary === 'changes_requested') return summary;
  const reviews = isRecord(node.latestReviews) ? node.latestReviews.nodes : undefined;
  const states = new Set(
    Array.isArray(reviews)
      ? reviews.map((review) => (isRecord(review) ? review.state : undefined))
      : []
  );
  if (states.has('CHANGES_REQUESTED')) return 'changes_requested';
  if (states.has('APPROVED')) return 'approved';
  return summary;
}

/** Reads `commits(last: 1)`'s rollup; null when the head commit has no checks or statuses. */
function headRollup(commits: unknown): Record<string, unknown> | undefined {
  const nodes = isRecord(commits) ? commits.nodes : undefined;
  const last = Array.isArray(nodes) ? nodes[0] : undefined;
  const commit = isRecord(last) ? last.commit : undefined;
  const rollup = isRecord(commit) ? commit.statusCheckRollup : undefined;
  return isRecord(rollup) ? rollup : undefined;
}

// What github.com's pull request list counts as passed in its `92/95 checks passing` (compared
// live on 2026-11-04): successful, neutral and skipped check runs, and successful statuses.
const PASSED_RUNS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const PASSED_STATUSES = new Set(['SUCCESS']);

/** Sums a `{ state count }` list: every entry, and the ones whose state is in `passed`. */
function countStates(value: unknown, passed: ReadonlySet<string>): [number, number] | undefined {
  if (!Array.isArray(value)) return undefined;
  let total = 0;
  let ok = 0;
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.state !== 'string') continue;
    const count = Number.isSafeInteger(entry.count) ? (entry.count as number) : 0;
    total += count;
    if (passed.has(entry.state)) ok += count;
  }
  return [ok, total];
}

/**
 * Passed and total checks of the rollup. GitHub's own list leaves out runs a re-run of the same
 * check replaced, which these counts include, so the numbers can be higher than github.com's.
 */
function checkCounts(
  rollup: Record<string, unknown> | undefined
): { checksPassed: number; checksTotal: number } | undefined {
  const contexts = rollup?.contexts;
  if (!isRecord(contexts)) return undefined;
  const runs = countStates(contexts.checkRunCountsByState, PASSED_RUNS);
  const statuses = countStates(contexts.statusContextCountsByState, PASSED_STATUSES);
  if (runs === undefined && statuses === undefined) return undefined;
  const total = (runs?.[1] ?? 0) + (statuses?.[1] ?? 0);
  if (total === 0) return undefined;
  return { checksPassed: (runs?.[0] ?? 0) + (statuses?.[0] ?? 0), checksTotal: total };
}

/**
 * Builds the review summary of an open or draft pull request. Merged and closed ones get none:
 * their snapshot is never refetched, so pending checks or open threads would show forever.
 * Past 100 threads only the first page is counted, so `unresolved` is then a lower bound.
 */
function reviewOf(node: Record<string, unknown>, status: RefStatus): RefReview | undefined {
  if (status !== 'open' && status !== 'draft') return undefined;
  const review: RefReview = {};
  const decision = decisionOf(node);
  if (decision) review.decision = decision;
  const threads = node.reviewThreads;
  if (isRecord(threads) && typeof threads.totalCount === 'number' && Array.isArray(threads.nodes)) {
    review.threads = threads.totalCount;
    review.unresolved = threads.nodes.filter(
      (thread) => isRecord(thread) && thread.isResolved === false
    ).length;
  }
  const rollup = headRollup(node.commits);
  const checks = typeof rollup?.state === 'string' ? CHECKS[rollup.state] : undefined;
  if (checks) review.checks = checks;
  Object.assign(review, checkCounts(rollup));
  return Object.keys(review).length > 0 ? review : undefined;
}

/** Maps a GraphQL error type to the reason reported for the entry it nulled out. */
function reasonOf(error: GraphQLError | undefined): ForgeError {
  if (!error || error.type === 'NOT_FOUND') return { reason: 'not-found' };
  if (error.type === 'FORBIDDEN') return { reason: 'forbidden' };
  return { reason: 'failed' };
}

/** Finds the error that explains a null at `path`, either on the item or on its repository. */
function errorAt(
  errors: GraphQLError[],
  path: readonly [string, string]
): GraphQLError | undefined {
  return errors.find(
    (error) => error.path?.[0] === path[0] && (error.path.length === 1 || error.path[1] === path[1])
  );
}

/**
 * Reads a snapshot response back into entries aligned with the candidates the document was
 * built from. The forge's `__typename` decides the kind, so a candidate guessed as a PR that is
 * an issue comes back as an issue.
 */
export function parseSnapshotResponse(
  document: SnapshotDocument,
  candidates: RefCandidate[],
  response: GraphQLResponse
): SnapshotEntry[] {
  return candidates.map((candidate, index): SnapshotEntry => {
    const path = document.paths[index];
    if (!path) return { reason: 'not-found' };
    const repository = response.data[path[0]];
    const node = isRecord(repository) ? repository[path[1]] : undefined;
    if (!isRecord(node)) return reasonOf(errorAt(response.errors, path));

    const status = statusOf(node);
    if (!status || typeof node.title !== 'string' || typeof node.url !== 'string') {
      return { reason: 'failed' };
    }
    const isPullRequest = node.__typename === 'PullRequest';
    const ref: Ref = {
      provider: 'github',
      host: candidate.host,
      repo: candidate.repo,
      kind: isPullRequest ? 'pr' : 'issue',
      number: candidate.number
    };
    const mergedAt = epoch(node.mergedAt);
    const closedAt = epoch(node.closedAt);
    const updatedAt = isPullRequest ? epoch(node.updatedAt) : undefined;
    const review = isPullRequest ? reviewOf(node, status) : undefined;
    const headSha = isPullRequest ? commitSha(node.headRefOid) : undefined;
    const state: RefState = {
      status,
      title: node.title,
      url: node.url,
      ...(mergedAt === undefined ? {} : { mergedAt }),
      ...(closedAt === undefined ? {} : { closedAt }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
      ...(isPullRequest
        ? { closes: linkedRefs(node.closingIssuesReferences, candidate.host, 'issue') }
        : { closedBy: linkedRefs(node.closedByPullRequestsReferences, candidate.host, 'pr') }),
      ...(review ? { review } : {}),
      ...(headSha === undefined ? {} : { headSha })
    };
    return { ref, state };
  });
}

/**
 * Reads the `rateLimit` block every document requests. Returns the reset time when the quota is
 * spent, so the provider can stop spawning gh until then.
 */
export function exhaustedUntil(response: GraphQLResponse): number | undefined {
  const limit = response.data.rateLimit;
  if (!isRecord(limit) || limit.remaining !== 0) return undefined;
  return epoch(limit.resetAt);
}

/** Builds the lookup of pull requests whose head branch is `branch` in `repo`. */
export function buildBranchQuery(
  repo: RepoRef,
  branch: string
): { query: string; variables: Record<string, string> } {
  const { owner, name } = splitRepo(repo.repo);
  // 20 rather than a handful: fork PRs share the head name (`main`, `patch-1`) and are filtered
  // out afterwards, so a short page could hide the repository's own PR.
  const query = `query($owner: String!, $name: String!, $branch: String!) {
  rateLimit { remaining resetAt }
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $branch, states: [OPEN, MERGED, CLOSED], first: 20, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { number state headRepository { nameWithOwner } }
    }
  }
}`;
  return { query, variables: { owner, name, branch } };
}

/**
 * Picks the pull request for a branch, following t3code: the newest open one, otherwise the
 * newest of any state. Only PRs whose head lives in `headRepo` count (the user's fork when the
 * branch was pushed there, else `repo` itself); GitHub also returns PRs from other forks that
 * happen to use the same branch name, and a deleted fork reports no head repository. Returns at
 * most one ref, always numbered in `repo`, where the pull request lives.
 */
export function parseBranchResponse(
  repo: RepoRef,
  response: GraphQLResponse,
  headRepo: RepoRef = repo
): Ref[] | ForgeError {
  const repository = response.data.repository;
  if (!isRecord(repository)) return reasonOf(response.errors[0]);
  // A fork on another host can never be the head of a PR here.
  if (headRepo.host.toLowerCase() !== repo.host.toLowerCase()) return [];
  const connection = repository.pullRequests;
  const nodes = isRecord(connection) && Array.isArray(connection.nodes) ? connection.nodes : [];
  const own = nodes.flatMap((node) => {
    if (!isRecord(node) || typeof node.number !== 'number' || !isRecord(node.headRepository)) {
      return [];
    }
    const head = node.headRepository.nameWithOwner;
    if (typeof head !== 'string' || head.toLowerCase() !== headRepo.repo.toLowerCase()) return [];
    return [{ number: node.number, open: node.state === 'OPEN' }];
  });
  // Nodes arrive newest first, so the first match in each pass is the newest.
  const chosen = own.find((node) => node.open) ?? own[0];
  if (!chosen) return [];
  return [
    { provider: 'github', host: repo.host, repo: repo.repo, kind: 'pr', number: chosen.number }
  ];
}
