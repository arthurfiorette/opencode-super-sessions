import { candidateKey, type Snapshot } from '../cache.js';
import type {
  ForgeDefinition,
  ForgeErrorReason,
  RefCandidate,
  RepoRef
} from '../providers/provider.js';
import {
  type Ref,
  type RefLink,
  type RefSource,
  type RefState,
  refKey,
  type SessionRefs,
  TRACKED_SOURCES
} from '../refs/ref.js';
import { mergeLinks } from '../refs/store.js';
import type { RepoInfo } from '../repo.js';
import type { SessionAccess } from './queue.js';
import { type Runtime, warn } from './runtime.js';

/** Why a candidate could not be checked: a forge error, or a forge with no enabled provider. */
export type UnverifiedReason = ForgeErrorReason | 'disabled';

/** What the forge said about one candidate. */
export type Resolution =
  | { status: 'found'; ref: Ref; state: RefState }
  /** The forge was unreachable, but the candidate already named its kind, so it is a usable ref. */
  | { status: 'unverified'; ref: Ref; reason: UnverifiedReason }
  | { status: 'not-found'; candidate: RefCandidate }
  /** The forge was unreachable and the candidate is a bare number of unknown kind. */
  | { status: 'unknown'; candidate: RefCandidate; reason: UnverifiedReason };

/** Reads a directory's repository and branch. Git failures resolve to an empty object. */
export async function resolveRepo(runtime: Runtime, directory: string): Promise<RepoInfo> {
  return runtime.repos.resolve(directory).catch((error: unknown) => {
    warn(`Reading the git checkout of ${directory} failed`, error);
    return {};
  });
}

/** Parses one reference with the first enabled forge that understands it. */
export function parseReference(
  definitions: ForgeDefinition[],
  text: string,
  base?: RepoRef
): RefCandidate | undefined {
  for (const definition of definitions) {
    const candidate = definition.parseReference(text, base);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

/**
 * Checks candidates against the forge through the snapshot cache, in input order. Fresh cached
 * answers are reused; `force` refetches the rest.
 */
export async function resolveCandidates(
  runtime: Runtime,
  candidates: RefCandidate[],
  options: { force?: boolean } = {}
): Promise<Resolution[]> {
  const answers = new Map<string, Map<string, Snapshot>>();
  await Promise.all(
    [...runtime.providers].map(async ([id, provider]) => {
      const own = candidates.filter((candidate) => candidate.provider === id);
      if (own.length > 0) answers.set(id, await runtime.cache.ensure(provider, own, options));
    })
  );
  return candidates.map((candidate): Resolution => {
    const snapshot = answers.get(candidate.provider)?.get(candidateKey(candidate));
    if (snapshot !== undefined && 'ref' in snapshot) {
      return { status: 'found', ref: snapshot.ref, state: snapshot.state };
    }
    if (snapshot?.reason === 'not-found') return { status: 'not-found', candidate };
    const reason: UnverifiedReason = runtime.providers.has(candidate.provider)
      ? (snapshot?.reason ?? 'failed')
      : 'disabled';
    if (candidate.kind === undefined) return { status: 'unknown', candidate, reason };
    return { status: 'unverified', ref: { ...candidate, kind: candidate.kind }, reason };
  });
}

/** Refreshes known refs through the snapshot cache, ignoring the answers. */
export async function ensureRefs(
  runtime: Runtime,
  refs: Ref[],
  options: { force?: boolean } = {}
): Promise<void> {
  if (refs.length > 0) await resolveCandidates(runtime, refs, options);
}

/** The refs among resolutions that may be linked: found, or of known kind while the forge is down. */
export function usableRefs(resolutions: Resolution[]): Ref[] {
  return resolutions.flatMap((resolution) =>
    resolution.status === 'found' || resolution.status === 'unverified' ? [resolution.ref] : []
  );
}

/** Builds links stamped now. */
export function linksOf(refs: Ref[], source: RefSource, via?: string): RefLink[] {
  const linkedAt = Date.now();
  return refs.map((ref) =>
    via === undefined ? { ref, source, linkedAt } : { ref, source, linkedAt, via }
  );
}

/** Merges links into a session through the write queue. Skips the queue for an empty list. */
export async function addLinks(
  runtime: Runtime,
  session: SessionAccess,
  sessionID: string,
  links: RefLink[]
): Promise<SessionRefs | undefined> {
  if (links.length === 0) return undefined;
  return runtime.writes.update(session, sessionID, (refs) => mergeLinks(refs, links));
}

/**
 * Detection path shared by the shell hook and the event subscriber: checks candidates, drops the
 * ones the forge does not know or that have no kind, and links the rest under `source`.
 */
export async function linkDetected(
  runtime: Runtime,
  session: SessionAccess,
  sessionID: string,
  candidates: RefCandidate[],
  source: RefSource
): Promise<void> {
  if (candidates.length === 0) return;
  const refs = usableRefs(await resolveCandidates(runtime, candidates));
  await addLinks(runtime, session, sessionID, linksOf(refs, source));
}

/**
 * Issues that the session's tracked pull requests close, as `closes` links pointing back at their
 * PR. Reads cached snapshots only.
 */
function closesLinks(runtime: Runtime, refs: SessionRefs, branchRefs: Ref[]): RefLink[] {
  const prs = [
    ...refs.links
      .filter((link) => TRACKED_SOURCES.has(link.source) && link.ref.kind === 'pr')
      .map((link) => link.ref),
    ...branchRefs
  ];
  return prs.flatMap((pr) => {
    const snapshot = runtime.cache.get(refKey(pr));
    if (snapshot === undefined || !('ref' in snapshot)) return [];
    return linksOf(snapshot.state.closes ?? [], 'closes', refKey(pr));
  });
}

/**
 * Records the issues tracked PRs close. Checks against the refs already read first, so the common
 * case of nothing new costs no queued read and no write.
 */
export async function syncCloses(
  runtime: Runtime,
  session: SessionAccess,
  sessionID: string,
  refs: SessionRefs,
  branchRefs: Ref[]
): Promise<SessionRefs> {
  const links = closesLinks(runtime, refs, branchRefs);
  if (links.length === 0 || !mergeLinks(refs, links).changed) return refs;
  return runtime.writes.update(session, sessionID, (current) => mergeLinks(current, links));
}

/** Short text for why a ref could not be checked, for tool results. */
export function reasonText(reason: UnverifiedReason): string {
  const texts: Record<UnverifiedReason, string> = {
    'missing-tool': 'the forge CLI (gh or glab) is not installed or ghPath/glabPath is wrong',
    unauthenticated: 'the forge CLI is not logged in',
    forbidden: 'access was denied',
    'rate-limited': 'the forge rate limit is exhausted',
    'not-found': 'it does not exist',
    failed: 'the request failed',
    disabled: 'this forge is not enabled'
  };
  return texts[reason];
}

/** `owner/repo#N`, the form agents and users type. */
export function refLabel(ref: RefCandidate): string {
  return `${ref.repo}#${ref.number}`;
}
