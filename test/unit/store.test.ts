import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Ref, RefLink, RefSource, SessionRefs } from '../../src/refs/ref.js';
import { refKey } from '../../src/refs/ref.js';
import { dismissLink, mergeLinks } from '../../src/refs/store.js';

const pr: Ref = { provider: 'github', host: 'github.com', repo: 'acme/app', kind: 'pr', number: 1 };
const issue: Ref = { ...pr, kind: 'issue', number: 2 };
const link = (ref: Ref, source: RefSource, linkedAt: number, via?: string): RefLink =>
  via === undefined ? { ref, source, linkedAt } : { ref, source, linkedAt, via };
const refs = (links: RefLink[], dismissed: string[] = []): SessionRefs => ({
  v: 1,
  links,
  dismissed
});

test('merges links by priority without re-adding dismissed refs from detection', () => {
  const cases: Array<{
    name: string;
    current: SessionRefs;
    incoming: RefLink[];
    expected: SessionRefs;
  }> = [
    {
      name: 'detection never re-adds a dismissed key',
      current: refs([], [refKey(pr)]),
      incoming: [link(pr, 'created', 5), link(pr, 'prompt', 5), link(pr, 'mention', 5)],
      expected: refs([], [refKey(pr)])
    },
    {
      name: 'an explicit agent link overrides the dismissal',
      current: refs([], [refKey(pr)]),
      incoming: [link(pr, 'agent', 5)],
      expected: refs([link(pr, 'agent', 5)])
    },
    {
      name: 'upgrade keeps the earliest linkedAt',
      current: refs([link(issue, 'mention', 1)]),
      incoming: [link(issue, 'prompt', 9)],
      expected: refs([link(issue, 'prompt', 1)])
    },
    {
      name: 'a lower source never downgrades',
      current: refs([link(pr, 'created', 3)]),
      incoming: [link(pr, 'mention', 1)],
      expected: refs([link(pr, 'created', 1)])
    },
    {
      name: 'mention upgraded to closes takes the PR as via',
      current: refs([link(issue, 'mention', 1)]),
      incoming: [link(issue, 'closes', 2, refKey(pr))],
      expected: refs([link(issue, 'closes', 1, refKey(pr))])
    },
    {
      name: 'closes upgraded to prompt drops via',
      current: refs([link(issue, 'closes', 1, refKey(pr))]),
      incoming: [link(issue, 'prompt', 2)],
      expected: refs([link(issue, 'prompt', 1)])
    },
    {
      name: "detection keeps the user's Done mark",
      current: { ...refs([]), done: true, doneAt: 7 },
      incoming: [link(pr, 'created', 4)],
      expected: { ...refs([link(pr, 'created', 4)]), done: true, doneAt: 7 }
    },
    {
      name: 'duplicates in one batch collapse',
      current: refs([]),
      incoming: [link(pr, 'mention', 4), link(pr, 'agent', 6)],
      expected: refs([link(pr, 'agent', 4)])
    }
  ];
  for (const { name, current, incoming, expected } of cases) {
    const { next, changed } = mergeLinks(current, incoming);
    assert.deepEqual(next, expected, name);
    assert.equal(changed, JSON.stringify(current) !== JSON.stringify(expected), name);
  }
});

test('dismissing a PR drops its closes links without dismissing those issues', () => {
  const other: Ref = { ...issue, number: 3 };
  const current = refs([
    link(pr, 'created', 1),
    link(issue, 'closes', 2, refKey(pr)),
    link(other, 'prompt', 3)
  ]);
  const { next, changed } = dismissLink(current, refKey(pr));
  assert.equal(changed, true);
  assert.deepEqual(next, refs([link(other, 'prompt', 3)], [refKey(pr)]));
  // The issue was not dismissed, so a prompt may still link it.
  assert.equal(mergeLinks(next, [link(issue, 'prompt', 4)]).next.links.length, 2);
  assert.deepEqual(dismissLink(next, refKey(pr)), { next, changed: false });
});
