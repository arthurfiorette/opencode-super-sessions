// The demo's `gh`. The plugin runs it through the shim start.mjs writes to `.state/bin`, which
// sets DEMO_SEEDED_AT and DEMO_STATE: the plugin passes only an allowlisted environment to gh.

import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { serveGh } from '../../test/fixtures/gh-protocol.mjs';
import { githubData } from './data.mjs';

appendFileSync(
  path.join(process.env.DEMO_STATE, 'forge.log'),
  `${new Date().toISOString()} gh ${process.argv.slice(2).join(' ')}\n`
);
serveGh(githubData(Number(process.env.DEMO_SEEDED_AT)));
