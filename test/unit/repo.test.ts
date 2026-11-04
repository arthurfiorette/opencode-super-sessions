import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ForgeDefinition } from '../../src/providers/provider.js';
import { createRepoResolver, type RepoInfo } from '../../src/repo.js';

// Stand-in for the real GitHub definition: recognizes github.com HTTPS and scp-style remotes only.
const github = {
  id: 'github',
  recognizeRemote(url: string) {
    const match = /^(?:https:\/\/|git@)github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
    return match?.[1] ? { provider: 'github', host: 'github.com', repo: match[1] } : undefined;
  }
} as ForgeDefinition;

/** Runs git in `directory` with hooks and signing off, so the user's global config cannot interfere. */
function git(directory: string, ...args: string[]) {
  execFileSync(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', '-C', directory, ...args],
    { stdio: 'pipe' }
  );
}

/** Creates a repository on `main` with one commit, then applies `setup`. */
async function repository(setup: (directory: string) => void): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'super-sessions-repo-'));
  git(directory, 'init', '-q', '-b', 'main');
  git(
    directory,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-q',
    '--allow-empty',
    '--no-verify',
    '-m',
    'init'
  );
  setup(directory);
  return directory;
}

test('resolve picks the forge remote and reads default branch, branch and upstream', async (t) => {
  const cases: Array<[string, (directory: string) => void, RepoInfo]> = [
    [
      'fork checkout: upstream wins over origin, local and foreign remotes are skipped',
      (directory) => {
        git(directory, 'remote', 'add', 'aaa', join(tmpdir(), 'elsewhere'));
        git(directory, 'remote', 'add', 'gitlab', 'https://gitlab.com/acme/app.git');
        git(directory, 'remote', 'add', 'origin', 'git@github.com:me/app.git');
        git(directory, 'remote', 'add', 'upstream', 'https://github.com/acme/app.git');
        git(directory, 'update-ref', 'refs/remotes/upstream/trunk', 'HEAD');
        git(directory, 'symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/trunk');
        git(directory, 'checkout', '-q', '-b', 'fix/login');
        git(directory, 'update-ref', 'refs/remotes/origin/fix/login', 'HEAD');
        git(directory, 'branch', '-q', '--set-upstream-to=origin/fix/login');
      },
      {
        repo: { provider: 'github', host: 'github.com', repo: 'acme/app' },
        remote: 'upstream',
        defaultBranch: 'trunk',
        branch: 'fix/login',
        upstream: true
      }
    ],
    [
      'no upstream or origin: first forge remote by name; unpublished branch',
      (directory) => {
        git(directory, 'remote', 'add', 'alpha', join(tmpdir(), 'local-mirror'));
        git(directory, 'remote', 'add', 'zeta', 'https://github.com/zeta/app.git');
        git(directory, 'remote', 'add', 'beta', 'git@github.com:beta/app.git');
        git(directory, 'checkout', '-q', '-b', 'wip');
      },
      {
        repo: { provider: 'github', host: 'github.com', repo: 'beta/app' },
        remote: 'beta',
        branch: 'wip',
        upstream: false
      }
    ],
    [
      'detached HEAD has no branch',
      (directory) => {
        git(directory, 'remote', 'add', 'origin', 'https://github.com/acme/app');
        git(directory, 'checkout', '-q', '--detach');
      },
      { repo: { provider: 'github', host: 'github.com', repo: 'acme/app' }, remote: 'origin' }
    ]
  ];

  const resolver = createRepoResolver({ definitions: [github] });
  for (const [name, setup, expected] of cases) {
    const directory = await repository(setup);
    t.after(() => rm(directory, { recursive: true, force: true }));
    assert.deepEqual(await resolver.resolve(directory), expected, name);
  }
});
