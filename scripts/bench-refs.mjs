// Times the server half's `refs`, `refresh` and `done.facts` RPCs and how long they block the
// daemon's event loop, on an in-process OpenCode host with a few hundred sessions and the fake gh
// of the tests. Everything lives under a throwaway home, so nothing reads or writes the user's own
// OpenCode config, data or credentials. Not part of `pnpm check`: it takes about half a minute.
//
// Usage: node scripts/bench-refs.mjs [--plugin <package directory>] [--sessions <count>]
// `--plugin` defaults to this checkout; build it first. Pass another checkout to compare.
// Add `--cpu-prof` before the script name for a CPU profile of the whole run.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    plugin: { type: 'string', default: fileURLToPath(new URL('../', import.meta.url)) },
    sessions: { type: 'string', default: '300' }
  }
});
const plugin = path.resolve(values.plugin);
const total = Number(values.sessions);

const root = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'super-sessions-bench-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
// The host reads these before the SDK loads.
for (const key of Object.keys(process.env)) {
  if (!['PATH', 'SHELL'].includes(key)) delete process.env[key];
}
Object.assign(process.env, {
  HOME: root,
  TMPDIR: root,
  XDG_CONFIG_HOME: path.join(root, 'config'),
  XDG_DATA_HOME: path.join(root, 'data'),
  XDG_STATE_HOME: path.join(root, 'state'),
  XDG_CACHE_HOME: path.join(root, 'cache')
});

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
      'user.name=Bench',
      '-c',
      'user.email=bench@example.com',
      '-C',
      cwd,
      ...args
    ],
    { stdio: 'pipe' }
  );
}

// The plugin runs gh without a shell, so a shim script stands in for it.
const fakeGh = fileURLToPath(new URL('../test/fixtures/fake-gh.mjs', import.meta.url));
const gh = path.join(root, 'gh');
writeFileSync(
  gh,
  `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeGh)} "$@"\n`,
  {
    mode: 0o755
  }
);

// Clones of acme/widgets on pushed branches, so branch lookups run, and removed worktrees.
const checkouts = [];
for (const name of ['fix-titles', 'group-search', 'feature-a', 'feature-b']) {
  const repo = path.join(root, 'src', name);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git(repo, 'checkout', '-q', '-b', name);
  git(repo, 'update-ref', `refs/remotes/origin/${name}`, 'HEAD');
  git(repo, 'branch', '-q', `--set-upstream-to=origin/${name}`);
  checkouts.push(repo);
}
const removed = Array.from({ length: 20 }, (_, index) =>
  path.join(root, 'src', 'removed', `worktree-${index}`)
);
for (const directory of removed) mkdirSync(directory, { recursive: true });

const config = path.join(root, 'opencode-config');
mkdirSync(config, { recursive: true });
const { OpenCode } = await import('@opencode/sdk');
const { pluginRpc } = await import(path.join(plugin, 'dist/host/rpc.js'));
const host = await OpenCode.create({
  database: { path: ':memory:' },
  config: {
    directory: config,
    project: false,
    content: JSON.stringify({
      plugins: [{ package: plugin, options: { ghPath: gh, search: { body: false } } }]
    })
  },
  models: { fetch: false },
  fs: { filewatcher: false, fff: false }
});

const ref = (kind, number) => ({
  provider: 'github',
  host: 'github.com',
  repo: 'acme/widgets',
  kind,
  number
});
const known = [ref('issue', 12), ref('issue', 56), ref('pr', 78), ref('pr', 90), ref('pr', 34)];
const ids = [];
for (let index = 0; index < total; index++) {
  const directory = index < removed.length ? removed[index] : checkouts[index % checkouts.length];
  const links = [known[index % known.length], known[(index + 2) % known.length]].map((item) => ({
    ref: item,
    source: 'agent',
    linkedAt: 1
  }));
  const session = await host.sessions.create({
    location: { directory },
    metadata: { 'super-sessions': { v: 1, links, dismissed: [] } }
  });
  ids.push(session.id);
}
for (const directory of removed) rmSync(directory, { recursive: true, force: true });

const location = { directory: checkouts[0] };
const rpc = pluginRpc(host);
await rpc.status({}, { location });

// Writes the RPCs cause, which move the sessions' `time.updated`.
let writes = 0;
const abort = new AbortController();
void (async () => {
  for await (const event of host.event.subscribe({
    types: ['session.metadata.updated'],
    signal: abort.signal
  })) {
    if (event.type === 'session.metadata.updated') writes++;
  }
})().catch(() => {});

/** The longest stretch the event loop was blocked while `run` ran, with its duration. */
async function measure(name, run) {
  const delay = monitorEventLoopDelay({ resolution: 5 });
  let longest = 0;
  let last = performance.now();
  const probe = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last - 5);
    last = now;
  }, 5);
  delay.enable();
  const before = writes;
  const start = performance.now();
  await run();
  const took = performance.now() - start;
  delay.disable();
  clearInterval(probe);
  console.log(
    `${name.padEnd(36)} ${took.toFixed(0).padStart(6)} ms  loop blocked up to ${longest.toFixed(0).padStart(4)} ms  writes ${writes - before}`
  );
}

/** `refs` for every session, in the browser's batches of 200. */
const refs = () =>
  Promise.all(
    Array.from({ length: Math.ceil(ids.length / 200) }, (_, batch) =>
      rpc.refs({ sessionIDs: ids.slice(batch * 200, batch * 200 + 200) }, { location })
    )
  );

console.log(`${total} sessions, plugin ${plugin}`);
await measure('refs, cold', refs);
// The background refresh `refs` started runs now; the reads below land on it.
await measure('background refresh (3 s window)', () => sleep(3000));
await measure('refs, warm', refs);
await measure('refresh, 30 sessions', () =>
  rpc.refresh({ sessionIDs: ids.slice(20, 50) }, { location })
);
await sleep(11_000);
await measure('refs, branch cache expired', refs);
await measure('background refresh (3 s window)', () => sleep(3000));
try {
  await measure('done.facts, 40 sessions', () =>
    rpc['done.facts']({ sessionIDs: ids.slice(20, 60) }, { location })
  );
  await measure('done.facts again', () =>
    rpc['done.facts']({ sessionIDs: ids.slice(20, 60) }, { location })
  );
} catch {
  console.log('done.facts: not in this build');
}
abort.abort();
await host.close?.();
process.exit(0);
