import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { mock } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const directory = process.env.OPENCODE_TEST_ROOT;
assert.ok(directory, 'This fixture must run through the isolated integration test.');
const fakeGh = fileURLToPath(new URL('./fake-gh.mjs', import.meta.url));

// Swap only the gh executable at the spawn boundary; git and everything else run for real. A
// failed mock leaves `gh-fixture`, which is on no PATH, so GitHub is never reached either way.
const processModule = await import('node:child_process');
const { default: defaultExport, ...namedExports } = processModule;
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
  execFileSync(
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
    { stdio: 'pipe' }
  );
}

/** Polls `read` until `accepts` holds, failing after 15 seconds. */
async function until(read, accepts) {
  const deadline = Date.now() + 15_000;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (accepts(last)) return last;
    await sleep(25);
  }
  throw new Error(`Condition not reached: ${JSON.stringify(last)}`);
}

// A clone of acme/widgets on a pushed feature branch, so the branch lookup runs.
const repo = path.join(directory, 'widgets');
await mkdir(repo);
git(repo, 'init', '-q', '-b', 'main');
git(repo, 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'init');
git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
git(repo, 'checkout', '-q', '-b', 'fix-titles');
git(repo, 'update-ref', 'refs/remotes/origin/fix-titles', 'HEAD');
git(repo, 'branch', '-q', '--set-upstream-to=origin/fix-titles');

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
  const other = { directory: path.join(directory, 'other') };
  await mkdir(other.directory);
  const session = await host.sessions.create({
    location,
    metadata: { 'another-plugin': { keep: true } }
  });
  await host.sessions.create({ location: other });
  const sessionID = session.id;
  const rpc = host.rpc(SuperSessions);
  const stored = async () => (await host.sessions.get({ sessionID })).metadata ?? {};

  assert.deepEqual(await rpc.status({}, { location }), { providers: { github: 'ok' } });

  const linked = await rpc.link({ sessionID, reference: '#12' }, { location });
  assert.equal(linked.source, 'manual');
  assert.deepEqual(linked.ref, {
    provider: 'github',
    host: 'github.com',
    repo: 'acme/widgets',
    kind: 'issue',
    number: 12
  });
  const afterLink = await stored();
  assert.deepEqual(afterLink['another-plugin'], { keep: true });
  assert.deepEqual(
    afterLink['super-sessions'].links.map((link) => [link.ref.number, link.source]),
    [[12, 'manual']]
  );

  await assert.rejects(
    rpc.link({ sessionID, reference: '#999' }, { location }),
    (error) => error.type === 'not_found'
  );
  await assert.rejects(
    rpc.link({ sessionID, reference: 'not a ref' }, { location }),
    (error) => error.type === 'invalid_reference'
  );

  const key = 'github:github.com/acme/widgets/issue/12';
  await rpc.unlink({ sessionID, key }, { location });
  const afterUnlink = (await stored())['super-sessions'];
  assert.deepEqual(afterUnlink.links, []);
  assert.deepEqual(afterUnlink.dismissed, [key]);
  await rpc.link(
    { sessionID, reference: 'https://github.com/acme/widgets/issues/12' },
    { location }
  );
  const relinked = (await stored())['super-sessions'];
  assert.deepEqual(relinked.dismissed, []);
  assert.deepEqual(
    relinked.links.map((link) => link.ref.number),
    [12]
  );

  // Asked from another Location: the session's own directory decides its repository and branch.
  const views = await rpc.refresh(
    { sessionIDs: [sessionID, 'ses_missing'], force: true },
    { location: other }
  );
  assert.deepEqual(Object.keys(views), [sessionID]);
  const view = views[sessionID];
  assert.equal(view.branch, 'fix-titles');
  assert.equal(view.defaultBranch, 'main');
  assert.deepEqual(
    view.branchRefs.map((ref) => [ref.kind, ref.number]),
    [['pr', 34]]
  );
  // PR 34 closes issue 56, which is recorded with the PR as its origin.
  const closes = view.links.find((link) => link.ref.number === 56);
  assert.equal(closes?.source, 'closes');
  assert.equal(closes?.via, 'github:github.com/acme/widgets/pr/34');
  assert.equal(
    view.states['github:github.com/acme/widgets/pr/34']?.title,
    'Show full session titles'
  );
  assert.equal(view.states[key]?.status, 'open');
  assert.equal(
    view.states['github:github.com/acme/widgets/issue/56']?.title,
    'Session list cuts titles off'
  );
  assert.deepEqual((await stored())['another-plugin'], { keep: true });

  const scope = { type: 'directory', directory: repo };
  for (const [query, match] of [
    ['12', 'ref-number'],
    ['pr 34', 'ref-number'],
    ['full session titles', 'ref-title']
  ]) {
    const hits = await rpc.search({ query, scope, archived: false }, { location });
    assert.deepEqual(
      hits.map((hit) => [hit.sessionID, hit.match]),
      [[sessionID, match]],
      query
    );
  }

  // Prompts are detected by the single process-wide subscriber; `resume: false` only admits the
  // prompt, so no model is needed.
  await host.sessions.prompt({
    sessionID,
    text: 'Also look at #7 and https://github.com/acme/widgets/issues/56 while you are at it.',
    resume: false
  });
  const prompted = await until(stored, (metadata) =>
    metadata['super-sessions'].links.some((link) => link.source === 'prompt')
  );
  // #7 does not exist and is dropped; #56 moves up from `closes` because the user named it.
  assert.deepEqual(
    prompted['super-sessions'].links.map((link) => [link.ref.number, link.source]),
    [
      [12, 'manual'],
      [56, 'prompt']
    ]
  );

  // The same subscriber indexes the prompt text; these words appear in no title or ref.
  const bodyHits = await until(
    () => rpc.search({ query: 'while you are', scope, archived: false }, { location }),
    (hits) => hits.length > 0
  );
  assert.deepEqual(
    bodyHits.map((hit) => [hit.sessionID, hit.match]),
    [[sessionID, 'body']]
  );
  // The index lives under the isolated data home, never the developer's.
  assert.ok(
    existsSync(
      path.join(
        process.env.XDG_DATA_HOME,
        'opencode',
        'plugins',
        'opencode-super-sessions',
        'search.db'
      )
    )
  );

  console.log('Configured OpenCode integration passed');
} finally {
  await host.close();
  mock.restoreAll();
}
