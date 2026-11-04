import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), 'opencode super sessions package-'));
// Execute npm's JS entrypoint on Windows, avoiding cmd.exe argument splitting and escaping.
const npmCli =
  process.platform === 'win32'
    ? (process.env.PATH ?? '')
        .split(path.delimiter)
        .map((entry) => path.join(entry, 'node_modules/npm/bin/npm-cli.js'))
        .find((entry) => existsSync(entry))
    : undefined;

/** Runs npm with `args` in `cwd` and returns its stdout. */
const run = (args, cwd) =>
  execFileSync(npmCli ? process.execPath : 'npm', npmCli ? [npmCli, ...args] : args, {
    cwd,
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 10 * 1024 * 1024
  });

try {
  assert.ok(process.platform !== 'win32' || npmCli, 'Cannot locate npm-cli.js on PATH.');
  const result = JSON.parse(
    run(['pack', '--ignore-scripts', '--json', '--pack-destination', directory], root)
  );
  // npm 12 keys pack results by package name; older npm versions return an array.
  const [packed] = Array.isArray(result) ? result : Object.values(result);
  assert.ok(packed);

  for (const name of ['index', 'tui', 'rpc']) {
    assert.ok(
      packed.files.some((file) => file.path === `dist/${name}.js`),
      `Missing ${name} runtime export`
    );
    assert.ok(
      packed.files.some((file) => file.path === `dist/${name}.d.ts`),
      `Missing ${name} type export`
    );
  }
  assert.ok(
    packed.files.every((file) =>
      /^(dist\/|(?:index|tui|rpc)\.js$|package\.json$|README\.md$|LICENSE$)/.test(file.path)
    )
  );

  await writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({ private: true, type: 'module' })
  );
  run(
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      path.join(directory, packed.filename)
    ],
    directory
  );

  const manifest = JSON.parse(
    await readFile(
      path.join(directory, 'node_modules/opencode-super-sessions/package.json'),
      'utf8'
    )
  );
  assert.equal(manifest.name, 'opencode-super-sessions');

  await writeFile(
    path.join(directory, 'smoke.mjs'),
    `import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import server from 'opencode-super-sessions';
import tui from 'opencode-super-sessions/tui';
import { SuperSessions } from 'opencode-super-sessions/rpc';
import { Host } from '@opencode/plugin/host';
assert.equal(server.id, 'opencode-super-sessions');
assert.equal(typeof server.setup, 'function');
assert.equal(tui.id, 'opencode-super-sessions.tui');
assert.equal(typeof tui.setup, 'function');
assert.ok(SuperSessions);
const entries = Host.resolve({ directory: fileURLToPath(new URL('./node_modules/opencode-super-sessions/', import.meta.url)) });
assert.ok(entries.server);
assert.ok(entries.tui);
assert.ok(entries.rpc);
`
  );

  execFileSync(process.execPath, ['smoke.mjs'], {
    cwd: directory,
    stdio: 'inherit',
    timeout: 30_000
  });
  console.log(`Verified packed exports: ${packed.filename}`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
