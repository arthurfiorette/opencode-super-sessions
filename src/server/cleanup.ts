import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { gitIn } from '../host/git.js';
import { type Runner, run } from '../process.js';
import { refKey } from '../refs/ref.js';
import { trackedRefs } from '../refs/summary.js';
import type { CleanupRule, ServerSettings, SessionRefView, WorktreeDecision } from '../rpc.js';

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

/** Everything known about one worktree. Optional fields are unknown, and unknown keeps it. */
export interface WorktreeFacts {
  directory: string;
  /** The project's main checkout. Never removed. */
  root: boolean;
  /** Sessions whose directory is the worktree or inside it, archived ones included. */
  sessions: WorktreeSession[];
  /** A session that used this worktree was deleted while the plugin was running. */
  deleted: boolean;
  /** A file is modified, staged or untracked; see {@link parseStatus}. */
  changed?: boolean | undefined;
  /** Commits on HEAD that the default branch does not have. */
  ahead?: number | undefined;
  /** A tracked pull request is merged and none is open or a draft. */
  merged?: boolean | undefined;
  /** HEAD is in the default branch, as after a plain merge. */
  contained?: boolean | undefined;
  /**
   * A local branch, remote branch or tag contains HEAD, so its commits outlive the worktree.
   * OpenCode creates worktrees on a detached HEAD, where a new commit has no ref until the agent
   * makes a branch.
   */
  referenced?: boolean | undefined;
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
 * main checkout, a session that is running, waiting, open or pinned, unreadable git state, local
 * changes and commits only the worktree's HEAD holds. Only then do the enabled rules get a say,
 * and the first matching rule names the removal.
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
  if (facts.changed === undefined) return keep('git status could not be read');
  // `git worktree remove` without `--force` refuses these anyway; keeping them here means a
  // sweep does not retry and log a failure every time.
  if (facts.changed) return keep('has local changes');
  const unreferenced = unreferencedCommits(facts);
  if (unreferenced !== undefined) return keep(unreferenced);

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
  // A session must exist: a worktree created a moment ago has no commits and no session yet.
  if (settings.cleanupUnchanged && facts.ahead === 0 && sessions.length > 0 && settled) {
    return remove('unchanged', 'no commits beyond the default branch');
  }

  if (unmerged !== undefined) return keep(unmerged);
  if (!settled) return keep('a session in it is still active');
  if (sessions.length === 0 && !facts.deleted) return keep('no session uses it');
  return keep('no cleanup rule matches');
}

/**
 * The keep reason when HEAD may hold commits that only the worktree reaches, or undefined when
 * every commit is safe elsewhere: in the default branch, in a ref, or in a merged pull request's
 * head on the forge.
 */
function unreferencedCommits(facts: WorktreeFacts): string | undefined {
  if (facts.ahead === 0 || facts.contained === true || facts.head === 'included') return undefined;
  if (facts.referenced === true) return undefined;
  if (facts.referenced === false && facts.ahead !== undefined) {
    return 'has commits no branch or tag contains';
  }
  return 'could not tell whether a branch holds its commits';
}

/**
 * Maps each worktree directory to the sessions in it. A session belongs to the deepest worktree
 * containing its directory, since linked worktrees often sit inside the main checkout
 * (`.worktrees/<name>`).
 */
export async function assignSessions(
  sessions: ReadonlyArray<{ id: string; directory: string }>,
  worktrees: readonly string[]
): Promise<Map<string, string[]>> {
  const owners = new Map<string, string[]>();
  // OpenCode stores worktrees resolved, but a session's directory keeps the path it was opened
  // with (`/var` and `/private/var` on macOS), so both sides are compared resolved.
  const resolved = new Map<string, Promise<string>>();
  /** The resolved path of `directory`, or the path itself when it no longer exists. */
  const real = (directory: string) => {
    let value = resolved.get(directory);
    if (value === undefined) {
      value = realpath(directory).catch(() => directory);
      resolved.set(directory, value);
    }
    return value;
  };
  // Deepest first, so `.worktrees/a` wins over the checkout that contains it.
  const targets = (
    await Promise.all(
      worktrees.map(async (directory) => ({ directory, real: await real(directory) }))
    )
  ).sort((a, b) => b.real.length - a.real.length);
  for (const session of sessions) {
    const directory = await real(session.directory);
    // The separator keeps `a` from claiming the sessions of its sibling `ab`.
    const owner = targets.find(
      (target) =>
        directory === target.real ||
        directory.startsWith(target.real.endsWith(path.sep) ? target.real : target.real + path.sep)
    )?.directory;
    if (owner === undefined) continue;
    const list = owners.get(owner) ?? [];
    list.push(session.id);
    owners.set(owner, list);
  }
  return owners;
}

/**
 * Whether the sessions' tracked pull requests count as merged: one is merged and every other is
 * merged or closed. An unknown state, or one still open or a draft, blocks it.
 */
export function mergedPull(views: readonly SessionRefView[]): boolean {
  const pulls = views.flatMap((view) =>
    trackedRefs(view)
      .filter((ref) => ref.kind === 'pr')
      .map((ref) => view.states[refKey(ref)]?.status)
  );
  return (
    pulls.includes('merged') &&
    pulls.every((status) => status !== undefined && status !== 'open' && status !== 'draft')
  );
}

/** Head commits of the tracked pull requests that are merged, as the forge last reported them. */
export function mergedHeads(views: readonly SessionRefView[]): string[] {
  const heads = views.flatMap((view) =>
    trackedRefs(view).flatMap((ref) => {
      const state = ref.kind === 'pr' ? view.states[refKey(ref)] : undefined;
      return state?.status === 'merged' && state.headSha !== undefined ? [state.headSha] : [];
    })
  );
  return [...new Set(heads)];
}

/** "1 day", "3 days". */
function days(count: number): string {
  return `${count} ${count === 1 ? 'day' : 'days'}`;
}

/**
 * Whether `git status --porcelain=v1` output lists a modified, staged or untracked file. Every
 * line is one, except `!!` for an ignored file, which only appears with `--ignored`.
 */
export function parseStatus(porcelain: string): boolean {
  return porcelain.split('\n').some((line) => line.length >= 3 && !line.startsWith('!!'));
}

/** Git facts of one worktree. Every field is undefined when git could not answer. */
export interface WorktreeGit {
  changed?: boolean;
  ahead?: number;
  /** Whether HEAD is contained in `base`. */
  contained?: boolean;
  /** See {@link WorktreeFacts.referenced}. Only read when HEAD may be ahead of `base`. */
  referenced?: boolean;
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
 * Reads a worktree's local changes, whether a ref holds HEAD and, given the default branch's
 * ref, its commits beyond it and whether HEAD is part of it.
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
  if (status.code === 0) result.changed = parseStatus(status.stdout);
  if (base !== undefined) {
    const ahead = await git('rev-list', '--count', `${base}..HEAD`);
    const count = Number.parseInt(ahead.stdout.trim(), 10);
    if (ahead.code === 0 && Number.isFinite(count)) result.ahead = count;
    // Exit 0: contained, 1: not contained, anything else: git failed, so unknown.
    const ancestor = await git('merge-base', '--is-ancestor', 'HEAD', base);
    if (ancestor.code === 0) result.contained = true;
    if (ancestor.code === 1) result.contained = false;
  }
  if (result.ahead === 0) return result;
  // Only shared refs count: per-worktree refs such as `refs/bisect` go with the worktree.
  const refs = await git(
    'for-each-ref',
    '--contains',
    'HEAD',
    '--count=1',
    '--format=%(refname)',
    'refs/heads',
    'refs/remotes',
    'refs/tags'
  );
  if (refs.code === 0) result.referenced = refs.stdout.trim() !== '';
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
