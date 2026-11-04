import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitLabDefinition, gitlab } from '../../src/providers/gitlab/definition.js';
import type { RepoRef } from '../../src/providers/provider.js';
import { parseUrl, recognizeRemote } from '../../src/providers/registry.js';

const base: RepoRef = { provider: 'gitlab', host: 'gitlab.com', repo: 'acme/app' };
const nested: RepoRef = { provider: 'gitlab', host: 'gitlab.com', repo: 'acme/platform/api' };
const selfHosted: RepoRef = { provider: 'gitlab', host: 'gitlab.acme.io', repo: 'team/tool' };

test('recognizes GitLab remotes with nested groups and self-managed hosts', () => {
  const cases: Array<[string, RepoRef | undefined]> = [
    ['https://gitlab.com/Acme/App.git', base],
    ['git@gitlab.com:acme/platform/api.git', nested],
    ['ssh://git@gitlab.com/acme/platform/api.git', nested],
    // gitlab.com's SSH-over-443 name and SSH config aliases still talk to gitlab.com.
    ['ssh://git@altssh.gitlab.com:443/acme/app.git', base],
    ['git@gitlab.com-work:acme/app.git', base],
    ['git@gitlab.acme.io:team/tool.git', selfHosted],
    ['https://gitlab.acme.io/team/tool', selfHosted],
    // Self-managed host without a gitlab label is unknown until configured.
    ['git@code.acme.io:team/tool.git', undefined],
    ['https://gitlab.com/acme', undefined],
    ['https://gitlab.com/acme/-/app', undefined],
    ['git@github.com:acme/app.git', { provider: 'github', host: 'github.com', repo: 'acme/app' }],
    ['/home/me/app', undefined]
  ];
  for (const [remote, expected] of cases) {
    assert.deepEqual(recognizeRemote(remote), expected, remote);
  }

  const configured = createGitLabDefinition({ hosts: ['Code.Acme.io'] });
  assert.deepEqual(configured.recognizeRemote('git@code.acme.io:team/tool.git'), {
    ...selfHosted,
    host: 'code.acme.io'
  });
  assert.deepEqual(configured.parseUrl('https://code.acme.io/team/tool/-/merge_requests/4'), {
    ...selfHosted,
    host: 'code.acme.io',
    kind: 'pr',
    number: 4
  });
});

test('parses merge request, issue and work item URLs at any group depth', () => {
  const mr = { ...nested, kind: 'pr', number: 12 };
  const issue = { ...nested, kind: 'issue', number: 12 };
  const cases: Array<[string, object | undefined]> = [
    ['https://gitlab.com/acme/platform/api/-/merge_requests/12', mr],
    ['https://gitlab.com/Acme/Platform/API/-/merge_requests/12/diffs?view=inline#note_1', mr],
    ['https://www.gitlab.com/acme/platform/api/-/merge_requests/12', mr],
    ['https://gitlab.com/acme/platform/api/-/issues/12', issue],
    ['https://gitlab.com/acme/platform/api/-/work_items/12', issue],
    ['https://gitlab.acme.io/team/tool/-/issues/3', { ...selfHosted, kind: 'issue', number: 3 }],
    // Pre-`/-/` routes, missing projects and GitHub-style paths are not GitLab refs.
    ['https://gitlab.com/acme/app/merge_requests/12', undefined],
    ['https://gitlab.com/acme/-/merge_requests/12', undefined],
    ['https://gitlab.com/acme/app/-/merge_requests/12abc', undefined],
    ['https://gitlab.com/acme/app/-/merge_requests/0', undefined],
    ['https://gitlab.com/acme/app/pull/12', undefined],
    ['https://example.com/acme/app/-/issues/12', undefined]
  ];
  for (const [url, expected] of cases) {
    assert.deepEqual(parseUrl(url), expected, url);
  }
});

test('typed references take their kind from ! and #, and only resolve in a GitLab session', () => {
  const ref = (repo: RepoRef, number: number, kind?: 'pr' | 'issue') => ({
    ...repo,
    number,
    ...(kind ? { kind } : {})
  });
  const cases: Array<[string, RepoRef | undefined, object | undefined]> = [
    ['acme/platform/api!12', undefined, ref(nested, 12, 'pr')],
    ['acme/platform/api#12', undefined, ref(nested, 12, 'issue')],
    ['mr acme/app!5', undefined, ref(base, 5, 'pr')],
    // A self-managed session resolves `group/project!N` on its own server.
    ['other/lib!5', selfHosted, { ...selfHosted, repo: 'other/lib', number: 5, kind: 'pr' }],
    ['!12', base, ref(base, 12, 'pr')],
    ['#12', base, ref(base, 12, 'issue')],
    ['12', base, ref(base, 12)],
    ['mr 12', base, ref(base, 12, 'pr')],
    ['MR!12', base, ref(base, 12, 'pr')],
    ['merge request 12', base, ref(base, 12, 'pr')],
    ['issue #12', base, ref(base, 12, 'issue')],
    // The word and the sigil disagree.
    ['issue !12', base, undefined],
    ['mr #12', base, undefined],
    ['!12', undefined, undefined],
    ['acme/app#12', { provider: 'github', host: 'github.com', repo: 'acme/app' }, undefined],
    [
      'https://gitlab.com/acme/app/-/issues/7',
      { provider: 'github', host: 'github.com', repo: 'acme/app' },
      ref(base, 7, 'issue')
    ],
    ['acme!12', base, undefined],
    ['!0', base, undefined]
  ];
  for (const [text, context, expected] of cases) {
    assert.deepEqual(gitlab.parseReference(text, context), expected, text);
  }
});

test('scans prose for GitLab URLs and nested path references', () => {
  const cases: Array<[string, string[]]> = [
    ['See https://gitlab.com/acme/app/-/merge_requests/12.', ['acme/app pr 12']],
    // The note fragment of a URL is not a second reference.
    ['https://gitlab.com/acme/app/-/issues/3#note_44', ['acme/app issue 3']],
    [
      'fixed in acme/platform/api!7 for acme/platform/api#8',
      ['acme/platform/api pr 7', 'acme/platform/api issue 8']
    ],
    ['the fix is in example.com/acme/app#4', []],
    ['mail me@acme/app!4', []],
    ['tracking acme/app!12abc', []],
    ['bare !12 and #12 are ignored', []]
  ];
  for (const [text, expected] of cases) {
    const found = gitlab
      .scanText(text)
      .map((ref) => `${ref.repo} ${ref.kind ?? '?'} ${ref.number}`);
    assert.deepEqual(found, expected, text);
  }
});

test('bare !N is a merge request and #N an issue, outside URLs, code and words', () => {
  const cases: Array<[string, string[]]> = [
    ['review !42 then close #7.', ['pr 42', 'issue 7']],
    ['Done!1 and wow!!2 and ##3', []],
    ['```\n!1 in code\n```\nafter !9', ['pr 9']],
    ['https://gitlab.com/acme/app/-/issues/1#note_2 and !5', ['pr 5']]
  ];
  for (const [text, expected] of cases) {
    assert.deepEqual(
      gitlab.scanBareNumbers(text, nested).map((ref) => `${ref.kind} ${ref.number}`),
      expected,
      text
    );
  }
  assert.deepEqual(
    gitlab.scanBareNumbers('#5', { provider: 'github', host: 'github.com', repo: 'a/b' }),
    []
  );
});
