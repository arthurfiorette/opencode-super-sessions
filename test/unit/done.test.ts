import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionMessageInfo } from '@opencode/client';
import { lastUserMessageAt } from '../../src/host/events.js';
import type { Ref } from '../../src/refs/ref.js';
import { refKey } from '../../src/refs/ref.js';
import { isDone } from '../../src/refs/summary.js';
import type { SessionRefView } from '../../src/rpc.js';

// The server reads the last user message from `session.context`, which starts at the latest
// compaction. Done decides auto-archive and worktree cleanup, so a wrong answer here archives a
// session or removes a worktree the user is still working in.

const pr: Ref = { provider: 'github', host: 'github.com', repo: 'acme/app', kind: 'pr', number: 1 };

/** A session whose only PR merged at `mergedAt`, with the user's Done mark if given. */
function view(mergedAt: number, done?: boolean): SessionRefView {
  return {
    links: [{ ref: pr, source: 'agent', linkedAt: 1 }],
    branchRefs: [],
    states: { [refKey(pr)]: { status: 'merged', title: '', url: '', mergedAt } },
    ...(done === undefined ? {} : { done })
  };
}

/** Context messages of the given types, created at the given times. */
function context(...entries: Array<[SessionMessageInfo['type'], number]>): SessionMessageInfo[] {
  return entries.map(
    ([type, created], index) =>
      ({ id: `msg_${index}`, type, time: { created } }) as unknown as SessionMessageInfo
  );
}

test('a compaction without a user message after it leaves Done unknown, unless the user marked it', () => {
  const cases: Array<[string, SessionMessageInfo[], boolean | undefined, boolean]> = [
    ['merged after the last prompt', context(['user', 10], ['assistant', 11]), undefined, true],
    ['prompted after the merge', context(['user', 30]), undefined, false],
    ['compacted, no prompt since', context(['compaction', 5], ['assistant', 6]), undefined, false],
    [
      'compacted, prompted before the merge',
      context(['compaction', 5], ['user', 10]),
      undefined,
      true
    ],
    ['no messages at all', context(), undefined, true],
    ['compacted, marked Done', context(['compaction', 5]), true, true],
    ['compacted, marked not Done', context(['compaction', 5]), false, false]
  ];
  for (const [name, messages, mark, expected] of cases) {
    const done = isDone({
      running: false,
      pending: false,
      archived: false,
      view: view(20, mark),
      lastUserMessageAt: lastUserMessageAt(messages)
    });
    assert.equal(done, expected, name);
  }
});
