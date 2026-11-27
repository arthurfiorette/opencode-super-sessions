// Times message index searches through the built index API. Point it at a COPY of a search.db
// (the plugin data directory's `search.db` and `search.db-wal`): opening the index may migrate
// its schema. node:sqlite runs on the daemon's event loop, so each time here is a stall of every
// client of the daemon. Not part of `pnpm check`.
//
// Usage: node scripts/bench-search.mjs --db <copy of search.db> [--plugin <package directory>]
//        [query ...]
// `--plugin` defaults to this checkout; build it first. Pass another checkout to compare.

import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: 'string' },
    plugin: { type: 'string', default: fileURLToPath(new URL('../', import.meta.url)) }
  }
});
if (values.db === undefined) throw new Error('Pass --db with the path of a copied search.db.');
const queries = positionals.length > 0 ? positionals : ['mas', 'mastra', 'deploy fix', 'a pr'];
const RUNS = 5;

const { openBodyIndex } = await import(
  path.join(path.resolve(values.plugin), 'dist/server/body-index.js')
);
const index = await openBodyIndex(path.resolve(values.db), (message) => console.warn(message));

for (const query of queries) {
  const times = [];
  let hits = 0;
  for (let run = 0; run < RUNS; run++) {
    const start = performance.now();
    hits = index.search(query, { limit: 200 }).length;
    times.push(performance.now() - start);
  }
  // The first run reads from disk; the others mostly from SQLite's and the system's caches.
  const first = times[0] ?? 0;
  times.sort((a, b) => a - b);
  const median = times[Math.floor(RUNS / 2)] ?? 0;
  console.log(
    `${JSON.stringify(query).padEnd(16)} first ${first.toFixed(1).padStart(7)} ms  median ${median.toFixed(1).padStart(7)} ms  ${hits} sessions`
  );
}
index.close();
