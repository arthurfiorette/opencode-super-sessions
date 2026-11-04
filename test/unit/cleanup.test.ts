import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type ArchiveFacts, isArchiveDue } from '../../src/server/auto-archive.js';
import {
  type CleanupSettings,
  decideWorktree,
  parseStatus,
  readPullHead,
  type WorktreeFacts,
  type WorktreeSession
} from '../../src/server/cleanup.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 4, 12);

const OFF: CleanupSettings = {
  cleanupDeleted: false,
  cleanupMerged: false,
  cleanupInactiveDays: null,
  cleanupDoneDays: null,
  cleanupUnchanged: false,
  keepLocalChanges: 'any'
};

/** A settled session: Done four days ago, last touched ten days ago, nothing holding it. */
const session = (patch: Partial<WorktreeSession> = {}): WorktreeSession => ({
  id: 'ses_1',
  archived: false,
  done: true,
  doneAt: NOW - 4 * DAY,
  updated: NOW - 10 * DAY,
  running: false,
  pending: false,
  open: false,
  pinned: false,
  ...patch
});

/** A clean, merged, unchanged worktree with one settled session. Every rule could take it. */
const worktree = (patch: Partial<WorktreeFacts> = {}): WorktreeFacts => ({
  directory: '/repo/.worktrees/a',
  root: false,
  sessions: [session()],
  deleted: false,
  status: parseStatus(''),
  ahead: 0,
  merged: true,
  contained: true,
  ...patch
});

test('cleanup removes a worktree only under an enabled rule and never against a keep reason', () => {
  const cases: Array<[string, Partial<CleanupSettings>, Partial<WorktreeFacts>, string]> = [
    ['every rule off', {}, {}, 'keep'],
    ['merged', { cleanupMerged: true }, {}, 'remove:merged'],
    ['no merged pull request', { cleanupMerged: true }, { merged: false }, 'keep'],
    // Squash and rebase merges leave HEAD out of the default branch; the PR head decides.
    [
      'squash merged, HEAD is the pull request head',
      { cleanupMerged: true },
      { contained: false, head: 'included' },
      'remove:merged'
    ],
    [
      'squash merged, one local commit the pull request lacks',
      { cleanupMerged: true },
      { contained: false, head: 'extra' },
      'keep:branch has commits the pull request did not include'
    ],
    [
      'squash merged, head never fetched',
      { cleanupMerged: true },
      { contained: false, head: 'missing' },
      'keep:pull request head is not available locally'
    ],
    [
      'merged, git state unknown',
      { cleanupMerged: true },
      { contained: undefined, head: undefined },
      'keep'
    ],
    [
      'merged, but the user still works in the session',
      { cleanupMerged: true },
      { sessions: [session({ done: false })] },
      'keep'
    ],
    [
      'merged, session archived without being Done',
      { cleanupMerged: true },
      { sessions: [session({ done: false, archived: true })] },
      'remove:merged'
    ],
    ['main checkout', { cleanupMerged: true, cleanupUnchanged: true }, { root: true }, 'keep'],
    ['git status unreadable', { cleanupMerged: true }, { status: undefined }, 'keep'],
    [
      'running session',
      { cleanupMerged: true },
      { sessions: [session({ running: true })] },
      'keep'
    ],
    [
      'permission waiting',
      { cleanupMerged: true },
      { sessions: [session({ pending: true })] },
      'keep'
    ],
    ['open in a TUI', { cleanupMerged: true }, { sessions: [session({ open: true })] }, 'keep'],
    ['pinned', { cleanupMerged: true }, { sessions: [session({ pinned: true })] }, 'keep'],
    // Deleted sessions: only once no session is left in the worktree.
    [
      'sessions deleted',
      { cleanupDeleted: true },
      { sessions: [], deleted: true },
      'remove:deleted'
    ],
    [
      'one session deleted, one left',
      { cleanupDeleted: true },
      { deleted: true, merged: false },
      'keep'
    ],
    ['no session, never deleted', { cleanupDeleted: true }, { sessions: [] }, 'keep'],
    // Done: counted from the latest Done time; 0 days removes at once.
    ['Done 4 days, rule 3', { cleanupDoneDays: 3 }, {}, 'remove:done'],
    ['Done 4 days, rule 7', { cleanupDoneDays: 7 }, {}, 'keep'],
    [
      'Done, no close time',
      { cleanupDoneDays: 0 },
      { sessions: [session({ doneAt: undefined })] },
      'keep'
    ],
    [
      'only archived, never Done',
      { cleanupDoneDays: 0 },
      { sessions: [session({ done: false, archived: true })] },
      'keep'
    ],
    // Inactive: every session idle long enough, Done or not.
    [
      'inactive 10 days, rule 7',
      { cleanupInactiveDays: 7 },
      { sessions: [session({ done: false })] },
      'remove:inactive'
    ],
    [
      'one session touched today',
      { cleanupInactiveDays: 7 },
      { sessions: [session(), session({ id: 'ses_2', updated: NOW })] },
      'keep'
    ],
    // Unchanged: no commits beyond the default branch.
    ['unchanged', { cleanupUnchanged: true }, {}, 'remove:unchanged'],
    ['one commit ahead', { cleanupUnchanged: true }, { ahead: 1 }, 'keep'],
    ['ahead unknown', { cleanupUnchanged: true }, { ahead: undefined }, 'keep']
  ];
  for (const [name, settings, facts, expected] of cases) {
    const decision = decideWorktree(worktree(facts), { ...OFF, ...settings }, NOW);
    const actual =
      decision.action === 'remove'
        ? `remove:${decision.rule}`
        : expected.startsWith('keep:')
          ? `keep:${decision.reason}`
          : 'keep';
    assert.equal(actual, expected, `${name}: ${decision.reason}`);
  }
});

test('a squash-merged branch counts as merged only while HEAD has nothing beyond the PR head', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'super-sessions-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  /** Runs git with identity, hooks and signing pinned, and returns its trimmed output. */
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=',
        '-C',
        directory,
        ...args
      ],
      { encoding: 'utf8' }
    ).trim();
  /** Makes an empty commit and returns its id. */
  const commit = (message: string) => {
    git('commit', '-q', '--allow-empty', '--no-verify', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  commit('init');
  const first = commit('first PR commit');
  const head = commit('second PR commit');
  const absent = 'f'.repeat(40);

  // HEAD is the merged head.
  assert.equal(await readPullHead(directory, [head]), 'included');
  // The checkout never pulled the last PR commit: still nothing the PR lacks.
  git('checkout', '-q', '--detach', first);
  assert.equal(await readPullHead(directory, [absent, head]), 'included');
  // A commit made after the PR was merged would be lost with the worktree.
  git('checkout', '-q', head);
  commit('local follow-up');
  assert.equal(await readPullHead(directory, [head]), 'extra');
  assert.equal(await readPullHead(directory, [absent]), 'missing');
  assert.equal(await readPullHead(directory, []), 'missing');
});

test('the keep mode decides which local changes, read from git status, keep a worktree', () => {
  // Real `git status --porcelain=v1` lines; `!!` (ignored) only appears with --ignored.
  const outputs = {
    clean: '',
    ignored: '!! .env\n',
    untracked: '?? notes.md\n',
    staged: 'A  src/new.ts\n',
    edited: ' M src/app.ts\n',
    deleted: ' D src/old.ts\n',
    renamed: 'R  a.ts -> b.ts\n',
    conflict: 'UU src/app.ts\n'
  };
  const kept: Record<CleanupSettings['keepLocalChanges'], Array<keyof typeof outputs>> = {
    any: ['untracked', 'staged', 'edited', 'deleted', 'renamed', 'conflict'],
    uncommitted: ['staged', 'edited', 'deleted', 'renamed', 'conflict'],
    tracked: ['edited', 'deleted', 'renamed', 'conflict']
  };
  for (const [mode, keeps] of Object.entries(kept) as Array<
    [CleanupSettings['keepLocalChanges'], Array<keyof typeof outputs>]
  >) {
    for (const [name, output] of Object.entries(outputs) as Array<[keyof typeof outputs, string]>) {
      const decision = decideWorktree(
        worktree({ status: parseStatus(output) }),
        { ...OFF, cleanupMerged: true, keepLocalChanges: mode },
        NOW
      );
      assert.equal(
        decision.action,
        keeps.includes(name) ? 'keep' : 'remove',
        `${mode} with ${name}`
      );
    }
  }
});

test('auto-archive takes only Done sessions old enough that nothing holds', () => {
  const facts = (patch: Partial<ArchiveFacts> = {}): ArchiveFacts => ({
    sessionID: 'ses_1',
    title: 'Fix login',
    archived: false,
    running: false,
    pending: false,
    pinned: false,
    excluded: false,
    done: true,
    doneAt: NOW - 2 * DAY,
    ...patch
  });
  const cases: Array<[string, Partial<ArchiveFacts>, number | null, boolean]> = [
    ['off', {}, null, false],
    ['immediately', {}, 0, true],
    ['Done 2 days, rule 1', {}, 1, true],
    ['Done 2 days, rule 3', {}, 3, false],
    ['no close time, rule 1', { doneAt: undefined }, 1, false],
    ['no close time, immediately', { doneAt: undefined }, 0, true],
    ['not Done', { done: false }, 0, false],
    ['pinned', { pinned: true }, 0, false],
    ['running', { running: true }, 0, false],
    ['waiting on a permission', { pending: true }, 0, false],
    ['undone by the user before', { excluded: true }, 0, false],
    ['already archived', { archived: true }, 0, false]
  ];
  for (const [name, patch, days, due] of cases) {
    assert.equal(isArchiveDue(facts(patch), days, NOW), due, name);
  }
});
