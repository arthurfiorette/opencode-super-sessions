import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runHostFixture } from './host.js';

test('links, unlinks, refreshes, searches and detects prompt and ! shell refs against a fake gh', {
  timeout: 90_000
}, async () => {
  const result = await runHostFixture('configured-host.mjs', ['--experimental-test-module-mocks']);
  assert.match(result.stdout, /Configured OpenCode integration passed/);
});

test('cleanup removes the merged worktree and keeps the one with an uncommitted edit', {
  timeout: 90_000
}, async () => {
  const result = await runHostFixture('cleanup-host.mjs', ['--experimental-test-module-mocks']);
  assert.match(result.stdout, /Cleanup integration passed/);
});
