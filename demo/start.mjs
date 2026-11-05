// Starts a real OpenCode TUI on fake data for screenshots of the plugin: an isolated HOME and
// XDG directories under demo/.state, fake git repositories, sessions imported through
// `opencode session import`, a fake gh and glab, and a scripted model that keeps one session
// running. Nothing reads or writes the user's own OpenCode config, data or credentials.
//
// Usage: node demo/start.mjs [--keep] [--no-running] [opencode arguments...]
// OPENCODE_BIN names the opencode binary; it defaults to `opencode` on PATH.

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { demoSessions, MODEL, RUNNING } from './sessions.mjs';

const demo = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(demo);
const state = path.join(demo, '.state');
const home = path.join(state, 'home');
// Under the fake home, so the TUI shows them as `~/src/...` instead of the checkout's path.
const repos = path.join(home, 'src');
const bin = path.join(state, 'bin');
const config = path.join(home, '.config', 'opencode');
const database = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
const seedFile = path.join(state, 'seed.json');
const opencode = process.env.OPENCODE_BIN || 'opencode';
const windows = process.platform === 'win32';

const own = new Set(['--keep', '--no-running']);
const flags = new Set(process.argv.slice(2).filter((arg) => own.has(arg)));
const passthrough = process.argv.slice(2).filter((arg) => !own.has(arg));

/** GitHub and GitLab repositories, by directory name under `.state/home/src`. */
const REPOSITORIES = {
  storefront: {
    remote: 'https://github.com/acme/storefront.git',
    files: {
      'README.md': '# Storefront\n\nThe acme web shop: catalog, cart and checkout.\n',
      'package.json':
        '{\n  "name": "@acme/storefront",\n  "private": true,\n  "type": "module"\n}\n',
      'src/search/suggest.ts':
        "import { catalog } from '../catalog/client';\n\nexport async function suggest(query: string) {\n  const products = await catalog.search({ query, limit: 50 });\n  return products.map((product) => product.title).slice(0, 8);\n}\n",
      'src/cart/totals.ts':
        'export function cartTotal(items: CartItem[]) {\n  const sum = items.reduce((total, item) => total + item.price * item.quantity, 0);\n  return Math.round(sum * 100) / 100;\n}\n',
      'src/checkout/SummaryStep.tsx':
        'import { useCart, useShipping, useTotals } from \'../cart\';\n\nexport function SummaryStep() {\n  const cart = useCart();\n  return <section className="summary">{cart.items.length} items</section>;\n}\n'
    },
    // Worktrees on pushed branches whose pull requests the branch lookup finds.
    worktrees: ['checkout-redesign', 'gift-cards']
  },
  api: {
    remote: 'https://github.com/acme/api.git',
    files: {
      'README.md': '# API\n\nThe acme public REST API.\n',
      'src/middleware/rateLimit.ts':
        'export async function rateLimit(request, response, next) {\n  const result = await limiter.consume(request.key);\n  return next();\n}\n'
    },
    worktrees: ['rate-limit-headers']
  },
  docs: {
    remote: 'https://github.com/acme/docs.git',
    files: { 'README.md': '# Docs\n\nSource of docs.acme.example.\n' },
    worktrees: []
  },
  mobile: {
    remote: 'https://gitlab.com/acme/mobile.git',
    files: { 'README.md': '# Mobile\n\nThe acme shopping app for iOS and Android.\n' },
    worktrees: []
  }
};

/** The directory of a session `place`: `repo` or `repo/worktree`. */
function directory(place) {
  const [repo, worktree] = place.split('/');
  return worktree ? path.join(repos, repo, '.worktrees', worktree) : path.join(repos, repo);
}

/**
 * The environment every child gets: only what a terminal app needs, so API keys, OPENCODE_*
 * overrides and the user's gh or git settings never reach the demo, and every OpenCode path
 * points into `.state`.
 */
function environment() {
  const keep =
    /^(PATH|TERM|TERM_PROGRAM|TERM_PROGRAM_VERSION|COLORTERM|LANG|LC_\w+|TZ|SHELL|USER|LOGNAME|TMUX|TMUX_PANE|SYSTEMROOT|WINDIR|PATHEXT|COMSPEC|KITTY_\w+|WEZTERM_\w+|GHOSTTY_\w+|ITERM_\w+|VTE_VERSION|WT_\w+|ALACRITTY_\w+|KONSOLE_\w+)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => keep.test(key)));
  return {
    ...env,
    PATH: `${bin}${path.delimiter}${env.PATH ?? ''}`,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    TMPDIR: path.join(state, 'tmp'),
    TEMP: path.join(state, 'tmp'),
    TMP: path.join(state, 'tmp'),
    OPENCODE_DB: database,
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_FREE_MODELS: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    GIT_CONFIG_NOSYSTEM: '1'
  };
}

/** Runs git in `cwd` with a fixed identity and dates, so commits hash the same on every seed. */
function git(cwd, ...args) {
  execFileSync(
    'git',
    [
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=',
      '-c',
      'user.name=Acme Dev',
      '-c',
      'user.email=dev@acme.example',
      '-C',
      cwd,
      ...args
    ],
    {
      stdio: 'pipe',
      env: {
        ...environment(),
        GIT_AUTHOR_DATE: '2026-10-01T09:00:00Z',
        GIT_COMMITTER_DATE: '2026-10-01T09:00:00Z'
      }
    }
  );
}

/** Writes `content` to `file`, creating its directory. */
function write(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/**
 * Creates each repository on `main` with `origin/main` as its default branch, and its
 * worktrees on branches pushed to `origin`, so the plugin's branch lookup finds their PRs.
 */
function createRepositories() {
  for (const [name, repository] of Object.entries(REPOSITORIES)) {
    const repo = path.join(repos, name);
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    write(path.join(repo, '.gitignore'), 'node_modules\n.worktrees\n');
    for (const [file, content] of Object.entries(repository.files)) {
      write(path.join(repo, file), content);
    }
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'Initial commit');
    git(repo, 'remote', 'add', 'origin', repository.remote);
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    for (const branch of repository.worktrees) {
      const worktree = directory(`${name}/${branch}`);
      git(repo, 'worktree', 'add', '-q', '-b', branch, worktree);
      git(worktree, 'commit', '-q', '--allow-empty', '-m', `Start ${branch}`);
      git(worktree, 'update-ref', `refs/remotes/origin/${branch}`, 'HEAD');
      git(worktree, 'branch', '-q', `--set-upstream-to=origin/${branch}`);
    }
  }
}

/**
 * Writes the gh and glab shims. The plugin runs them with an allowlisted environment, so the
 * shim carries the seed time and the state directory itself.
 */
function writeShims(seededAt) {
  for (const name of ['gh', 'glab']) {
    const script = path.join(demo, 'forge', `${name}.mjs`);
    if (windows) {
      write(
        path.join(bin, `${name}.cmd`),
        `@set DEMO_SEEDED_AT=${seededAt}\r\n@set "DEMO_STATE=${state}"\r\n@"${process.execPath}" "${script}" %*\r\n`
      );
      continue;
    }
    const shim = path.join(bin, name);
    write(
      shim,
      `#!/bin/sh\nDEMO_SEEDED_AT=${seededAt} DEMO_STATE=${JSON.stringify(state)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`
    );
    chmodSync(shim, 0o755);
  }
}

/** Plugin options: the fake forges, both providers. */
function pluginEntry() {
  const shim = (name) => path.join(bin, windows ? `${name}.cmd` : name);
  return {
    package: root,
    options: { ghPath: shim('gh'), glabPath: shim('glab'), providers: ['github', 'gitlab'] }
  };
}

/**
 * Writes the server config (`opencode.json`) and the TUI config (`cli.json`). `modelURL` is the
 * scripted model's endpoint; without it the server loads no plugin, for the import run.
 */
function writeConfig(modelURL) {
  const server = {
    $schema: 'https://opencode.ai/config.json',
    model: `${MODEL.providerID}/${MODEL.id}`,
    small_model: `${MODEL.providerID}/${MODEL.id}`,
    providers: {
      [MODEL.providerID]: {
        name: 'Demo',
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: modelURL ?? 'http://127.0.0.1:9/v1', apiKey: 'demo' },
        models: {
          [MODEL.id]: { name: 'Demo assistant', limit: { context: 200_000, output: 32_000 } }
        }
      }
    },
    ...(modelURL ? { plugins: [pluginEntry()] } : {})
  };
  write(path.join(config, 'opencode.json'), `${JSON.stringify(server, null, 2)}\n`);
  const tui = {
    $schema: 'https://opencode.ai/v2/cli.json',
    theme: { name: 'opencode', mode: 'dark' },
    // Tabs turn the quick switch keys off, and notifications would fire for the running session.
    tabs: { mode: 'off' },
    attention: { notifications: false, sound: false },
    ...(modelURL ? { plugins: [pluginEntry()] } : {})
  };
  write(path.join(config, 'cli.json'), `${JSON.stringify(tui, null, 2)}\n`);
}

/**
 * Starts `opencode serve` the way `--standalone` does (stdio lease, random password) and
 * resolves its URL and password. Imports share it, which is about three times faster than a
 * standalone server per import.
 */
function startServer() {
  const password = randomBytes(24).toString('base64url');
  const child = spawn(opencode, ['serve', '--stdio', '--port', '0'], {
    cwd: repos,
    env: { ...environment(), OPENCODE_PASSWORD: password },
    stdio: ['pipe', 'pipe', 'inherit'],
    shell: windows
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`opencode serve exited with ${code}`)));
    createInterface({ input: child.stdout }).once('line', (line) => {
      resolve({ url: JSON.parse(line).url, password, stop: () => child.stdin.end(), child });
    });
  });
}

/** Runs a command and resolves its exit code, rejecting on a non-zero one. */
function exec(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: windows,
      ...options
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve(output) : reject(new Error(`${command} ${args.join(' ')}: ${output}`))
    );
  });
}

/** Imports every session through `opencode session import`, a few at a time. */
async function importSessions(sessions) {
  const server = await startServer();
  const files = sessions.map((session) => {
    const file = path.join(state, 'import', `${session.info.id}.json`);
    write(file, JSON.stringify(session));
    return { file, directory: session.info.location.directory };
  });
  const env = { ...environment(), OPENCODE_PASSWORD: server.password };
  const queue = [...files];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      await exec(
        opencode,
        ['session', 'import', '--server', server.url, '--directory', next.directory, next.file],
        { env }
      );
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const exited = new Promise((resolve) => server.child.once('exit', resolve));
  server.stop();
  await exited;
}

/**
 * Moves each session's update time back to the one in its file. The import stamps every
 * session with the time of the import and no API sets it otherwise, so without this every
 * session would sit in Today. Runs on the demo's own database after its server exited.
 */
function backdate(sessions) {
  const db = new DatabaseSync(database);
  const update = db.prepare('UPDATE session_v2 SET time_updated = ? WHERE id = ?');
  for (const session of sessions) update.run(session.info.time.updated, session.info.id);
  db.close();
}

/** Wipes `.state` and builds it again: repositories, shims, sessions and pins. */
async function seed() {
  const started = Date.now();
  rmSync(state, { recursive: true, force: true });
  mkdirSync(path.join(state, 'tmp'), { recursive: true });
  const seededAt = Date.now();
  createRepositories();
  writeShims(seededAt);
  writeConfig();
  const { sessions, pins } = demoSessions(seededAt, directory);
  await importSessions(sessions);
  backdate(sessions);
  const hostState = path.join(home, '.local', 'state', 'opencode');
  // The plugin copies the host's pins once, on its first start, from this host file.
  write(path.join(hostState, 'session.json'), `${JSON.stringify({ pinned: pins })}\n`);
  // Hides the host's "Getting started" card, which asks to connect a provider in every session
  // sidebar; the scripted model needs none. TUI plugin stores are files named after the plugin
  // id and key (packages/tui/src/plugin/api.tsx:201, feature-plugins/sidebar/footer.tsx:11 at
  // v2.2.5), under the release channel `latest`.
  write(
    path.join(hostState, 'latest', 'tui', 'plugin.opencode.sidebar.footer.getting-started.json'),
    '{"dismissed":true}\n'
  );
  write(seedFile, `${JSON.stringify({ seededAt, seconds: (Date.now() - started) / 1000 })}\n`);
  return (Date.now() - started) / 1000;
}

/**
 * Serves an OpenAI-compatible chat endpoint on loopback. The title agent (a request without
 * tools) gets a title; an agent turn gets reasoning and a short answer, then the stream stays
 * open with empty deltas, so the session keeps running until the TUI exits.
 */
function startModel() {
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (delta, finish = null) =>
      response.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-demo',
          object: 'chat.completion.chunk',
          created: 0,
          model: MODEL.id,
          choices: [{ index: 0, delta, finish_reason: finish }]
        })}\n\n`
      );
    if (!body.tools?.length) {
      send({ role: 'assistant', content: 'Speed up search suggestions' });
      send({}, 'stop');
      response.end('data: [DONE]\n\n');
      return;
    }
    send({
      role: 'assistant',
      reasoning_content:
        'Apply both fixes, then run the cold benchmark again with the same three queries.'
    });
    send({ content: 'Applying the field selection and the prefix cache, then measuring again.' });
    const timer = setInterval(() => send({ content: '' }), 5000);
    response.on('close', () => clearInterval(timer));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}/v1`, server });
    });
  });
}

/** Seeds when needed, then runs the TUI in the storefront repository until it exits. */
async function main() {
  if (flags.has('--keep') && existsSync(seedFile)) {
    console.error(`Reusing ${state}`);
  } else {
    const seconds = await seed();
    console.error(`Seeded ${state} in ${seconds.toFixed(1)} s`);
  }
  const { seededAt } = JSON.parse(readFileSync(seedFile, 'utf8'));
  writeShims(seededAt);
  const model = await startModel();
  writeConfig(model.url);
  const running = flags.has('--no-running')
    ? []
    : ['--session', RUNNING, '--prompt', 'Do both and measure again.'];
  const child = spawn(opencode, ['--standalone', ...running, ...passthrough], {
    cwd: directory('storefront'),
    env: environment(),
    stdio: 'inherit',
    shell: windows
  });
  // The TUI owns the terminal; a signal sent to this process goes to it.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('exit', (code, signal) => {
    model.server.closeAllConnections();
    model.server.close();
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

await main();
