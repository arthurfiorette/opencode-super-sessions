import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mock } from 'node:test';
import { fileURLToPath } from 'node:url';

// Worktree cleanup against a real host and real git: one worktree is merged into the default
// branch and clean, one has the same merged pull request but an uncommitted edit. Only the first
// may go.

const directory = process.env.OPENCODE_TEST_ROOT;
assert.ok(directory, 'This fixture must run through the isolated integration test.');
const fakeGh = fileURLToPath(new URL('./fake-gh.mjs', import.meta.url));

// Swap only the gh executable at the spawn boundary; git runs for real.
const processModule = await import('node:child_process');
const { default: defaultExport, ...namedExports } = processModule;
/** `child_process.spawn` that runs fake-gh.mjs for `gh-fixture` and the real command otherwise. */
function spawn(command, args, options) {
  if (command !== 'gh-fixture') return processModule.spawn(command, args, options);
  return processModule.spawn(process.execPath, [fakeGh, ...args], options);
}
mock.module('node:child_process', {
  exports: { ...namedExports, spawn, default: { ...defaultExport, spawn } }
});

const { OpenCode } = await import('@opencode/sdk');
const { SuperSessions } = await import('opencode-super-sessions/rpc');

/** Runs git without the developer's hooks or signing. */
function git(cwd, ...args) {
  return execFileSync(
    'git',
    [
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=',
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-C',
      cwd,
      ...args
    ],
    { stdio: 'pipe', encoding: 'utf8' }
  ).trim();
}

const repo = path.join(directory, 'widgets');
await mkdir(repo);
git(repo, 'init', '-q', '-b', 'main');
await writeFile(path.join(repo, 'README.md'), 'widgets\n');
git(repo, 'add', 'README.md');
git(repo, 'commit', '-q', '--no-verify', '-m', 'init');
git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');

const config = path.join(directory, 'config');
await mkdir(config);
const host = await OpenCode.create({
  database: { path: ':memory:' },
  config: {
    directory: config,
    project: false,
    content: JSON.stringify({
      plugins: [
        {
          package: fileURLToPath(new URL('../../', import.meta.url)),
          options: { ghPath: 'gh-fixture' }
        }
      ]
    })
  },
  models: { fetch: false },
  fs: { filewatcher: false, fff: false }
});

try {
  const location = { directory: repo };
  const rpc = host.rpc(SuperSessions);
  const main = await host.sessions.create({ location });
  const projectID = main.projectID;

  const merged = (await host.worktree.create({ projectID, name: 'merged' })).directory;
  const dirty = (await host.worktree.create({ projectID, name: 'dirty' })).directory;
  const sessions = [];
  for (const worktree of [merged, dirty]) {
    const session = await host.sessions.create({ location: { directory: worktree } });
    await rpc.link({ sessionID: session.id, reference: '#78' }, { location });
    sessions.push(session.id);
  }
  // The merged worktree's commit lands on the default branch, as a merge on GitHub would.
  await writeFile(path.join(merged, 'list.ts'), 'export const fast = true;\n');
  git(merged, 'add', 'list.ts');
  git(merged, 'commit', '-q', '--no-verify', '-m', 'Speed up the widget list');
  git(repo, 'update-ref', 'refs/remotes/origin/main', git(merged, 'rev-parse', 'HEAD'));
  // The dirty one is behind the default branch, so only its uncommitted edit keeps it.
  await writeFile(path.join(dirty, 'README.md'), 'widgets, edited and not committed\n');

  const off = await rpc['cleanup.plan']({}, { location });
  assert.deepEqual(off.worktrees, [], 'Nothing is planned while every rule is off.');

  const settings = await rpc['settings.set']({ values: { cleanupMerged: true } }, { location });
  assert.equal(settings.values.cleanupMerged, true);
  assert.equal(settings.defaults.cleanupMerged, false);

  const plan = await rpc['cleanup.plan']({}, { location });
  assert.equal(plan.confirmed, false);
  /** The dry run's decision for `worktree`. */
  const decision = (worktree) => plan.worktrees.find((entry) => entry.directory === worktree);
  assert.equal(decision(merged)?.action, 'remove', JSON.stringify(plan.worktrees));
  assert.equal(decision(merged)?.rule, 'merged');
  assert.equal(decision(dirty)?.action, 'keep', JSON.stringify(plan.worktrees));
  assert.equal(decision(dirty)?.reason, 'has local changes');
  assert.ok(existsSync(merged), 'The dry run removes nothing.');

  // A sweep that finds a removal before the user ever confirmed asks instead of removing. A
  // deleted session starts one.
  const asked = new Promise((resolve) => {
    const off = rpc.events.on('cleanup.confirm', (event) => {
      off();
      resolve(event.data.worktrees);
    });
  });
  const throwaway = await host.sessions.create({ location });
  await host.sessions.remove({ sessionID: throwaway.id });
  assert.deepEqual(
    (await asked).map((entry) => entry.directory),
    [merged]
  );
  assert.ok(existsSync(merged), 'A sweep removes nothing before the first confirmation.');

  // Asked for both: the server checks again and removes only the one that qualifies.
  const result = await rpc['cleanup.run']({ directories: [merged, dirty] }, { location });
  assert.deepEqual(result.removed, [merged]);
  assert.deepEqual(
    result.kept.map((entry) => entry.directory),
    [dirty]
  );
  assert.equal(existsSync(merged), false);
  assert.equal(
    await readFile(path.join(dirty, 'README.md'), 'utf8'),
    'widgets, edited and not committed\n'
  );
  const listed = (await host.worktree.list({ projectID })).map((entry) => entry.directory);
  assert.ok(!listed.includes(merged) && listed.includes(dirty), JSON.stringify(listed));
  // The session history survives its worktree.
  assert.equal((await host.sessions.get({ sessionID: sessions[0] })).id, sessions[0]);
  assert.equal((await rpc['cleanup.plan']({}, { location })).confirmed, true);

  console.log('Cleanup integration passed');
} finally {
  await host.close();
  mock.restoreAll();
}
