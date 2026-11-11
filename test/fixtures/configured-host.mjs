import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mock } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = process.env.OPENCODE_TEST_ROOT;
assert.ok(directory, 'This fixture must run through the isolated integration test.');
const fakeGh = fileURLToPath(new URL('./fake-gh.mjs', import.meta.url));

// Swap only the gh executable at the spawn boundary; git and everything else run for real. A
// failed mock leaves `gh-fixture`, which is on no PATH, so GitHub is never reached either way.
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

// User `!` commands run in a real shell, out of reach of the spawn mock, so `gh` there resolves
// through PATH to this shim. The Windows host picks PowerShell, which runs only names with a
// PATHEXT extension and would otherwise find the runner's real gh.
const bin = path.join(directory, 'bin');
await mkdir(bin);
await writeFile(
  path.join(bin, 'gh'),
  `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeGh)} "$@"\n`,
  { mode: 0o755 }
);
if (process.platform === 'win32') {
  await writeFile(path.join(bin, 'gh.cmd'), `@"${process.execPath}" "${fakeGh}" %*\r\n`);
}
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

const { OpenCode } = await import('@opencode/sdk');
const { pluginRpc, rpcError } = await import('../../dist/host/rpc.js');

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
// The session's `git push` lands in a local bare repository, never on GitHub.
const pushed = path.join(directory, 'widgets-pushed.git');
git(directory, 'init', '-q', '--bare', pushed);
git(
  repo,
  'config',
  `url.${pathToFileURL(pushed).href}.pushInsteadOf`,
  'https://github.com/acme/widgets.git'
);

// A clone of acme/widgets on its default branch, for a session written before the plugin ran.
const legacyRepo = path.join(directory, 'legacy');
await mkdir(legacyRepo);
git(legacyRepo, 'init', '-q', '-b', 'main');
git(legacyRepo, 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'init');
git(legacyRepo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
git(legacyRepo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
git(legacyRepo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
const legacy = { directory: legacyRepo };

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
  // The host answers calls on a Location whose plugins are still loading with `rpc.unavailable`;
  // the TUI's client waits for them, and so does this one.
  const rpc = pluginRpc(host);
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

  // Read through the accessor the browser uses to word its link errors.
  await assert.rejects(
    rpc.link({ sessionID, reference: '#999' }, { location }),
    (error) => rpcError(error).type === 'not_found'
  );
  await assert.rejects(
    rpc.link({ sessionID, reference: 'not a ref' }, { location }),
    (error) => rpcError(error).type === 'invalid_reference'
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

  // PR 34 on the session's branch was opened before the session, so it is another session's
  // work, and so is the issue it closes, until this session pushes the branch.
  const foreign = (await rpc.refresh({ sessionIDs: [sessionID], force: true }, { location }))[
    sessionID
  ];
  assert.deepEqual(foreign.branchRefs, []);
  assert.deepEqual(
    foreign.links.map((link) => link.ref.number),
    [12]
  );
  // A `!` command reaches the plugin as `session.shell.ended`; git's report names the branch.
  await host.sessions.shell({ sessionID, command: 'git push' });
  const afterPush = await until(
    stored,
    (metadata) => metadata['super-sessions'].pushed !== undefined
  );
  assert.deepEqual(afterPush['super-sessions'].pushed, ['fix-titles']);
  assert.deepEqual(afterPush['another-plugin'], { keep: true });

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
  // The prompt carried a notice of what the user and the pull request linked before it; the
  // pull request itself came from the branch, and the agent knows its own branch. Nothing runs the
  // prompt here, so the notice waits in the inbox beside it, as does the host's own notice of the
  // `!` command above.
  const notices = async () =>
    (await host.sessions.inbox.list({ sessionID })).filter(
      (item) => item.type === 'synthetic' && item.payload.metadata?.source === 'super-sessions'
    );
  const [notice] = await notices();
  assert.deepEqual(
    notice.payload.description
      .replace(/^Linked /u, '')
      .split(', ')
      .sort(),
    ['issue acme/widgets#12', 'issue acme/widgets#56']
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
  // A `!` command reaches the plugin only as `session.shell.ended`, never through the tool hook.
  await host.sessions.shell({ sessionID, command: 'gh pr create --fill' });
  const shelled = await until(stored, (metadata) =>
    metadata['super-sessions'].links.some((link) => link.source === 'created')
  );
  assert.deepEqual(
    shelled['super-sessions'].links.map((link) => [link.ref.number, link.source]),
    [
      [12, 'manual'],
      [56, 'prompt'],
      [34, 'created']
    ]
  );
  // Nothing new came from the user since: the agent created PR 34, and #56 was already told.
  await host.sessions.prompt({ sessionID, text: 'Thanks.', resume: false });
  assert.equal((await notices()).length, 1);

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

  // The history scan reads the session the plugin never saw through the TUI's own reader, and
  // links what live detection would have: the bare #56 after the forge confirms it, and the PR
  // `gh pr create` printed.
  // An import publishes only `session.created`, so detection never sees these messages.
  const legacyID = await importLegacySession();
  const { historySource, scanSession } = await import('../../dist/history-scan.js');
  const source = historySource(host, () => legacy);
  const legacyMetadata = async () =>
    (await host.sessions.get({ sessionID: legacyID })).metadata ?? {};
  assert.equal((await legacyMetadata())['super-sessions'], undefined);
  const noPause = async () => {};
  assert.equal(await scanSession(source, legacyID, { pause: noPause }), 'scanned');
  const scanned = (await legacyMetadata())['super-sessions'];
  assert.deepEqual(
    scanned.links.map((link) => [link.ref.kind, link.ref.number, link.source]).sort(),
    [
      ['issue', 56, 'prompt'],
      ['pr', 34, 'created']
    ]
  );
  const newest = (await host.message.list({ sessionID: legacyID, order: 'desc', limit: 1 }))
    .data[0];
  assert.equal(scanned.scanned.lastMessageID, newest.id);
  // The push is read from git's report, which names the branch the checkout no longer has.
  assert.deepEqual(scanned.pushed, ['fix-legacy']);
  assert.deepEqual(
    scanned.urls.map((link) => [link.url, link.source]),
    [['https://linear.app/acme/issue/ENG-56', 'prompt']]
  );
  assert.equal(scanned.scanned.pushes, true);

  // The marker makes the second scan stop at its first call and write nothing.
  const once = await host.sessions.get({ sessionID: legacyID });
  assert.equal(await scanSession(source, legacyID, { pause: noPause }), 'skipped');
  const twice = await host.sessions.get({ sessionID: legacyID });
  assert.deepEqual(twice.metadata, once.metadata);
  assert.equal(twice.time.updated, once.time.updated);

  // A session a version without push detection or work links scanned gets one pass that records
  // its pushes and tracker links and leaves its forge links alone: the bare #56 is not looked up
  // again.
  const oldMarker = { scannedAt: 1, lastMessageID: 'msg_old' };
  const earlierID = await importLegacySession(
    { 'super-sessions': { v: 1, links: [], dismissed: [], scanned: oldMarker } },
    2
  );
  const unscanned = await host.sessions.get({ sessionID: earlierID });
  assert.equal(await scanSession(source, earlierID, { pause: noPause }), 'scanned');
  const rescanned = (await host.sessions.get({ sessionID: earlierID })).metadata['super-sessions'];
  assert.deepEqual(rescanned, {
    v: 1,
    links: [],
    urls: [
      {
        url: 'https://linear.app/acme/issue/ENG-56',
        source: 'prompt',
        // The prompt's time, which the import encodes in the session id.
        linkedAt: Number(earlierID.slice('ses_legacy'.length))
      }
    ],
    dismissed: [],
    scanned: { ...oldMarker, pushes: true, links: true },
    pushed: ['fix-legacy'],
    // The imported session has no run times, so the write keeps the activity time it moves.
    activeAt: unscanned.time.updated
  });
  assert.equal(await scanSession(source, earlierID, { pause: noPause }), 'skipped');

  console.log('Configured OpenCode integration passed');
} finally {
  await host.close();
  mock.restoreAll();
}

/**
 * Imports a finished session from before the plugin: a prompt naming issue #56 by its bare
 * number, then an agent turn that pushed `fix-legacy` over SSH, whose report holds no URL, and
 * ran `gh pr create`, which printed the new PR's URL. `metadata` is stored with it, and `ago`
 * says how many days before now it ran.
 */
async function importLegacySession(metadata, ago = 1) {
  const { project } = await host.location.get({ location: legacy });
  const at = Date.now() - ago * 86_400_000;
  const id = `ses_legacy${at}`;
  await host.experimental.session.import({
    location: legacy,
    info: {
      id,
      projectID: project.id,
      title: 'Fix the session list',
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: at, updated: at + 3000 },
      location: legacy,
      ...(metadata === undefined ? {} : { metadata })
    },
    messages: [
      {
        id: `msg_legacy${at}a`,
        type: 'user',
        text: 'Please fix #56, the list cuts titles off. https://linear.app/acme/issue/ENG-56',
        time: { created: at }
      },
      {
        id: `msg_legacy${at}b`,
        type: 'assistant',
        agent: 'build',
        model: { id: 'model', providerID: 'provider' },
        content: [
          {
            type: 'tool',
            id: 'call_0',
            name: 'shell',
            state: {
              status: 'completed',
              input: { command: 'git push -u origin HEAD' },
              content: [
                {
                  type: 'text',
                  text: "To github.com:acme/widgets.git\n * [new branch]      fix-legacy -> fix-legacy\nbranch 'fix-legacy' set up to track 'origin/fix-legacy'.\n"
                }
              ]
            },
            time: { created: at + 500, completed: at + 900 }
          },
          {
            type: 'tool',
            id: 'call_1',
            name: 'shell',
            state: {
              status: 'completed',
              input: { command: 'gh pr create --fill' },
              content: [
                {
                  type: 'text',
                  text: 'Creating pull request for fix-titles into main in acme/widgets\n\nhttps://github.com/acme/widgets/pull/34\n'
                }
              ]
            },
            time: { created: at + 1000, completed: at + 2000 }
          },
          { type: 'text', text: 'Opened the pull request.' }
        ],
        finish: 'stop',
        time: { created: at + 1000, completed: at + 3000 }
      }
    ]
  });
  return id;
}
