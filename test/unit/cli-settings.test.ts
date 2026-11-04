import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCliSettings } from '../../src/cli-settings.js';

const DEFAULTS = {
  session: {
    scrollbar: false,
    thinking: 'hide',
    markdown: 'rendered',
    verbosity: 'medium',
    grouping: 'auto'
  },
  animations: true
};

// A cli.json as the host writes it, plus the comments and trailing commas a user may add. The
// `$schema` URL holds `//` inside a string, which must not start a comment.
const JSONC = `{
  "$schema": "https://opencode.ai/v2/cli.json", // written by the host
  /* hand edits */
  "session": { "scrollbar": true, "thinking": "show", },
  "animations": false,
}`;

test('reads the host settings like the host does', () => {
  const cases: Array<[string, string | undefined, string | undefined, unknown]> = [
    ['no file and no overlay gives the host defaults', undefined, undefined, DEFAULTS],
    [
      'comments and trailing commas parse',
      JSONC,
      undefined,
      { session: { ...DEFAULTS.session, scrollbar: true, thinking: 'show' }, animations: false }
    ],
    [
      'the overlay wins key by key and keeps the rest of the file',
      JSONC,
      '{ "session": { "thinking": "hide", "verbosity": "high" } }',
      {
        session: { ...DEFAULTS.session, scrollbar: true, thinking: 'hide', verbosity: 'high' },
        animations: false
      }
    ],
    [
      'an invalid overlay is ignored',
      '{ "session": { "markdown": "source" } }',
      '{ "session": ',
      { session: { ...DEFAULTS.session, markdown: 'source' }, animations: true }
    ],
    [
      'a file mid-edit keeps the last good values',
      '{ "session": { "scrollbar": tr',
      undefined,
      undefined
    ],
    [
      'a value the host rejects keeps the last good values',
      '{ "animations": "yes" }',
      undefined,
      undefined
    ]
  ];
  for (const [name, file, content, expected] of cases) {
    assert.deepEqual(parseCliSettings(file, content), expected, name);
  }
});
