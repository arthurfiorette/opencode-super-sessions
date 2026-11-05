import type { ForgeDefinition, RefCandidate, RepoRef } from '../providers/provider.js';
import type { SearchHit, SearchMatch } from '../rpc.js';
import { type Ref, refKey } from './ref.js';

/** A search query reduced to what the ranking compares. */
export interface NormalizedQuery {
  /** Trimmed, lower-cased query with collapsed whitespace, for title substring matches. */
  text: string;
  /** Set when the query is a bare ref number: `12`, `#12`, `pr 12`, `pull #12`, `issue 12`. */
  number?: number;
  /** Set when the whole query is a ref URL or `owner/repo#N`. */
  exact?: RefCandidate;
}

/** A session as the ranking sees it. `refs` carry cached titles when known. */
export interface SearchSession {
  id: string;
  title: string;
  /** The session's latest activity (`activityTime`), which orders ties. */
  updated: number;
  refs: Array<{ ref: Ref; title?: string }>;
}

/** Input of {@link rankSessions}. */
export interface RankInput {
  query: string;
  definitions: ForgeDefinition[];
  sessions: SearchSession[];
  /** Session ids the server's own title search returned. They rank as title substring matches. */
  titleHits?: string[];
}

// Same leading words t3code strips, so `pr 12`, `pull #12` and `#12` all mean ref 12. GitLab's
// `mr !12` and `!12` mean the same.
const BARE_QUERY = /^(?:(?:pull request|pull|pr|merge request|mr|issue)\s*)?[#!]?\s*(\d+)$/u;

// Higher tiers always sort first; `updated` only orders sessions within one tier.
const TIERS: Record<'exact-title' | 'title' | 'ref-number' | 'ref-title', number> = {
  'exact-title': 4,
  title: 3,
  'ref-number': 2,
  'ref-title': 1
};

/** Parses a search query into title text, a bare ref number, or an exact ref. */
export function normalizeQuery(
  definitions: ForgeDefinition[],
  query: string,
  base?: RepoRef
): NormalizedQuery {
  const trimmed = query.trim().replace(/\s+/gu, ' ');
  const text = trimmed.toLowerCase();
  const bare = BARE_QUERY.exec(text);
  if (bare !== null) {
    const number = Number(bare[1]);
    return Number.isSafeInteger(number) && number > 0 ? { text, number } : { text };
  }
  for (const definition of definitions) {
    const exact = definition.parseReference(trimmed, base);
    if (exact !== undefined) return { text, exact };
  }
  return { text };
}

/**
 * Whether a session ref is the one the query names. Host is not compared because
 * `owner/repo#N` carries no host and defaults to github.com even for GHES sessions.
 */
function sameRef(ref: Ref, exact: RefCandidate): boolean {
  return (
    ref.provider === exact.provider &&
    ref.repo.toLowerCase() === exact.repo.toLowerCase() &&
    ref.number === exact.number &&
    (exact.kind === undefined || ref.kind === exact.kind)
  );
}

/**
 * The best tier a session reaches for the query, or undefined when nothing matches. Ref matches
 * carry the key of the first ref that matched, so the row can show why the session is listed.
 */
function bestTier(
  session: SearchSession,
  query: NormalizedQuery,
  titleHits: ReadonlySet<string>
): { tier: number; match: SearchMatch; ref?: string } | undefined {
  const title = session.title.trim().toLowerCase();
  if (title === query.text) return { tier: TIERS['exact-title'], match: 'title' };
  if (title.includes(query.text) || titleHits.has(session.id)) {
    return { tier: TIERS.title, match: 'title' };
  }
  // Numbers compare whole, so `12` never matches ref 123.
  const { exact, number } = query;
  const named = session.refs.find(({ ref }) =>
    exact === undefined ? ref.number === number : sameRef(ref, exact)
  );
  if (named) return { tier: TIERS['ref-number'], match: 'ref-number', ref: refKey(named.ref) };
  const titled = session.refs.find(({ title: refTitle }) =>
    refTitle?.toLowerCase().includes(query.text)
  );
  if (titled) return { tier: TIERS['ref-title'], match: 'ref-title', ref: refKey(titled.ref) };
  return undefined;
}

/**
 * Ranks sessions for a query: exact title, then title substring, then exact ref number (or the
 * exact ref for a URL or `owner/repo#N` query), then ref title substring. Newer sessions come
 * first within a tier, and each session appears once with its best match.
 */
export function rankSessions(input: RankInput): SearchHit[] {
  const query = normalizeQuery(input.definitions, input.query);
  if (query.text.length === 0) return [];
  const titleHits = new Set(input.titleHits);
  const best = new Map<string, { hit: SearchHit; updated: number }>();
  for (const session of input.sessions) {
    const found = bestTier(session, query, titleHits);
    if (found === undefined) continue;
    const previous = best.get(session.id);
    if (previous !== undefined && previous.hit.score >= found.tier) continue;
    best.set(session.id, {
      hit: {
        sessionID: session.id,
        match: found.match,
        ...(found.ref === undefined ? {} : { ref: found.ref }),
        score: found.tier
      },
      updated: session.updated
    });
  }
  return [...best.values()]
    .sort((a, b) => b.hit.score - a.hit.score || b.updated - a.updated)
    .map(({ hit }) => hit);
}
