import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RepoRef } from '../../src/providers/provider.js';
import { definitions } from '../../src/providers/registry.js';
import {
  detectCreated,
  detectInPrompt,
  detectInText,
  isCloseCommand
} from '../../src/refs/detect.js';

const PR = (n: number) => `https://github.com/acme/app/pull/${n}`;
const ISSUE = (n: number) => `https://github.com/acme/app/issues/${n}`;

test('links only the refs a shell command created', () => {
  const cases: Array<{ name: string; command: string; output: string; expected: string[] }> = [
    {
      name: 'plain create',
      command: 'gh pr create --fill',
      output: `\nCreating pull request for feat into main\n\n${PR(51)}\n`,
      expected: ['pr 51']
    },
    {
      name: 'issue create',
      command: 'gh issue create --title "Bug" --body "Broken"',
      output: `${ISSUE(9)}\n`,
      expected: ['issue 9']
    },
    {
      name: 'heredoc body mentions another PR and gh pr list',
      command: `gh pr create --title x --body-file - <<'EOF'\nFollow-up to ${PR(50)}\nRun gh pr list to see more\nEOF`,
      output: `${PR(51)}\n`,
      expected: ['pr 51']
    },
    {
      name: 'quoted URL in --body is not output',
      command: `gh pr create --title x --body "Replaces ${PR(7)}"`,
      output: `${PR(8)}\n`,
      expected: ['pr 8']
    },
    {
      name: 'bash -lc wrapper',
      command: `/bin/bash -lc 'git push -u origin feat && gh pr create --fill'`,
      output: `${PR(12)}\n`,
      expected: ['pr 12']
    },
    {
      name: 'zsh -c wrapper with pieced quoting',
      command: `zsh -c "cd repo && "'gh pr create --fill'`,
      output: `${PR(12)}\n`,
      expected: ['pr 12']
    },
    {
      name: 'two creates print two URLs',
      command: 'gh pr create --fill && gh issue create --title t --body b',
      output: `${PR(20)}\n${ISSUE(21)}\n`,
      expected: ['pr 20', 'issue 21']
    },
    {
      name: 'create followed by a list command',
      command: 'gh pr create --fill && gh pr list',
      output: `${PR(30)}\n${PR(29)}\n`,
      expected: []
    },
    {
      name: 'create beside gh api',
      command: 'gh pr create --fill; gh api repos/acme/app/pulls --jq ".[].html_url"',
      output: `${PR(30)}\n`,
      expected: []
    },
    {
      name: 'URL the script names elsewhere existed before',
      command: 'gh pr view 12 --json url -q .url; gh pr create --fill',
      output: `${PR(12)}\n${PR(13)}\n`,
      expected: ['pr 13']
    },
    {
      name: 'echoed URL in another command is skipped by number',
      command: `echo "${PR(7)}"; gh pr create --fill`,
      output: `${PR(7)}\n${PR(8)}\n`,
      expected: ['pr 8']
    },
    {
      name: 'more URLs than creates',
      command: 'gh pr create --fill && cat urls.txt',
      output: `${PR(40)}\n${PR(41)}\n`,
      expected: []
    },
    {
      name: 'URL with surrounding text',
      command: 'gh pr create --fill',
      output: `Created ${PR(51)} for you\n`,
      expected: []
    },
    {
      name: 'create command only inside quotes',
      command: `echo "gh pr create" && curl ${PR(5)}`,
      output: `${PR(5)}\n`,
      expected: []
    },
    {
      name: 'create command only in a comment',
      command: `# gh pr create later\ngit push`,
      output: `${PR(5)}\n`,
      expected: []
    },
    {
      name: 'issue create does not claim a PR URL',
      command: 'gh issue create --title t --body b',
      output: `${PR(60)}\n`,
      expected: []
    },
    {
      name: 'URL on another forge',
      command: 'gh pr create --fill',
      output: 'https://gitlab.com/acme/app/pull/3\n',
      expected: []
    },
    {
      // glab prints the title line and an indented URL on a terminal, the bare URL otherwise.
      name: 'glab mr create on a terminal',
      command: 'glab mr create --fill --yes',
      output:
        '\nCreating merge request for feat into main in acme/platform/api\n\n!51 Add login (feat)\n https://gitlab.com/acme/platform/api/-/merge_requests/51\n',
      expected: ['pr 51']
    },
    {
      name: 'glab issue create linking a work item URL',
      command: 'glab issue create -t Bug -d Broken',
      output: 'https://gitlab.com/acme/app/-/work_items/9\n',
      expected: ['issue 9']
    }
  ];
  for (const { name, command, output, expected } of cases) {
    const found = detectCreated(definitions, command, output);
    assert.deepEqual(
      found.map((ref) => `${ref.kind} ${ref.number}`),
      expected,
      name
    );
  }
});

test('recognizes merge and close commands only where they run', () => {
  const cases: Array<[string, boolean]> = [
    ['gh pr merge 12 --squash', true],
    ["bash -lc 'git fetch && gh pr close 12'", true],
    ['GH_HOST=github.acme.io gh issue close 3', true],
    ['echo "gh pr merge 12"', false],
    ['# gh pr merge 12', false],
    ['gh pr view 12', false]
  ];
  for (const [command, expected] of cases) {
    assert.equal(isCloseCommand(definitions, command), expected, command);
  }
});

test('assistant text never yields bare numbers and dedupes URL and owner/repo#N forms', () => {
  const text = `Opened ${PR(12)} for acme/app#12, see #13 and other/lib#4 and other/lib#4.`;
  assert.deepEqual(
    detectInText(definitions, text).map((ref) => `${ref.repo}#${ref.number} ${ref.kind ?? '?'}`),
    ['acme/app#12 pr', 'other/lib#4 ?']
  );
});

test('prompts add bare numbers only with a base repository', () => {
  const base: RepoRef = { provider: 'github', host: 'github.com', repo: 'acme/app' };
  const text = `debug #28957 and fix, like ${ISSUE(28957)} and #3`;
  const found = (repo?: RepoRef) =>
    detectInPrompt(definitions, text, repo).map((ref) => `${ref.number} ${ref.kind ?? '?'}`);
  assert.deepEqual(found(base), ['28957 issue', '3 ?']);
  assert.deepEqual(found(), ['28957 issue']);
});

test('owner/repo#N, valid on GitHub and GitLab, goes to the session forge or else the first', () => {
  const gitlabBase: RepoRef = { provider: 'gitlab', host: 'gitlab.com', repo: 'acme/app' };
  const found = (repo?: RepoRef) =>
    detectInPrompt(definitions, 'continue acme/app#12', repo).map(
      (ref) => `${ref.provider} ${ref.kind ?? '?'}`
    );
  assert.deepEqual(found(gitlabBase), ['gitlab issue']);
  assert.deepEqual(found(), ['github ?']);
});
