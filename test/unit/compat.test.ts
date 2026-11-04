import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isUntested, TESTED_UP_TO } from '../../src/host/compat.js';

// A wrong answer either turns the takeover off for every user on a supported host or leaves it
// on for a release CI never saw, and neither shows until that release ships.
test('only a newer minor or major than the pin counts as untested', () => {
  // A range such as ^2.2.5 would not parse, and every host would then count as tested.
  assert.match(TESTED_UP_TO, /^\d+\.\d+\.\d+$/, 'the @opencode/plugin pin must be exact');
  const [major = 0, minor = 0, patch = 0] = TESTED_UP_TO.split('.').map(Number);
  const cases: Array<[string, boolean]> = [
    [TESTED_UP_TO, false],
    [`${major}.${minor}.${patch + 4}`, false],
    [`v${major}.${minor}.${patch + 4}`, false],
    [`${major}.${minor}.0`, false],
    [`${major - 1}.${minor + 9}.0`, false],
    [`${major}.${minor + 1}.0`, true],
    [`${major}.${minor + 1}.0-beta.1`, true],
    // Compared as numbers: 10 is newer than 2.
    [`${major}.${minor + 10}.0`, true],
    [`${major + 1}.0.0`, true],
    // Builds from source and dev channels.
    ['0.0.0-dev-562', false],
    ['local', false]
  ];
  for (const [version, expected] of cases) {
    assert.equal(isUntested(version), expected, version);
  }
});
