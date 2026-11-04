import assert from 'node:assert/strict';
import { test } from 'node:test';
import { definitions } from '../../src/providers/registry.js';
import { type Ref, refKey } from '../../src/refs/ref.js';
import { rankSessions, type SearchSession } from '../../src/refs/search.js';

const ref = (repo: string, number: number, kind: Ref['kind'] = 'pr'): Ref => ({
  provider: 'github',
  host: 'github.com',
  repo,
  kind,
  number
});

const sessions: SearchSession[] = [
  { id: 'exact', title: 'Fix login', updated: 1, refs: [] },
  { id: 'title-old', title: 'Fix login redirect', updated: 2, refs: [] },
  { id: 'title-new', title: 'Retry: fix LOGIN flow', updated: 9, refs: [] },
  {
    id: 'ref-12',
    title: 'Upgrade deps',
    updated: 5,
    refs: [{ ref: ref('acme/app', 12), title: 'Bump vite' }]
  },
  {
    id: 'ref-123',
    title: 'Cache layer',
    updated: 8,
    refs: [{ ref: ref('acme/app', 123), title: 'Fix login cache' }]
  },
  {
    id: 'other-repo-12',
    title: 'Docs',
    updated: 7,
    refs: [{ ref: ref('other/lib', 12, 'issue') }]
  },
  { id: 'server-hit', title: 'Untitled', updated: 3, refs: [] }
];

test('ranks by tier, then recency, and never matches a number by prefix', () => {
  const cases: Array<[string, string[] | undefined, Array<[string, string]>]> = [
    [
      'fix login',
      ['server-hit'],
      [
        ['exact', 'title'],
        ['title-new', 'title'],
        ['server-hit', 'title'],
        ['title-old', 'title'],
        ['ref-123', 'ref-title']
      ]
    ],
    [
      '12',
      undefined,
      [
        ['other-repo-12', 'ref-number'],
        ['ref-12', 'ref-number']
      ]
    ],
    [
      'pr #12',
      undefined,
      [
        ['other-repo-12', 'ref-number'],
        ['ref-12', 'ref-number']
      ]
    ],
    [
      'mr !12',
      undefined,
      [
        ['other-repo-12', 'ref-number'],
        ['ref-12', 'ref-number']
      ]
    ],
    ['acme/app#12', undefined, [['ref-12', 'ref-number']]],
    ['https://github.com/other/lib/issues/12', undefined, [['other-repo-12', 'ref-number']]],
    ['https://github.com/other/lib/pull/12', undefined, []],
    ['#1', undefined, []],
    ['vite', undefined, [['ref-12', 'ref-title']]]
  ];
  for (const [query, titleHits, expected] of cases) {
    const hits = rankSessions({
      query,
      definitions,
      sessions,
      ...(titleHits === undefined ? {} : { titleHits })
    });
    assert.deepEqual(
      hits.map((hit) => [hit.sessionID, hit.match]),
      expected,
      query
    );
  }
});

test('a ref match names the ref that matched, so the row can say why it is listed', () => {
  const issue = ref('acme/app', 7, 'issue');
  const pr = ref('acme/app', 40);
  const session = {
    id: 'two-refs',
    title: 'Upgrade deps',
    updated: 1,
    refs: [
      { ref: pr, title: 'Bump vite' },
      { ref: issue, title: 'Safari login fails' }
    ]
  };
  const hit = (query: string) => rankSessions({ query, definitions, sessions: [session] })[0];
  assert.equal(hit('#7')?.ref, refKey(issue));
  assert.equal(hit('safari')?.ref, refKey(issue));
  assert.equal(hit('upgrade')?.ref, undefined);
});
