import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Ref, RefLink, RefSource, RefState } from '../../src/refs/ref.js';
import { refKey } from '../../src/refs/ref.js';
import { type DoneInput, doneAt, isDone, rowRefs } from '../../src/refs/summary.js';
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
const state = (
  status: RefState['status'],
  at?: number,
  extra: Partial<RefState> = {}
): RefState => ({
  status,
  title: 't',
  url: 'u',
  ...(at === undefined ? {} : status === 'merged' ? { mergedAt: at } : { closedAt: at }),
  ...extra
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

test('picks the main PR, every tracked issue and the overflow count', () => {
  const closes = (target: Ref, via: Ref, linkedAt: number): RefLink => ({
    ...link(target, 'closes', linkedAt),
    via: refKey(via)
  });
  const cases: Array<[string, SessionRefView, ReturnType<typeof rowRefs>]> = [
    ['empty', view([]), { branch: false, issues: [], extra: 0 }],
    [
      'branch PR wins over a newer linked PR',
      view([link(pr(2), 'agent', 9)], [], [pr(1)]),
      { pr: pr(1), branch: true, issues: [], extra: 1 }
    ],
    [
      'newest linked PR wins',
      view([link(pr(1), 'created', 1), link(pr(2), 'agent', 2)]),
      { pr: pr(2), branch: false, issues: [], extra: 1 }
    ],
    [
      'linked PR wins over a newer PR from the prompt',
      view([link(pr(1), 'created', 1), link(pr(2), 'prompt', 2)]),
      { pr: pr(1), branch: false, issues: [], extra: 1 }
    ],
    [
      'issues the PR closes come first, then the rest newest first',
      view([
        link(issue(7), 'prompt', 3),
        closes(issue(8), pr(1), 1),
        link(issue(9), 'manual', 5),
        link(pr(1), 'created', 2)
      ]),
      { pr: pr(1), branch: false, issues: [issue(8), issue(9), issue(7)], extra: 0 }
    ],
    [
      'snapshot closes list counts before a closes link exists',
      view(
        [link(issue(9), 'prompt', 5)],
        [[pr(1), state('open', undefined, { closes: [issue(8)] })]],
        [pr(1)]
      ),
      { pr: pr(1), branch: true, issues: [issue(8), issue(9)], extra: 0 }
    ],
    [
      'without PRs only issues show',
      view([link(issue(8), 'prompt', 1), link(issue(9), 'prompt', 5)]),
      { branch: false, issues: [issue(9), issue(8)], extra: 0 }
    ],
    [
      'mentions only add to the count',
      view([link(pr(1), 'agent', 1), link(pr(5), 'mention', 9), link(issue(6), 'mention', 9)]),
      { pr: pr(1), branch: false, issues: [], extra: 2 }
    ]
  ];
  for (const [name, input, expected] of cases) {
    assert.deepEqual(rowRefs(input), expected, name);
  }
});
