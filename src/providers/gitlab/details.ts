import type { PullCheck, PullDetails, Ref } from '../../refs/ref.js';
import { type CheckEntry, foldChecks } from '../checks.js';
import { isRecord } from '../include.js';
import type { ForgeError } from '../provider.js';
import type { GraphQLResponse } from './output.js';

// Scored 28 of 200 on gitlab.com. Retried jobs were replaced by a later run of the same job.
const DETAILS_QUERY = `query($path: ID!, $iid: String!) {
  project(fullPath: $path) {
    mergeRequest(iid: $iid) {
      author { username } sourceBranch targetBranch description
      headPipeline { jobs(retried: false, first: 100) {
        pageInfo { hasNextPage }
        nodes { name status webPath stage { name } }
      } }
    }
  }
}`;

/** Builds the details lookup of one merge request. */
export function buildDetailsQuery(ref: Ref): {
  query: string;
  variables: Record<string, string>;
} {
  return { query: DETAILS_QUERY, variables: { path: ref.repo, iid: String(ref.number) } };
}

// Manual jobs wait for a person, which says nothing about the code; they are left out, as in the
// snapshot's job counts, so the preview's check summary adds up to the same total.
const STATUSES: Record<string, PullCheck['status']> = {
  SUCCESS: 'success',
  FAILED: 'failure',
  CANCELED: 'cancelled',
  CANCELING: 'cancelled',
  SKIPPED: 'skipped',
  CREATED: 'pending',
  WAITING_FOR_RESOURCE: 'pending',
  PREPARING: 'pending',
  WAITING_FOR_CALLBACK: 'pending',
  PENDING: 'pending',
  RUNNING: 'pending',
  SCHEDULED: 'pending'
};

/** Reads one job into a check entry, with its page on `host`. */
function entryOf(node: unknown, host: string): CheckEntry[] {
  if (!isRecord(node) || typeof node.name !== 'string' || typeof node.status !== 'string') {
    return [];
  }
  if (node.status === 'MANUAL') return [];
  const url = typeof node.webPath === 'string' ? `https://${host}${node.webPath}` : undefined;
  const stage = isRecord(node.stage) ? node.stage.name : undefined;
  return [
    {
      check: {
        name: node.name,
        status: STATUSES[node.status] ?? 'neutral',
        ...(url === undefined ? {} : { url })
      },
      group: typeof stage === 'string' ? stage : undefined,
      at: 0
    }
  ];
}

/** Reads a details response; a missing or hidden merge request comes back as a plain null. */
export function parseDetailsResponse(
  response: GraphQLResponse,
  host: string
): PullDetails | ForgeError {
  const project = response.data.project;
  const merge = isRecord(project) ? project.mergeRequest : undefined;
  if (!isRecord(merge))
    return response.errors.length > 0 ? { reason: 'failed' } : { reason: 'not-found' };
  const jobs = isRecord(merge.headPipeline) ? merge.headPipeline.jobs : undefined;
  const nodes = isRecord(jobs) && Array.isArray(jobs.nodes) ? jobs.nodes : [];
  const more = isRecord(jobs) && isRecord(jobs.pageInfo) && jobs.pageInfo.hasNextPage;
  const author = isRecord(merge.author) ? merge.author.username : undefined;
  return {
    ...(typeof author === 'string' ? { author } : {}),
    ...(typeof merge.sourceBranch === 'string' ? { head: merge.sourceBranch } : {}),
    ...(typeof merge.targetBranch === 'string' ? { base: merge.targetBranch } : {}),
    body: typeof merge.description === 'string' ? merge.description : '',
    checks: foldChecks(nodes.flatMap((node) => entryOf(node, host))),
    ...(more === true ? { checksTruncated: true } : {})
  };
}
