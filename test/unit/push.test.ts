import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pushedBranches } from '../../src/refs/push.js';

// A recorded push makes an older branch pull request count for the session, so a push read
// where none ran, or the wrong branch, attaches another session's work to it.

test('reads the branches a shell command pushed, from git report first, then the command line', () => {
  // [command, output, expected], with `feature` checked out where the session runs.
  const cases: Array<[string, string, string[]]> = [
    ['git push', '', ['feature']],
    ['git push -u origin HEAD', '', ['feature']],
    ['git push origin fix-login', '', ['fix-login']],
    ['git push --force-with-lease origin HEAD:refs/heads/fix-login', '', ['fix-login']],
    ['git push origin +main:release main:staging', '', ['release', 'staging']],
    ['git push -o ci.skip origin fix-login', '', ['fix-login']],
    ['git push --repo origin', '', ['feature']],
    ['git push --all origin', '', ['feature']],
    ['git push --follow-tags', '', ['feature']],
    ['git -C ../other push', '', ['feature']],
    ['bash -lc "git fetch && git push -u origin fix-login"', '', ['fix-login']],
    ['cd app && git push 2>&1 | tail -3', '', ['feature']],
    ['(cd app && git push origin fix-login)', '', ['fix-login']],
    ['GIT_TRACE=1 timeout 60 git push', '', ['feature']],
    // Pushes that write no branch.
    ['git push origin :old-branch', '', []],
    ['git push --delete origin old-branch', '', []],
    ['git push -n origin fix-login', '', []],
    ['git push --dry-run', '', []],
    ['git push --tags', '', []],
    ['git push origin v1.2.0:refs/tags/v1.2.0', '', []],
    // Not a push that runs.
    ['echo git push', '', []],
    ['git commit -m "git push later"', '', []],
    ['git log --grep push', '', []],
    ["cat <<'EOF'\ngit push origin fix-login\nEOF", '', []],
    // git's report names what was written, whatever the command line says.
    [
      'git push',
      'remote: Create a pull request:\nTo github.com:acme/app.git\n * [new branch]      fix-login -> fix-login\n',
      ['fix-login']
    ],
    [
      'git push origin HEAD',
      'To https://github.com/acme/app.git\n + 1a2b3c4...5d6e7f8 HEAD -> fix-login (forced update)\n',
      ['fix-login']
    ],
    [
      'git push --tags origin && git push',
      'To https://github.com/acme/app.git\n * [new tag]         v1 -> v1\n   1a2b3c4..5d6e7f8  feature -> feature\n',
      ['feature']
    ],
    // A rejected push wrote nothing; a report-less answer falls back to the command line.
    [
      'git push',
      'To https://github.com/acme/app.git\n ! [rejected]        feature -> feature (fetch first)\nerror: failed to push some refs\n',
      []
    ],
    ['git push', 'Everything up-to-date\n', ['feature']],
    ['git push origin fix-login', 'fatal: could not read Username\n', ['fix-login']]
  ];
  for (const [command, output, expected] of cases) {
    assert.deepEqual(pushedBranches(command, output, 'feature'), expected, command);
  }
  // A detached HEAD has no branch to stand in for an unnamed target.
  assert.deepEqual(pushedBranches('git push origin HEAD', '', undefined), []);
});
