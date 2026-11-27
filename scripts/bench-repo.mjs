// Times what a `refs` call waits on git for: resolving the checkout of every listed directory, on
// a cold cache, a warm one, and once the 10 second branch cache expired. Git runs read-only, the
// way the plugin runs it (`src/host/git.ts`). Not part of `pnpm check`: it waits 11 seconds.
//
// Usage: node scripts/bench-repo.mjs --dirs <JSON array of directories> [--plugin <directory>]
// `--plugin` defaults to this checkout; build it first. Pass another checkout to compare.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    dirs: { type: 'string' },
    plugin: { type: 'string', default: fileURLToPath(new URL('../', import.meta.url)) }
  }
});
if (values.dirs === undefined) throw new Error('Pass --dirs with a JSON file of directories.');
const directories = JSON.parse(readFileSync(values.dirs, 'utf8'));
const dist = path.join(path.resolve(values.plugin), 'dist');
const { createRepoResolver } = await import(path.join(dist, 'repo.js'));
const { definitions } = await import(path.join(dist, 'providers/registry.js'));
const { run } = await import(path.join(dist, 'process.js'));

let spawned = 0;
const resolver = createRepoResolver({
  definitions,
  git: (command, args, options) => {
    spawned++;
    return run(command, args, options);
  }
});

/** Resolves every directory at once, as `refs` does, and prints the time and git spawns. */
async function measure(name) {
  const before = spawned;
  const start = performance.now();
  await Promise.all(directories.map((directory) => resolver.resolve(directory)));
  const took = performance.now() - start;
  console.log(
    `${name.padEnd(24)} ${took.toFixed(0).padStart(6)} ms  ${String(spawned - before).padStart(4)} git runs`
  );
}

console.log(`${directories.length} directories`);
await measure('cold');
await measure('warm');
await sleep(11_000);
await measure('branch cache expired');
// What the expired reads started in the background, before the next read.
await sleep(2000);
await measure('after the refresh');
