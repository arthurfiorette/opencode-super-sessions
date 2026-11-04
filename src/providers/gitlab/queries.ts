import type { Ref, RefReview, RefState, RefStatus } from '../../refs/ref.js';
import { commitSha, isRecord } from '../include.js';
import type { ForgeError, RefCandidate, RepoRef } from '../provider.js';
import type { GraphQLError, GraphQLResponse } from './output.js';

// GitLab rejects a whole document above 200 complexity points when anonymous (250 signed in).
// Costs were measured on gitlab.com with `queryComplexity { score }`; the budget leaves room
// for the query itself and `metadata`. The review fields and `diffHeadSha` raised a merge
// request from 21 to 34, so an all-merge-request batch holds 5 instead of 8.
const COMPLEXITY_BUDGET = 180;
const PROJECT_COST = 2;
const MERGE_REQUEST_COST = 34;
const ISSUE_COST = 6;

/** GraphQL field that lists the issues a merge request closes. Older GitLab servers lack it. */
export const CLOSES_FIELD = 'workItemRelations';

/**
 * Fields the review summary reads. A server that lacks any of them (`enterprise` came in GitLab
 * 15.6, `detailedMergeStatus` in 15.x) is asked again without the summary.
 */
export const REVIEW_FIELDS: readonly string[] = [
  'enterprise',
  'approved',
  'approvedBy',
  'detailedMergeStatus',
  'resolvableDiscussionsCount',
  'resolvedDiscussionsCount',
  'headPipeline'
];

export type SnapshotEntry = { ref: Ref; state: RefState } | ForgeError;

/** Aliases one candidate reads: its project, and the merge request and issue its kind allows. */
interface CandidatePath {
  project: string;
  mr?: string;
  issue?: string;
}

/** A built snapshot document plus the alias path of every input candidate, in input order. */
export interface SnapshotDocument {
  query: string;
  variables: Record<string, string>;
  /** Undefined when the number is not queryable. */
  paths: Array<CandidatePath | undefined>;
  /** Whether merge requests ask for the issues they close. */
  closes: boolean;
  /** Whether merge requests ask for their review and pipeline summary. */
  review: boolean;
}

// `diffHeadSha` is the source branch head, the same commit REST calls `sha`; it stays the branch
// head after a squash merge.
const MERGE_REQUEST_FIELDS = 'state draft title webUrl mergedAt closedAt diffHeadSha';
const CLOSES_SELECTION = `${CLOSES_FIELD}(types: [CLOSES], first: 10) { nodes { workItem { iid namespace { fullPath } } } }`;
// One approver is enough to tell "someone approved" from "nobody did". The discussion counts are
// precomputed by GitLab, so no discussion is read.
const REVIEW_SELECTION =
  'approved approvedBy(first: 1) { nodes { id } } detailedMergeStatus resolvableDiscussionsCount resolvedDiscussionsCount headPipeline { status }';
const ISSUE_FIELDS = 'state title webUrl closedAt';

/**
 * Splits candidates on one host into groups whose documents stay under GitLab's complexity
 * limit. Returns indexes into `candidates`, in order. A kind-less candidate costs a merge
 * request and an issue, since its document asks for both.
 */
export function snapshotBatches(candidates: RefCandidate[]): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let cost = 0;
  let projects = new Set<string>();
  for (const [index, candidate] of candidates.entries()) {
    const project = candidate.repo.toLowerCase();
    const itemCost =
      (candidate.kind === 'issue' ? 0 : MERGE_REQUEST_COST) +
      (candidate.kind === 'pr' ? 0 : ISSUE_COST);
    const added = itemCost + (projects.has(project) ? 0 : PROJECT_COST);
    if (current.length > 0 && cost + added > COMPLEXITY_BUDGET) {
      batches.push(current);
      current = [];
      cost = 0;
      projects = new Set();
    }
    cost += itemCost + (projects.has(project) ? 0 : PROJECT_COST);
    projects.add(project);
    current.push(index);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Builds one aliased document for candidates on a single host. Project paths travel as
 * variables so user-typed text never becomes GraphQL syntax; numbers are inlined only after the
 * integer check. A candidate without a kind asks for both the merge request and the issue with
 * its number, because GitLab numbers them separately. Repeated candidates share aliases.
 * `closes: false` leaves out {@link CLOSES_FIELD} and `review: false` the {@link REVIEW_FIELDS},
 * for servers that do not have them.
 */
export function buildSnapshotQuery(
  candidates: RefCandidate[],
  options: { closes?: boolean; review?: boolean } = {}
): SnapshotDocument {
  const closes = options.closes !== false;
  const review = options.review !== false;
  const projects = new Map<
    string,
    { alias: string; mrs: Map<number, string>; issues: Map<number, string> }
  >();
  const variables: Record<string, string> = {};
  const declarations: string[] = [];

  /** Returns the alias for `number` in `items`, adding it under `prefix` when new. */
  const aliasOf = (items: Map<number, string>, prefix: string, number: number) => {
    let alias = items.get(number);
    if (alias === undefined) {
      alias = `${prefix}${items.size}`;
      items.set(number, alias);
    }
    return alias;
  };

  const paths = candidates.map((candidate): CandidatePath | undefined => {
    if (!Number.isSafeInteger(candidate.number) || candidate.number <= 0) return undefined;
    // GitLab resolves full paths case-insensitively.
    const key = candidate.repo.toLowerCase();
    let project = projects.get(key);
    if (!project) {
      const alias = `p${projects.size}`;
      variables[alias] = candidate.repo;
      declarations.push(`$${alias}: ID!`);
      project = { alias, mrs: new Map(), issues: new Map() };
      projects.set(key, project);
    }
    const path: CandidatePath = { project: project.alias };
    if (candidate.kind !== 'issue') path.mr = aliasOf(project.mrs, 'm', candidate.number);
    if (candidate.kind !== 'pr') path.issue = aliasOf(project.issues, 'i', candidate.number);
    return path;
  });

  const mergeRequestFields = [
    MERGE_REQUEST_FIELDS,
    ...(closes ? [CLOSES_SELECTION] : []),
    ...(review ? [REVIEW_SELECTION] : [])
  ].join(' ');
  const selections = [...projects.values()].map((project) => {
    const items = [
      ...[...project.mrs].map(
        ([number, alias]) => `${alias}: mergeRequest(iid: "${number}") { ${mergeRequestFields} }`
      ),
      ...[...project.issues].map(
        ([number, alias]) => `${alias}: issue(iid: "${number}") { ${ISSUE_FIELDS} }`
      )
    ];
    return `${project.alias}: project(fullPath: $${project.alias}) { ${items.join(' ')} }`;
  });

  // `enterprise` is null when anonymous, and approvals then decide on their own.
  const anyMergeRequest = [...projects.values()].some((project) => project.mrs.size > 0);
  const metadata = review && anyMergeRequest ? 'metadata { enterprise } ' : '';
  const query = `query(${declarations.join(', ')}) { ${metadata}${selections.join(' ')} }`;
  return { query, variables, paths, closes, review };
}

/** Converts an ISO timestamp to epoch milliseconds; null or malformed values become undefined. */
function epoch(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

/**
 * Maps GitLab states onto the plugin's {@link RefStatus}. `locked` is the short window while a
 * merge request is being merged, so it stays open and is fetched again soon. GitLab records no
 * close reason, so every closed issue is `completed`.
 */
function statusOf(node: Record<string, unknown>, kind: Ref['kind']): RefStatus | undefined {
  if (kind === 'pr') {
    if (node.state === 'merged') return 'merged';
    if (node.state === 'closed') return 'closed';
    if (node.state === 'opened' || node.state === 'locked') {
      return node.draft === true ? 'draft' : 'open';
    }
    return undefined;
  }
  if (node.state === 'opened' || node.state === 'locked') return 'open';
  return node.state === 'closed' ? 'completed' : undefined;
}

// `manual` waits on a person and `skipped` ran nothing, so neither says anything about the code.
const CHECKS: Record<string, NonNullable<RefReview['checks']>> = {
  SUCCESS: 'passing',
  FAILED: 'failing',
  CANCELED: 'failing',
  CANCELING: 'failing',
  CREATED: 'pending',
  WAITING_FOR_RESOURCE: 'pending',
  PREPARING: 'pending',
  WAITING_FOR_CALLBACK: 'pending',
  PENDING: 'pending',
  RUNNING: 'pending',
  SCHEDULED: 'pending'
};

/**
 * Reads the review verdict, following t3code. `detailedMergeStatus` names only the first check
 * blocking the merge, so a change request hidden behind a draft or a conflict is missed. Only
 * Enterprise Edition holds `approved` to approval rules: Community Edition sets it once anyone
 * approves. So an unapproved merge request needs review on Enterprise, or when someone approved
 * without satisfying the rules; with `enterprise` unknown (anonymous reads) and no approver,
 * nothing is said.
 */
function decisionOf(node: Record<string, unknown>, enterprise: unknown): RefReview['decision'] {
  if (node.detailedMergeStatus === 'REQUESTED_CHANGES') return 'changes_requested';
  const approvers = isRecord(node.approvedBy) ? node.approvedBy.nodes : undefined;
  const approvals = Array.isArray(approvers) ? approvers.length : 0;
  if (node.approved === false && (enterprise === true || approvals > 0)) return 'review_required';
  return node.approved === true && approvals > 0 ? 'approved' : undefined;
}

/**
 * Builds the review summary of an open or draft merge request. Merged and closed ones get none:
 * their snapshot is never refetched, so a running pipeline would show forever.
 */
function reviewOf(
  node: Record<string, unknown>,
  status: RefStatus,
  enterprise: unknown
): RefReview | undefined {
  if (status !== 'open' && status !== 'draft') return undefined;
  const review: RefReview = {};
  const decision = decisionOf(node, enterprise);
  if (decision) review.decision = decision;
  const threads = node.resolvableDiscussionsCount;
  const resolved = node.resolvedDiscussionsCount;
  if (Number.isSafeInteger(threads) && Number.isSafeInteger(resolved)) {
    review.threads = threads as number;
    review.unresolved = Math.max(0, (threads as number) - (resolved as number));
  }
  const pipeline = isRecord(node.headPipeline) ? node.headPipeline.status : undefined;
  const checks = typeof pipeline === 'string' ? CHECKS[pipeline] : undefined;
  if (checks) review.checks = checks;
  return Object.keys(review).length > 0 ? review : undefined;
}

/** Turns `workItemRelations` nodes into issue refs on `host`. */
function closingIssues(connection: unknown, host: string): Ref[] {
  if (!isRecord(connection) || !Array.isArray(connection.nodes)) return [];
  return connection.nodes.flatMap((node) => {
    const item = isRecord(node) ? node.workItem : undefined;
    if (!isRecord(item) || !isRecord(item.namespace)) return [];
    const number = Number(item.iid);
    const repo = item.namespace.fullPath;
    // Group-level work items (epics) have no project path and cannot be tracked as issues.
    if (!Number.isSafeInteger(number) || number <= 0 || typeof repo !== 'string') return [];
    if (!repo.includes('/')) return [];
    return [
      {
        provider: 'gitlab' as const,
        host,
        repo: repo.toLowerCase(),
        kind: 'issue' as const,
        number
      }
    ];
  });
}

/**
 * Maps the error that nulled an entry to its reason. GitLab returns a missing or hidden project,
 * merge request or issue as a plain null, with no error at all.
 */
function reasonOf(error: GraphQLError | undefined): ForgeError {
  if (!error || /does not exist or you don't have permission/i.test(error.message)) {
    return { reason: 'not-found' };
  }
  return { reason: 'failed' };
}

/** Finds the error that explains a null at `alias`, either on the item or on its project. */
function errorAt(
  errors: GraphQLError[],
  project: string,
  alias: string | undefined
): GraphQLError | undefined {
  return errors.find(
    (error) => error.path?.[0] === project && (error.path.length === 1 || error.path[1] === alias)
  );
}

/**
 * Reads a snapshot response back into entries aligned with the candidates the document was
 * built from. A candidate without a kind takes the merge request when both exist: GitLab writes
 * issues as `#N`, so a kind-less number comes from a tool call or a bare number typed by hand.
 */
export function parseSnapshotResponse(
  document: SnapshotDocument,
  candidates: RefCandidate[],
  response: GraphQLResponse
): SnapshotEntry[] {
  const enterprise = isRecord(response.data.metadata)
    ? response.data.metadata.enterprise
    : undefined;
  return candidates.map((candidate, index): SnapshotEntry => {
    const path = document.paths[index];
    if (!path) return { reason: 'not-found' };
    const project = response.data[path.project];
    if (!isRecord(project)) return reasonOf(errorAt(response.errors, path.project, undefined));

    const mr = path.mr === undefined ? undefined : project[path.mr];
    const issue = path.issue === undefined ? undefined : project[path.issue];
    const kind: Ref['kind'] | undefined = isRecord(mr)
      ? 'pr'
      : isRecord(issue)
        ? 'issue'
        : undefined;
    const node = kind === 'pr' ? mr : issue;
    if (kind === undefined || !isRecord(node)) {
      return reasonOf(
        errorAt(response.errors, path.project, path.mr) ??
          errorAt(response.errors, path.project, path.issue)
      );
    }

    const status = statusOf(node, kind);
    if (!status || typeof node.title !== 'string' || typeof node.webUrl !== 'string') {
      return { reason: 'failed' };
    }
    const ref: Ref = {
      provider: 'gitlab',
      host: candidate.host,
      repo: candidate.repo,
      kind,
      number: candidate.number
    };
    const mergedAt = epoch(node.mergedAt);
    const closedAt = epoch(node.closedAt);
    const review =
      kind === 'pr' && document.review ? reviewOf(node, status, enterprise) : undefined;
    const headSha = kind === 'pr' ? commitSha(node.diffHeadSha) : undefined;
    const state: RefState = {
      status,
      title: node.title,
      url: node.webUrl,
      ...(mergedAt === undefined ? {} : { mergedAt }),
      ...(closedAt === undefined ? {} : { closedAt }),
      ...(kind === 'pr' && document.closes
        ? { closes: closingIssues(node[CLOSES_FIELD], candidate.host) }
        : {}),
      ...(review ? { review } : {}),
      ...(headSha === undefined ? {} : { headSha })
    };
    return { ref, state };
  });
}

/** Builds the lookup of merge requests whose source branch is `branch`, for `repo`. */
export function buildBranchQuery(
  repo: RepoRef,
  branch: string
): { query: string; variables: Record<string, string> } {
  // No `state` argument: GitLab then returns every state. 20 rather than a handful because
  // fork merge requests share common branch names and are filtered out afterwards.
  const query = `query($path: ID!, $branch: String!) {
  project(fullPath: $path) {
    mergeRequests(sourceBranches: [$branch], first: 20, sort: CREATED_DESC) {
      nodes { iid state sourceProject { fullPath } }
    }
  }
}`;
  return { query, variables: { path: repo.repo, branch } };
}

/**
 * Picks the merge request for a branch, following t3code: the newest open one, otherwise the
 * newest of any state. Only merge requests whose source project is `headRepo` count (the user's
 * fork when the branch was pushed there, else `repo` itself); a deleted or hidden fork reports
 * no source project. Returns at most one ref, numbered in `repo`, where the merge request lives.
 */
export function parseBranchResponse(
  repo: RepoRef,
  response: GraphQLResponse,
  headRepo: RepoRef = repo
): Ref[] | ForgeError {
  const project = response.data.project;
  if (!isRecord(project)) return reasonOf(response.errors[0]);
  // A fork on another host can never be the source of a merge request here.
  if (headRepo.host.toLowerCase() !== repo.host.toLowerCase()) return [];
  const connection = project.mergeRequests;
  const nodes = isRecord(connection) && Array.isArray(connection.nodes) ? connection.nodes : [];
  const own = nodes.flatMap((node) => {
    if (!isRecord(node) || !isRecord(node.sourceProject)) return [];
    const source = node.sourceProject.fullPath;
    const number = Number(node.iid);
    if (typeof source !== 'string' || source.toLowerCase() !== headRepo.repo.toLowerCase()) {
      return [];
    }
    if (!Number.isSafeInteger(number) || number <= 0) return [];
    return [{ number, open: node.state === 'opened' || node.state === 'locked' }];
  });
  // Nodes arrive newest first, so the first match in each pass is the newest.
  const chosen = own.find((node) => node.open) ?? own[0];
  if (!chosen) return [];
  return [
    { provider: 'gitlab', host: repo.host, repo: repo.repo, kind: 'pr', number: chosen.number }
  ];
}
