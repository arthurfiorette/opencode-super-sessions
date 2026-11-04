import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openUrl } from '../../src/browser.js';

// A ref's URL comes from the forge or from text, and the OS opener runs whatever handler a scheme
// maps to, so anything but http(s) must stop before a process starts.

test('the opener refuses every scheme but http and https', () => {
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ssh://git@github.com/acme/app',
    'vscode://file/etc/passwd',
    'not a url'
  ]) {
    assert.equal(openUrl(url), false, url);
  }
});
