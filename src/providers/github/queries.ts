import type { Ref, RefState, RefStatus } from '../../refs/ref.js';
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
const SNAPSHOT_FRAGMENTS = `
fragment PullRequestFields on PullRequest {
  state isDraft title url mergedAt closedAt
  closingIssuesReferences(first: 10) { nodes { number repository { nameWithOwner } } }
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
 * really an issue comes back as an issue.
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
    const state: RefState = {
      status,
      title: node.title,
      url: node.url,
      ...(mergedAt === undefined ? {} : { mergedAt }),
      ...(closedAt === undefined ? {} : { closedAt }),
      ...(isPullRequest
        ? { closes: linkedRefs(node.closingIssuesReferences, candidate.host, 'issue') }
        : { closedBy: linkedRefs(node.closedByPullRequestsReferences, candidate.host, 'pr') })
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
