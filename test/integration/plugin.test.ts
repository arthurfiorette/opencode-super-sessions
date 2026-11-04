import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runHostFixture } from './host.js';

test('loads in a real OpenCode host with default options and serves refs in each Location', {
  timeout: 90_000
}, async () => {
  const result = await runHostFixture('opencode-host.ts');
  assert.match(result.stdout, /OpenCode integration passed/);
});

test('links, unlinks, refreshes, searches and detects prompt and ! shell refs against a fake gh', {
  timeout: 90_000
}, async () => {
  const result = await runHostFixture('configured-host.mjs', ['--experimental-test-module-mocks']);
  assert.match(result.stdout, /Configured OpenCode integration passed/);
});
