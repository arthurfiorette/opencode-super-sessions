import type { Ref, RefKind } from '../../refs/ref.js';
import type { ForgeDefinition, RefCandidate, RepoRef } from '../provider.js';

const PUBLIC_HOST = 'gitlab.com';

// Group and project paths only use these characters, so a match can never be an encoded slash,
// dot segment, query or fragment that `new URL` would reinterpret.
const SEGMENT = /^[\w.-]+$/u;

// SSH config aliases such as `Host gitlab.com-work` or `Host gitlab-work` select a key for
// gitlab.com. Dots are not allowed after the dash so `gitlab-ce.example.com` keeps its own host.
const SSH_ALIAS = /^gitlab(?:\.com)?-[\w-]+$/u;
// gitlab.com serves SSH on port 443 under this name for networks that block port 22.
const ALT_SSH_HOST = 'altssh.gitlab.com';

const URL_REMOTE = /^(?:ssh|git|git\+ssh|https?):\/\//iu;

// `[user@]host:group/project`. The host part excludes `/` and `\` so local paths never match.
const SCP_REMOTE = /^(?:[\w.-]+@)?([^@:/\\\s]+):\/?([^/\s]+(?:\/[^/\s]+)+)$/u;

// Project pages sit under `/-/`, which no group or project may be named. gitlab.com links
// issues as `work_items` and still serves `issues`, so both mean an issue. The trailing group
// lets `/merge_requests/12/diffs` and `/issues/12?x=1` through but not `/issues/12abc`.
const REF_PATH = /^\/((?:[^/]+\/)+[^/]+)\/-\/(merge_requests|issues|work_items)\/(\d+)(?:\/|$)/u;

const KIND_WORD = '(merge request|mr|pull request|pull|pr|issue)';
// `!` marks a merge request and `#` an issue, as GitLab's own references do.
const NAMED_REFERENCE = new RegExp(
  `^(?:${KIND_WORD}\\s+)?((?:[\\w.-]+/)+[\\w.-]+)([!#])(\\d+)$`,
  'iu'
);
// `\s*` accepts `mr12` and `mr !12`, which people type in search boxes.
const BARE_REFERENCE = new RegExp(`^(?:${KIND_WORD}\\s*)?([!#])?(\\d+)$`, 'iu');

// Stops before characters that end a URL in prose or markdown: brackets, quotes, backticks.
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>()[\]{}"'`]+/giu;
const URL_TRAILING_PUNCTUATION = /[.,;:!?]+$/u;

// The lookbehind rejects matches that continue a longer token: paths, emails and entities. The
// first segment cannot contain a dot, which rules out domains such as `example.com/a#1`. The
// lookahead rejects `g/p#12abc` and `g/p#12/x`.
const NAMED_IN_TEXT = /(?<![\w./@#&!-])([\w-]+(?:\/[\w.-]+)+)([!#])(\d+)(?![\w/])/gu;

// `&#123;`, `g/p#12`, `##1` and `Done!1` are rejected by the lookbehind. A leading zero is
// rejected because `#0f0`-style colors and zero-padded labels are never references.
const BARE_IN_TEXT = /(?<![\w./&#!-])([#!])([1-9]\d*)(?!\w)/gu;

// An unterminated fence runs to the end of the text, as markdown renders it.
const CODE_FENCE = /(```|~~~)[\s\S]*?(?:\1|$)/gu;

/** Joins project path segments, lower-cased, or returns undefined unless it is `group/.../project`. */
function repoPath(segments: string[]): string | undefined {
  if (segments.length < 2) return undefined;
  const valid = segments.every(
    (part) => SEGMENT.test(part) && part !== '.' && part !== '..' && part !== '-'
  );
  return valid ? segments.join('/').toLowerCase() : undefined;
}

/** Parses a decimal string into a positive safe integer. */
function positiveNumber(digits: string | undefined): number | undefined {
  const value = Number(digits);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Combines a typed kind word and a `!`/`#` sigil. Returns null when they disagree, as in
 * `issue !12`, and undefined when neither says anything.
 */
function kindOf(word: string | undefined, sigil: string | undefined): RefKind | null | undefined {
  const fromWord = word === undefined ? undefined : word.toLowerCase() === 'issue' ? 'issue' : 'pr';
  const fromSigil = sigil === undefined ? undefined : sigil === '!' ? 'pr' : 'issue';
  if (fromWord !== undefined && fromSigil !== undefined && fromWord !== fromSigil) return null;
  return fromWord ?? fromSigil;
}

/** Builds a candidate, omitting `kind` when unknown so optional fields stay absent. */
function candidate(
  host: string,
  repo: string,
  number: number,
  kind?: RefKind | null
): RefCandidate {
  return kind === undefined || kind === null
    ? { provider: 'gitlab', host, repo, number }
    : { provider: 'gitlab', host, repo, number, kind };
}

/**
 * Lower-cases a host and folds names that reach gitlab.com under another spelling, so refs from
 * `www.gitlab.com` links or aliased SSH remotes share one key with gitlab.com.
 */
function canonicalHost(host: string, ssh: boolean): string {
  const name = host.toLowerCase();
  if (name === 'www.gitlab.com') return PUBLIC_HOST;
  if (ssh && (name === ALT_SSH_HOST || SSH_ALIAS.test(name))) return PUBLIC_HOST;
  return name;
}

/** Replaces every match of `pattern` with spaces so later scans keep their offsets. */
function mask(text: string, pattern: RegExp): string {
  return text.replace(pattern, (match) => ' '.repeat(match.length));
}

/**
 * Creates the GitLab definition. `hosts` adds self-managed servers whose names carry no `gitlab`
 * label; gitlab.com and hosts such as `gitlab.example.com` are always recognized.
 */
export function createGitLabDefinition(
  options: { hosts?: readonly string[] } = {}
): ForgeDefinition {
  const extra = new Set((options.hosts ?? []).map((host) => host.toLowerCase()));

  /** Matches gitlab.com, hosts with a `gitlab` label, and configured hosts. */
  const isGitLabHost = (host: string) =>
    host === PUBLIC_HOST || host.split('.').includes('gitlab') || extra.has(host);

  /** Resolves a remote host and path to a GitLab project. */
  const remoteRepo = (host: string, segments: string[], ssh: boolean): RepoRef | undefined => {
    const resolved = canonicalHost(host, ssh);
    if (!isGitLabHost(resolved)) return undefined;
    const repo = repoPath(segments);
    return repo === undefined ? undefined : { provider: 'gitlab', host: resolved, repo };
  };

  /** Recognizes https, `ssh://`, `git://` and scp-style GitLab remotes with nested groups. */
  const recognizeRemote = (url: string): RepoRef | undefined => {
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
  };

  /** Parses a merge request or issue web URL, ignoring trailing paths, queries and fragments. */
  const parseUrl = (url: string): Ref | undefined => {
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      return undefined;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    const host = canonicalHost(parsed.hostname, false);
    if (!isGitLabHost(host)) return undefined;
    const match = REF_PATH.exec(parsed.pathname);
    if (match?.[1] === undefined) return undefined;
    const repo = repoPath(match[1].split('/'));
    const number = positiveNumber(match[3]);
    if (repo === undefined || number === undefined) return undefined;
    const kind = match[2] === 'merge_requests' ? 'pr' : 'issue';
    return { provider: 'gitlab', host, repo, kind, number };
  };

  /**
   * Parses one reference typed or pasted by the user. Without a host, a reference belongs to the
   * session's forge, so only URLs are read when `base` is on another forge.
   */
  const parseReference = (text: string, base?: RepoRef): RefCandidate | undefined => {
    const value = text.trim();
    if (/^https?:\/\//iu.test(value)) return parseUrl(value);
    if (base !== undefined && base.provider !== 'gitlab') return undefined;

    const named = NAMED_REFERENCE.exec(value);
    if (named !== null) {
      const repo = repoPath((named[2] ?? '').split('/'));
      const number = positiveNumber(named[4]);
      const kind = kindOf(named[1], named[3]);
      if (repo === undefined || number === undefined || kind === null) return undefined;
      // `group/project#N` in a self-managed session most likely points at the same server.
      return candidate(base?.host ?? PUBLIC_HOST, repo, number, kind);
    }

    const bare = BARE_REFERENCE.exec(value);
    const number = positiveNumber(bare?.[3]);
    if (bare === null || number === undefined || base === undefined) return undefined;
    const kind = kindOf(bare[1], bare[2]);
    return kind === null ? undefined : candidate(base.host, base.repo, number, kind);
  };

  /** Finds GitLab URLs and `group/project!N` or `group/project#N` references in free text. */
  const scanText = (text: string): RefCandidate[] => {
    const found: RefCandidate[] = [];
    for (const [url] of text.matchAll(URL_IN_TEXT)) {
      const ref = parseUrl(url.replace(URL_TRAILING_PUNCTUATION, ''));
      if (ref !== undefined) found.push(ref);
    }
    // URLs are masked first so a `#note_1` fragment is not read as a second reference.
    for (const match of mask(text, URL_IN_TEXT).matchAll(NAMED_IN_TEXT)) {
      const repo = repoPath((match[1] ?? '').split('/'));
      const number = positiveNumber(match[3]);
      if (repo !== undefined && number !== undefined) {
        found.push(candidate(PUBLIC_HOST, repo, number, kindOf(undefined, match[2])));
      }
    }
    return found;
  };

  /** Finds bare `#N` (issues) and `!N` (merge requests) outside URLs and code fences. */
  const scanBareNumbers = (text: string, base: RepoRef): RefCandidate[] => {
    if (base.provider !== 'gitlab') return [];
    const prose = mask(mask(text, CODE_FENCE), URL_IN_TEXT);
    const found: RefCandidate[] = [];
    for (const match of prose.matchAll(BARE_IN_TEXT)) {
      const number = positiveNumber(match[2]);
      if (number !== undefined) {
        found.push(candidate(base.host, base.repo, number, kindOf(undefined, match[1])));
      }
    }
    return found;
  };

  return {
    id: 'gitlab',
    recognizeRemote,
    parseUrl,
    parseReference,
    scanText,
    scanBareNumbers,
    createCommand: /\bglab\s+(?:mr|issue)\s+(?:create|new)\b/u,
    closeCommand: /\bglab\s+(?:mr\s+(?:merge|accept|close)|issue\s+close)\b/u,
    // `glab api` can print any number of URLs, so it is treated as a listing too.
    listCommand: /\bglab\s+(?:(?:mr|issue)\s+(?:list|ls)|api)\b/u
  };
}

/** Static GitLab definition for gitlab.com and self-managed hosts with a `gitlab` label. */
export const gitlab: ForgeDefinition = createGitLabDefinition();
