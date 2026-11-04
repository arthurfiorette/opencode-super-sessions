import assert from 'node:assert/strict';
import { test } from 'node:test';
import { github } from '../../src/providers/github/definition.js';
import type { RepoRef } from '../../src/providers/provider.js';
import { parseUrl, recognizeRemote } from '../../src/providers/registry.js';

const base: RepoRef = { provider: 'github', host: 'github.com', repo: 'acme/app' };
const ghes: RepoRef = { provider: 'github', host: 'github.acme.io', repo: 'team/tool' };

test('recognizes GitHub remotes and rejects other forges and local paths', () => {
  const cases: Array<[string, RepoRef | undefined]> = [
    ['https://github.com/Acme/App.git', base],
    ['https://token@github.com/acme/app/', base],
    ['ssh://git@github.com:22/acme/app.git', base],
    ['git://github.com/acme/app.git', base],
    ['git@github.com:acme/app.git', base],
    ['github.com:acme/app', base],
    // SSH config aliases pick a key but still talk to github.com.
    ['git@github.com-work:acme/app.git', base],
    ['git@github-personal:acme/app.git', base],
    ['git@github.acme.io:team/tool.git', ghes],
    ['https://github.acme.io/team/tool', ghes],
    ['git@acme.ghe.com:team/tool.git', { ...ghes, host: 'acme.ghe.com' }],
    // A GHES hostname with a dash is a real server, not an alias.
    ['git@github-enterprise.acme.io:team/tool.git', undefined],
    ['git@gitlab.com:acme/app.git', undefined],
    ['https://bitbucket.org/acme/app', undefined],
    ['https://github.com/acme', undefined],
    ['https://github.com/acme/app/extra', undefined],
    ['C:/repos/app', undefined],
    ['/home/me/app', undefined],
    ['../app', undefined]
  ];
  for (const [remote, expected] of cases) {
    assert.deepEqual(recognizeRemote(remote), expected, remote);
  }
});

test('parses pull request and issue URLs with trailing paths, queries and fragments', () => {
  const pr = { provider: 'github', host: 'github.com', repo: 'acme/app', kind: 'pr', number: 12 };
  const issue = { ...pr, kind: 'issue' };
  const cases: Array<[string, object | undefined]> = [
    ['https://github.com/acme/app/pull/12', pr],
    ['https://github.com/Acme/App/pull/12/files', pr],
    ['https://github.com/acme/app/pull/12?w=1', pr],
    ['https://www.github.com/acme/app/pull/12', pr],
    ['https://github.com/acme/app/pull/12#discussion_r1', pr],
    ['https://github.com/acme/app/issues/12#issuecomment-99', issue],
    [
      'https://github.acme.io/team/tool/pull/3',
      { ...pr, host: 'github.acme.io', repo: 'team/tool', number: 3 }
    ],
    ['https://github.com/acme/app/pull/12abc', undefined],
    ['https://github.com/acme/app/pull/0', undefined],
    ['https://github.com/acme/app/pulls/12', undefined],
    ['https://github.com/acme/app', undefined],
    ['https://gitlab.com/acme/app/pull/12', undefined],
    ['ftp://github.com/acme/app/pull/12', undefined],
    ['not a url', undefined]
  ];
  for (const [url, expected] of cases) {
    assert.deepEqual(parseUrl(url), expected, url);
  }
});

test('parses typed references and only resolves bare numbers against a GitHub base', () => {
  const ref = (number: number, extra: object = {}) => ({ ...base, number, ...extra });
  const cases: Array<[string, RepoRef | undefined, object | undefined]> = [
    ['https://github.com/acme/app/issues/7', undefined, ref(7, { kind: 'issue' })],
    ['other/lib#5', undefined, { ...base, repo: 'other/lib', number: 5 }],
    // A GHES session resolves `owner/repo#N` on its own server.
    ['other/lib#5', ghes, { ...ghes, repo: 'other/lib', number: 5 }],
    ['#12', base, ref(12)],
    ['12', base, ref(12)],
    ['  12  ', base, ref(12)],
    ['pr 12', base, ref(12, { kind: 'pr' })],
    ['pull #12', base, ref(12, { kind: 'pr' })],
    ['PR12', base, ref(12, { kind: 'pr' })],
    ['issue 12', base, ref(12, { kind: 'issue' })],
    ['#12', undefined, undefined],
    ['#12', { provider: 'gitlab', host: 'gitlab.com', repo: 'acme/app' }, undefined],
    ['#0', base, undefined],
    ['12 13', base, undefined],
    ['fix 12', base, undefined]
  ];
  for (const [text, context, expected] of cases) {
    assert.deepEqual(github.parseReference(text, context), expected, text);
  }
});

test('scans prose for URLs and owner/repo#N without reading paths, emails or fragments', () => {
  const cases: Array<[string, string[]]> = [
    ['See https://github.com/acme/app/pull/12.', ['acme/app pr 12']],
    [
      '[PR](https://github.com/acme/app/pull/12) and other/lib#3',
      ['acme/app pr 12', 'other/lib ? 3']
    ],
    // The fragment of a URL is not a second reference.
    ['https://github.com/acme/app/pull/12#issuecomment-4', ['acme/app pr 12']],
    ['https://example.com/acme/app#4', []],
    ['edit src/acme/app#4 and docs/x#1/y', []],
    ['mail me@acme/app#4', []],
    ['the fix is in foo.bar/baz#4', []],
    ['tracking acme/app#12abc', []],
    ['bare #12 is ignored', []]
  ];
  for (const [text, expected] of cases) {
    const found = github
      .scanText(text)
      .map((ref) => `${ref.repo} ${ref.kind ?? '?'} ${ref.number}`);
    assert.deepEqual(found, expected, text);
  }
});

test('scans bare #N only outside URLs, entities, owner/repo refs and code fences', () => {
  const cases: Array<[string, number[]]> = [
    ['debug #28957 and (#3), then #4.', [28957, 3, 4]],
    ['# Heading\n#12 first', [12]],
    ['acme/app#5 and #6', [6]],
    ['https://github.com/acme/app/pull/1#issuecomment-7 and #8', [8]],
    ['entity &#123; and color #0f0 and #012', []],
    ['```\n#1 in code\n```\nafter #9', [9]],
    ['~~~\nunterminated #1', []],
    ['#12abc and ##3', []]
  ];
  for (const [text, expected] of cases) {
    const found = github.scanBareNumbers(text, base);
    assert.deepEqual(
      found.map((ref) => ref.number),
      expected,
      text
    );
    for (const ref of found) assert.equal(ref.repo, base.repo, text);
  }
});
