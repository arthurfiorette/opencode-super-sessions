import type { ProviderId, Ref, RefKind, RefState } from '../refs/ref.js';

/** A repository on a forge, as derived from a git remote. */
export interface RepoRef {
  provider: ProviderId;
  host: string;
  /** `owner/name`, or a nested GitLab path. */
  repo: string;
}

/** A ref parsed from text whose kind may still be unknown, such as a bare `#123` on GitHub. */
export interface RefCandidate {
  provider: ProviderId;
  host: string;
  repo: string;
  kind?: RefKind;
  number: number;
}

/**
 * Static, side-effect free description of a forge. Shared by the server plugin, the TUI (for
 * parsing search input) and tests.
 */
export interface ForgeDefinition {
  id: ProviderId;
  /** Recognizes `https`, `ssh://`, `git://` and scp-style remotes. Returns undefined for other forges. */
  recognizeRemote(url: string): RepoRef | undefined;
  /** Parses a pull request or issue web URL. */
  parseUrl(url: string): Ref | undefined;
  /**
   * Parses a single reference typed or pasted by a user: a URL, `owner/repo#N`, or `#N`/`N` when
   * `base` is known. Bare numbers resolve against `base` and have no kind until the forge answers.
   */
  parseReference(text: string, base?: RepoRef): RefCandidate | undefined;
  /** Finds every URL and `owner/repo#N` reference in free text. Never returns bare `#N`. */
  scanText(text: string): RefCandidate[];
  /** Finds bare `#N` references in free text, resolved against `base`. Only used for user prompts. */
  scanBareNumbers(text: string, base: RepoRef): RefCandidate[];
  /** Matches a shell command that creates a pull request or issue, such as `gh pr create`. */
  createCommand: RegExp;
  /** Matches a shell command that merges or closes a pull request, such as `gh pr merge`. */
  closeCommand: RegExp;
  /** Matches a shell command that lists or queries many refs. Used to skip ambiguous output. */
  listCommand: RegExp;
}

export type ForgeErrorReason =
  | 'missing-tool'
  | 'unauthenticated'
  | 'forbidden'
  | 'rate-limited'
  | 'not-found'
  | 'failed';

export interface ForgeError {
  reason: ForgeErrorReason;
  /** Epoch milliseconds before which the caller should not retry. */
  retryAt?: number;
}

export type Availability = 'ok' | 'missing-tool' | 'unauthenticated';

/** Runtime half of a forge. Only the server plugin constructs these because they spawn CLIs. */
export interface ForgeProvider {
  definition: ForgeDefinition;
  available(host: string): Promise<Availability>;
  /**
   * Pull requests in `repo` whose head is `branch` of `headRepo`, newest first. `headRepo`
   * defaults to `repo`; pass the fork when the branch was pushed to one.
   */
  branchPullRequests(
    repo: RepoRef,
    branch: string,
    headRepo?: RepoRef
  ): Promise<Ref[] | ForgeError>;
  /**
   * Resolves candidates (filling in `kind`) and returns their live state in input order.
   * Batched; one missing number fails only its own entry with `not-found`.
   */
  snapshot(candidates: RefCandidate[]): Promise<Array<{ ref: Ref; state: RefState } | ForgeError>>;
}
