import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Ref, RefLink, RefSource, RefState } from '../../src/refs/ref.js';
import { refKey } from '../../src/refs/ref.js';
import { type DoneInput, doneAt, isDone, rowRefs, sidebarRefs } from '../../src/refs/summary.js';
import type { SessionRefView } from '../../src/rpc.js';

const ref = (kind: Ref['kind'], number: number): Ref => ({
  provider: 'github',
  host: 'github.com',
  repo: 'acme/app',
  kind,
  number
});
const pr = (n: number) => ref('pr', n);
const issue = (n: number) => ref('issue', n);
const link = (target: Ref, source: RefSource, linkedAt = 1): RefLink => ({
  ref: target,
  source,
  linkedAt
});
const state = (status: RefState['status'], at?: number): RefState => ({
  status,
  title: 't',
  url: 'u',
  ...(at === undefined ? {} : status === 'merged' ? { mergedAt: at } : { closedAt: at })
});
const view = (
  links: RefLink[],
  states: Array<[Ref, RefState]> = [],
  branchRefs: Ref[] = []
): SessionRefView => ({
  links,
  branchRefs,
  states: Object.fromEntries(states.map(([target, value]) => [refKey(target), value]))
});

test('decides when a session is Done', () => {
  const idle = { running: false, pending: false, archived: false };
  const merged = view([link(pr(1), 'created')], [[pr(1), state('merged', 100)]]);
  const cases: Array<[string, DoneInput, boolean]> = [
    ['merged PR', { ...idle, view: merged }, true],
    ['still running', { ...idle, running: true, view: merged }, false],
    ['waiting on a permission', { ...idle, pending: true, view: merged }, false],
    ['archived', { ...idle, archived: true, view: merged }, false],
    ['no refs', { ...idle, view: view([]) }, false],
    [
      'merged before the last user message',
      { ...idle, view: merged, lastUserMessageAt: 150 },
      false
    ],
    ['merged after the last user message', { ...idle, view: merged, lastUserMessageAt: 50 }, true],
    [
      'branch PR closed without merge',
      { ...idle, view: view([], [[pr(2), state('closed', 100)]], [pr(2)]) },
      true
    ],
    [
      'one of two PRs still open',
      {
        ...idle,
        view: view(
          [link(pr(1), 'created'), link(pr(2), 'agent')],
          [
            [pr(1), state('merged', 100)],
            [pr(2), state('open')]
          ]
        )
      },
      false
    ],
    [
      'open prompt issue does not block a merged PR',
      {
        ...idle,
        view: view(
          [link(pr(1), 'created'), link(issue(9), 'prompt')],
          [
            [pr(1), state('merged', 100)],
            [issue(9), state('open')]
          ]
        )
      },
      true
    ],
    [
      'unknown state of any tracked ref blocks',
      {
        ...idle,
        view: view(
          [link(pr(1), 'created'), link(issue(9), 'prompt')],
          [[pr(1), state('merged', 100)]]
        )
      },
      false
    ],
    [
      'prompt issue alone, completed',
      { ...idle, view: view([link(issue(9), 'prompt')], [[issue(9), state('completed', 100)]]) },
      true
    ],
    [
      'prompt issue alone, not planned',
      { ...idle, view: view([link(issue(9), 'prompt')], [[issue(9), state('not_planned', 100)]]) },
      true
    ],
    [
      'prompt issue alone, open',
      { ...idle, view: view([link(issue(9), 'prompt')], [[issue(9), state('open')]]) },
      false
    ],
    [
      'closes issue never decides on its own',
      { ...idle, view: view([link(issue(9), 'closes')], [[issue(9), state('completed', 100)]]) },
      false
    ],
    [
      'mentions are not tracked',
      { ...idle, view: view([link(pr(1), 'mention')], [[pr(1), state('merged', 100)]]) },
      false
    ],
    ['marked done without refs', { ...idle, view: { ...view([]), done: true } }, true],
    [
      'marked done while a question waits',
      { ...idle, pending: true, view: { ...view([]), done: true } },
      true
    ],
    [
      'marked done but running',
      { ...idle, running: true, view: { ...view([]), done: true } },
      false
    ],
    [
      'marked done but archived',
      { ...idle, archived: true, view: { ...view([]), done: true } },
      false
    ],
    ['marked not done with a merged PR', { ...idle, view: { ...merged, done: false } }, false]
  ];
  for (const [name, input, expected] of cases) {
    assert.equal(isDone(input), expected, name);
  }
  // Auto-archive counts days from the mark, not from the merge.
  assert.equal(doneAt({ ...merged, done: true, doneAt: 500 }), 500);
  assert.equal(doneAt(merged), 100);
});

test('rows list open pull requests above merged and closed ones, and the issues they close next', () => {
  const closes = (target: Ref, via: Ref, linkedAt: number): RefLink => ({
    ...link(target, 'closes', linkedAt),
    via: refKey(via)
  });
  const sessionView = view(
    [
      link(pr(2), 'agent', 5),
      link(pr(3), 'created', 9),
      // No snapshot yet: sorts with the open ones, after the explicit links.
      link(pr(4), 'prompt', 8),
      link(pr(7), 'mention', 10),
      closes(issue(20), pr(2), 1),
      link(issue(21), 'prompt', 7),
      closes(issue(22), pr(6), 2),
      // Closed by a PR the row does not show, so it waits with the other issues.
      closes(issue(23), pr(3), 3)
    ],
    [
      [pr(1), state('merged', 100)],
      [pr(2), state('open')],
      [pr(3), state('closed', 90)],
      [pr(6), state('open')],
      [issue(20), state('open')],
      [issue(21), state('open')],
      [issue(22), state('open')],
      [issue(23), state('open')]
    ],
    // The open branch PR leads the open links; the merged one drops below every open PR.
    [pr(6), pr(1)]
  );
  const numbers = (refs: Ref[]) => refs.map((item) => item.number);
  const row = rowRefs(sessionView);
  assert.deepEqual(numbers(row.prs), [6, 2, 4]);
  assert.deepEqual(numbers(row.issues), [22, 20, 21, 23]);
  // #1 and #3 past the three PR lines, and the mention.
  assert.equal(row.extra, 3);
  assert.deepEqual(numbers(sidebarRefs(sessionView).refs), [6, 2, 4, 1, 3, 21, 23, 22, 20]);
});
