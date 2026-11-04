import type { Ref, RefKind } from '../../refs/ref.js';
import type { ForgeDefinition, RefCandidate, RepoRef } from '../provider.js';

const PUBLIC_HOST = 'github.com';

// Owner and repository names only use these characters, so a match can never be an encoded
// slash, dot segment, query or fragment that `new URL` would reinterpret.
const SEGMENT = /^[\w.-]+$/u;

// SSH config aliases such as `Host github.com-work` or `Host github-work` select a key for
// github.com. Dots are not allowed after the dash so a GHES name like
// `github-enterprise.example.com` keeps its own host.
const SSH_ALIAS = /^github(?:\.com)?-[\w-]+$/u;

const URL_REMOTE = /^(?:ssh|git|git\+ssh|https?):\/\//iu;

// `[user@]host:owner/repo`. The host part excludes `/` and `\` so local paths never match.
const SCP_REMOTE = /^(?:[\w.-]+@)?([^@:/\\\s]+):\/?([^/\s]+(?:\/[^/\s]+)+)$/u;

// The trailing group lets `/pull/12/files` and `/pull/12?w=1` through but not `/pull/12abc`.
const REF_PATH = /^\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)(?:\/|$)/u;

const KIND_WORD = '(pull request|pull|pr|issue)';
const NAMED_REFERENCE = new RegExp(`^(?:${KIND_WORD}\\s+)?([\\w-]+)/([\\w.-]+)#(\\d+)$`, 'iu');
// `\s*` accepts `pr12` and `pr #12`, which people type in search boxes.
const BARE_REFERENCE = new RegExp(`^(?:${KIND_WORD}\\s*)?#?(\\d+)$`, 'iu');

// Stops before characters that end a URL in prose or markdown: brackets, quotes, backticks.
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>()[\]{}"'`]+/giu;
const URL_TRAILING_PUNCTUATION = /[.,;:!?]+$/u;

// The lookbehind rejects matches that continue a longer token: paths (`src/a/b#1`), domains
// (`example.com/a#1`), emails and entities. Owners cannot contain dots, which also rules out
// `foo.bar/baz#1`. The lookahead rejects `o/r#12abc` and `o/r#12/x`.
const NAMED_IN_TEXT = /(?<![\w./@#&-])([\w-]+)\/([\w.-]+)#(\d+)(?![\w/])/gu;

// `&#123;` (HTML entity), `o/r#12` and `##1` are rejected by the lookbehind. A leading zero is
// rejected because `#0f0`-style colors and zero-padded labels are never issue numbers.
const BARE_IN_TEXT = /(?<![\w./&#-])#([1-9]\d*)(?!\w)/gu;

// An unterminated fence runs to the end of the text, as markdown renders it.
const CODE_FENCE = /(```|~~~)[\s\S]*?(?:\1|$)/gu;

/** Matches github.com, GitHub Enterprise Cloud (`*.ghe.com`) and GHES hosts with a `github` label. */
function isGitHubHost(host: string): boolean {
  return host === PUBLIC_HOST || host.endsWith('.ghe.com') || host.split('.').includes('github');
}

/** Joins `owner/repo` path segments, lower-cased, or returns undefined when they are not exactly that. */
function repoPath(segments: string[]): string | undefined {
  if (segments.length !== 2) return undefined;
  const valid = segments.every((part) => SEGMENT.test(part) && part !== '.' && part !== '..');
  return valid ? segments.join('/').toLowerCase() : undefined;
}

/** Parses a decimal string into a positive safe integer. */
function positiveNumber(digits: string | undefined): number | undefined {
  const value = Number(digits);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Maps a typed kind word (`pr`, `pull`, `issue`) to a ref kind. */
function kindOf(word: string | undefined): RefKind | undefined {
  if (word === undefined) return undefined;
  return word.toLowerCase() === 'issue' ? 'issue' : 'pr';
}

/** Builds a candidate, omitting `kind` when unknown so optional fields stay absent. */
function candidate(host: string, repo: string, number: number, kind?: RefKind): RefCandidate {
  return kind === undefined
    ? { provider: 'github', host, repo, number }
    : { provider: 'github', host, repo, number, kind };
}

/**
 * Lower-cases a host and folds names that reach github.com under another spelling, so refs from
 * `www.github.com` links or aliased SSH remotes share one key with github.com.
 */
function canonicalHost(host: string, ssh: boolean): string {
  const name = host.toLowerCase();
  if (name === 'www.github.com' || (ssh && SSH_ALIAS.test(name))) return PUBLIC_HOST;
  return name;
}

/** Resolves a remote host and path to a GitHub repository. */
function remoteRepo(host: string, segments: string[], ssh: boolean): RepoRef | undefined {
  const resolved = canonicalHost(host, ssh);
  if (!isGitHubHost(resolved)) return undefined;
  const repo = repoPath(segments);
  return repo === undefined ? undefined : { provider: 'github', host: resolved, repo };
}

/** Recognizes https, `ssh://`, `git://` and scp-style GitHub remotes. */
function recognizeRemote(url: string): RepoRef | undefined {
  const value = url
    .trim()
    .replace(/\/+$/u, '')
    .replace(/\.git$/iu, '');
  if (URL_REMOTE.test(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return undefined;
    }
    const segments = parsed.pathname.split('/').filter((part) => part.length > 0);
    return remoteRepo(parsed.hostname, segments, !parsed.protocol.startsWith('http'));
  }
  // A one-letter host is a Windows drive (`C:/repo`), not an scp-style remote.
  if (/^[a-z]:/iu.test(value)) return undefined;
  const scp = SCP_REMOTE.exec(value);
  if (scp?.[1] === undefined || scp[2] === undefined) return undefined;
  return remoteRepo(scp[1], scp[2].split('/'), true);
}

/** Parses a GitHub pull request or issue web URL, ignoring trailing paths, queries and fragments. */
function parseUrl(url: string): Ref | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  const host = canonicalHost(parsed.hostname, false);
  if (!isGitHubHost(host)) return undefined;
  const match = REF_PATH.exec(parsed.pathname);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const repo = repoPath([match[1], match[2]]);
  const number = positiveNumber(match[4]);
  if (repo === undefined || number === undefined) return undefined;
  return { provider: 'github', host, repo, kind: match[3] === 'pull' ? 'pr' : 'issue', number };
}

/** Parses one reference typed or pasted by the user. Bare numbers need a GitHub `base`. */
function parseReference(text: string, base?: RepoRef): RefCandidate | undefined {
  const value = text.trim();
  if (/^https?:\/\//iu.test(value)) return parseUrl(value);
  const github = base?.provider === 'github' ? base : undefined;

  const named = NAMED_REFERENCE.exec(value);
  if (named !== null) {
    const repo = repoPath([named[2] ?? '', named[3] ?? '']);
    const number = positiveNumber(named[4]);
    if (repo === undefined || number === undefined) return undefined;
    // `owner/repo#N` in a GHES session most likely points at the same server.
    return candidate(github?.host ?? PUBLIC_HOST, repo, number, kindOf(named[1]));
  }

  const bare = BARE_REFERENCE.exec(value);
  const number = positiveNumber(bare?.[2]);
  if (bare === null || number === undefined || github === undefined) return undefined;
  return candidate(github.host, github.repo, number, kindOf(bare[1]));
}

/** Replaces every match of `pattern` with spaces so later scans keep their offsets. */
function mask(text: string, pattern: RegExp): string {
  return text.replace(pattern, (match) => ' '.repeat(match.length));
}

/** Finds GitHub URLs and `owner/repo#N` references in free text. */
function scanText(text: string): RefCandidate[] {
  const found: RefCandidate[] = [];
  for (const [url] of text.matchAll(URL_IN_TEXT)) {
    const ref = parseUrl(url.replace(URL_TRAILING_PUNCTUATION, ''));
    if (ref !== undefined) found.push(ref);
  }
  // URLs are masked first so `github.com/o/r/pull/1#issuecomment-2` is not read twice.
  for (const match of mask(text, URL_IN_TEXT).matchAll(NAMED_IN_TEXT)) {
    const repo = repoPath([match[1] ?? '', match[2] ?? '']);
    const number = positiveNumber(match[3]);
    if (repo !== undefined && number !== undefined) {
      found.push(candidate(PUBLIC_HOST, repo, number));
    }
  }
  return found;
}

/** Finds bare `#N` references outside URLs and code fences, resolved against `base`. */
function scanBareNumbers(text: string, base: RepoRef): RefCandidate[] {
  if (base.provider !== 'github') return [];
  const prose = mask(mask(text, CODE_FENCE), URL_IN_TEXT);
  const found: RefCandidate[] = [];
  for (const match of prose.matchAll(BARE_IN_TEXT)) {
    const number = positiveNumber(match[1]);
    if (number !== undefined) found.push(candidate(base.host, base.repo, number));
  }
  return found;
}

/** Static GitHub definition: github.com, GitHub Enterprise Cloud and GitHub Enterprise Server. */
export const github: ForgeDefinition = {
  id: 'github',
  recognizeRemote,
  parseUrl,
  parseReference,
  scanText,
  scanBareNumbers,
  createCommand: /\bgh\s+(?:pr|issue)\s+create\b/u,
  closeCommand: /\bgh\s+(?:pr\s+(?:merge|close)|issue\s+close)\b/u,
  // `gh api` can print any number of URLs, so it is treated as a listing too.
  listCommand: /\bgh\s+(?:(?:pr|issue)\s+(?:list|status)|search\s+(?:prs|issues)|api)\b/u
};
