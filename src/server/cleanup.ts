import { gitIn } from '../host/git.js';
import { type Runner, run } from '../process.js';
import type { CleanupRule, ServerSettings, WorktreeDecision } from '../rpc.js';

// Worktree cleanup decides from facts gathered per sweep. Removing a worktree has no undo, so the
// decision keeps a worktree whenever a fact is unknown, and every keep reason wins over every rule.

const DAY = 24 * 60 * 60_000;
const GIT_TIMEOUT_MS = 10_000;

/** What a session using a worktree contributes to the decision. */
export interface WorktreeSession {
  id: string;
  archived: boolean;
  /** The Done rule holds, ignoring whether the session is archived. */
  done: boolean;
  /** When it became Done, if known. */
  doneAt?: number | undefined;
  /** Epoch milliseconds of the session's last update. */
  updated: number;
  running: boolean;
  /** A permission request or a question waits for the user. */
  pending: boolean;
  /** Open in a TUI that reported it. */
  open: boolean;
  pinned: boolean;
}

/** Local changes from `git status --porcelain`. Ignored files are never listed. */
export interface LocalChanges {
  /** A tracked file is modified, deleted, renamed or in conflict, staged or not. */
  edited: boolean;
  /** A new file is staged. */
  added: boolean;
  untracked: boolean;
}

/** Everything known about one worktree. Optional fields are unknown, and unknown keeps it. */
export interface WorktreeFacts {
  directory: string;
  /** The project's main checkout. Never removed. */
  root: boolean;
  /** Sessions whose directory is the worktree or inside it, archived ones included. */
  sessions: WorktreeSession[];
  /** A session that used this worktree was deleted while the plugin was running. */
  deleted: boolean;
  status?: LocalChanges | undefined;
  /** Commits on HEAD that the default branch does not have. */
  ahead?: number | undefined;
  /** A tracked pull request is merged and none is open or a draft. */
  merged?: boolean | undefined;
  /** HEAD is in the default branch, as after a plain merge. */
  contained?: boolean | undefined;
  /** HEAD against the merged pull requests' head commits; see {@link PullHead}. */
  head?: PullHead | undefined;
}

/**
 * Where HEAD stands against the head commits of the merged pull requests. Squash and rebase
 * merges put new commits on the default branch, so only the pull request's own head shows that
 * the branch holds nothing it did not merge.
 *
 * - `included`: HEAD is a merged head, or behind one.
 * - `extra`: a head is available locally, and HEAD has commits none of them has.
 * - `missing`: no head commit is known or present in the local repository.
 */
export type PullHead = 'included' | 'extra' | 'missing';

export type CleanupSettings = Pick<
  ServerSettings,
  | 'cleanupDeleted'
  | 'cleanupMerged'
  | 'cleanupInactiveDays'
  | 'cleanupDoneDays'
  | 'cleanupUnchanged'
  | 'keepLocalChanges'
>;

/** Whether any cleanup rule is on. */
export function cleanupEnabled(settings: CleanupSettings): boolean {
  return (
    settings.cleanupDeleted ||
    settings.cleanupMerged ||
    settings.cleanupInactiveDays !== null ||
    settings.cleanupDoneDays !== null ||
    settings.cleanupUnchanged
  );
}

/**
 * Decides whether cleanup removes one worktree. Keep reasons are checked first, in order: the
 * main checkout, a session that is running, waiting, open or pinned, unreadable git state and
 * local changes under the keep mode. Only then do the enabled rules get a say, and the first
 * matching rule names the removal.
 */
export function decideWorktree(
  facts: WorktreeFacts,
  settings: CleanupSettings,
  now: number
): WorktreeDecision {
  const keep = (reason: string): WorktreeDecision => ({
    directory: facts.directory,
    action: 'keep',
    reason
  });
  const remove = (rule: CleanupRule, reason: string): WorktreeDecision => ({
    directory: facts.directory,
    action: 'remove',
    rule,
    reason
  });

  if (facts.root) return keep('main checkout');
  if (!cleanupEnabled(settings)) return keep('no cleanup rule is on');
  const sessions = facts.sessions;
  if (sessions.some((session) => session.running)) return keep('a session in it is running');
  if (sessions.some((session) => session.pending))
    return keep('a session waits for a permission or an answer');
  if (sessions.some((session) => session.open)) return keep('a session in it is open');
  if (sessions.some((session) => session.pinned)) return keep('a session in it is pinned');
  if (facts.status === undefined) return keep('git status could not be read');
  const changes = localChanges(facts.status, settings.keepLocalChanges);
  if (changes !== undefined) return keep(changes);

  // A session counts as settled once it is archived or Done; the rules for merged, Done and
  // unchanged worktrees never take one from a session the user is still working in.
  const settled = sessions.every((session) => session.archived || session.done);

  if (settings.cleanupDeleted && facts.deleted && sessions.length === 0) {
    return remove('deleted', 'its sessions were deleted');
  }
  // Why the merged rule passed over a merged pull request; reported only if no later rule removes.
  let unmerged: string | undefined;
  if (settings.cleanupMerged && facts.merged === true && settled) {
    if (facts.contained === true || facts.head === 'included') {
      return remove('merged', 'pull request merged');
    }
    if (facts.head === 'extra') unmerged = 'branch has commits the pull request did not include';
    if (facts.head === 'missing') unmerged = 'pull request head is not available locally';
  }
  const doneDays = settings.cleanupDoneDays;
  if (doneDays !== null && sessions.length > 0 && settled) {
    const cutoff = now - doneDays * DAY;
    const done = sessions.filter((session) => session.done);
    // Archived sessions that were never Done do not hold the worktree, but one Done session must
    // exist, or an archive alone would count as "Done long ago".
    if (
      done.length > 0 &&
      done.every((session) => session.doneAt !== undefined && session.doneAt <= cutoff)
    ) {
      return remove('done', doneDays === 0 ? 'its session is Done' : `Done for ${days(doneDays)}`);
    }
  }
  const inactiveDays = settings.cleanupInactiveDays;
  if (inactiveDays !== null && sessions.length > 0) {
    const cutoff = now - inactiveDays * DAY;
    if (sessions.every((session) => session.updated <= cutoff)) {
      return remove('inactive', `inactive for ${days(inactiveDays)}`);
    }
  }
  if (settings.cleanupUnchanged && facts.ahead === 0 && settled) {
    return remove('unchanged', 'no commits beyond the default branch');
  }

  if (unmerged !== undefined) return keep(unmerged);
  if (!settled) return keep('a session in it is still active');
  if (sessions.length === 0 && !facts.deleted) return keep('no session uses it');
  return keep('no cleanup rule matches');
}

/** "1 day", "3 days". */
function days(count: number): string {
  return `${count} ${count === 1 ? 'day' : 'days'}`;
}

/** The keep reason for local changes under `mode`, or undefined when they do not keep it. */
function localChanges(
  changes: LocalChanges,
  mode: ServerSettings['keepLocalChanges']
): string | undefined {
  if (changes.edited) return 'has edited tracked files';
  if (mode === 'tracked') return undefined;
  if (changes.added) return 'has uncommitted changes';
  if (mode === 'uncommitted') return undefined;
  if (changes.untracked) return 'has untracked files';
  return undefined;
}

/**
 * Reads `git status --porcelain=v1` output. The two status columns are the index and the work
 * tree; `??` is untracked, an `A` is a staged new file, anything else names a tracked file.
 */
export function parseStatus(porcelain: string): LocalChanges {
  const changes: LocalChanges = { edited: false, added: false, untracked: false };
  for (const line of porcelain.split('\n')) {
    if (line.length < 3) continue;
    const code = line.slice(0, 2);
    if (code === '??') changes.untracked = true;
    else if (code === '!!') continue;
    else if (/[MDRCTU]/.test(code)) changes.edited = true;
    else if (code.includes('A')) changes.added = true;
  }
  return changes;
}

/** Git facts of one worktree. Every field is undefined when git could not answer. */
export interface WorktreeGit {
  status?: LocalChanges;
  ahead?: number;
  /** Whether HEAD is contained in `base`. */
  contained?: boolean;
}

/**
 * Compares HEAD with pull request head commits, for squash and rebase merges the default branch
 * does not contain. Undefined when git failed on a head that exists, which keeps the worktree.
 */
export async function readPullHead(
  directory: string,
  heads: string[],
  runner: Runner = run
): Promise<PullHead | undefined> {
  const git = gitIn(runner, directory, GIT_TIMEOUT_MS);
  let available = false;
  for (const head of heads) {
    // A head that was never fetched (another clone pushed it, or the fork is gone) cannot be compared.
    if ((await git('cat-file', '-e', `${head}^{commit}`)).code !== 0) continue;
    available = true;
    const ancestor = await git('merge-base', '--is-ancestor', 'HEAD', head);
    if (ancestor.code === 0) return 'included';
    if (ancestor.code !== 1) return undefined;
  }
  return available ? 'extra' : 'missing';
}

/**
 * Reads a worktree's local changes and, given the default branch's ref, its commits beyond it
 * and whether HEAD is part of it.
 */
export async function readWorktreeGit(
  directory: string,
  base: string | undefined,
  runner: Runner = run
): Promise<WorktreeGit> {
  const git = gitIn(runner, directory, GIT_TIMEOUT_MS);
  // `--untracked-files=all` so a new directory of files is not reported as one line that a
  // reader might take for a file; no `--ignored`, since ignored files never keep a worktree.
  const status = await git('status', '--porcelain=v1', '--untracked-files=all');
  const result: WorktreeGit = {};
  if (status.code === 0) result.status = parseStatus(status.stdout);
  if (base === undefined) return result;
  const ahead = await git('rev-list', '--count', `${base}..HEAD`);
  const count = Number.parseInt(ahead.stdout.trim(), 10);
  if (ahead.code === 0 && Number.isFinite(count)) result.ahead = count;
  // Exit 0: contained, 1: not contained, anything else: git failed, so unknown.
  const ancestor = await git('merge-base', '--is-ancestor', 'HEAD', base);
  if (ancestor.code === 0) result.contained = true;
  if (ancestor.code === 1) result.contained = false;
  return result;
}

/**
 * The ref of the default branch to compare a worktree with: the remote's default branch when the
 * clone recorded it, else the branch checked out in the main checkout. Undefined when neither
 * resolves, which leaves `ahead` and `merged` unknown.
 */
export async function defaultBranchRef(
  root: string,
  remote: { remote?: string | undefined; defaultBranch?: string | undefined },
  runner: Runner = run
): Promise<string | undefined> {
  const git = gitIn(runner, root, GIT_TIMEOUT_MS);
  if (remote.remote !== undefined && remote.defaultBranch !== undefined) {
    const ref = `refs/remotes/${remote.remote}/${remote.defaultBranch}`;
    if ((await git('rev-parse', '--verify', '--quiet', ref)).code === 0) return ref;
  }
  const head = await git('symbolic-ref', '--quiet', 'HEAD');
  return head.code === 0 && head.stdout.trim() ? head.stdout.trim() : undefined;
}
