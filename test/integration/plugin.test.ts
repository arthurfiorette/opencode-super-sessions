import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runHostFixture } from './host.js';

test('loads in a real OpenCode host and serves Location-scoped status RPCs', {
  timeout: 90_000
}, async () => {
  const result = await runHostFixture('opencode-host.ts');
  assert.match(result.stdout, /OpenCode integration passed/);
});
