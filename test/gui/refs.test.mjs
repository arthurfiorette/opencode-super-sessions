import { afterEach, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createClient, createServer, startGui, until } from './harness.mjs';

const { sessionRefViewSchema } = await import('../../dist/rpc.js');

const github = { provider: 'github', host: 'github.com', repo: 'acme/widgets', kind: 'pr' };
const gitlab = { provider: 'gitlab', host: 'gitlab.com', repo: 'acme/api', kind: 'pr' };
const key = (ref) => `${ref.provider}:${ref.host}/${ref.repo}/${ref.kind}/${ref.number}`;
const stacked = { ...github, number: 4930 };
const merged = { ...github, number: 4871 };
const request = { ...gitlab, number: 12 };

// Parsed, so the fixture stays a view the server could send.
const view = sessionRefViewSchema.parse({
  links: [
    { ref: stacked, source: 'agent', linkedAt: 3 },
    { ref: merged, source: 'manual', linkedAt: 2 },
    { ref: request, source: 'manual', linkedAt: 1 }
  ],
  branchRefs: [],
  states: {
    [key(stacked)]: {
      status: 'open',
      title: 'Split the build',
      url: 'https://github.com/acme/widgets/pull/4930',
      stack: { number: 7, position: 2, size: 4 },
      review: { decision: 'changes_requested', checks: 'failing', checksPassed: 1, checksTotal: 3 }
    },
    [key(merged)]: {
      status: 'merged',
      title: 'Rollup plugin order',
      url: 'https://github.com/acme/widgets/pull/4871'
    },
    [key(request)]: {
      status: 'open',
      title: 'Cache tokens',
      url: 'https://gitlab.com/acme/api/-/merge_requests/12'
    }
  }
});

let gui;
afterEach(() => gui?.dispose());

test('the built bundle loads in a window and draws the routed session refs like GitHub', async () => {
  const info = {
    id: 'ses_1',
    title: 'Split the build',
    projectID: 'proj',
    location: { directory: '/work/widgets' },
    time: { created: Date.now(), updated: Date.now() }
  };
  const client = createClient({
    'session.get': () => info,
    'session.list': ({ archived }) => ({ data: archived ? [] : [info] }),
    'rpc.refs': ({ sessionIDs }) => ({ [sessionIDs[0]]: view }),
    'rpc.refresh': ({ sessionIDs }) => ({ [sessionIDs[0]]: view })
  });
  const server = createServer({ client });
  gui = await startGui({
    session: { server, id: 'ses_1', key: `${server.id}\nses_1`, directory: '/work/widgets' },
    servers: [server]
  });

  assert.ok(gui.items('style')[0]?.includes('.ss-ref'));
  await gui.command('browse').run();
  // The browser's row of the session draws its pull requests.
  const line = (ref) =>
    until(
      () => document.querySelector(`[data-session="ses_1"] [data-ref="${key(ref)}"]`)?.closest('a'),
      key(ref)
    );

  const open = await line(stacked);
  const openMark = open.querySelector('.ss-ref-mark');
  assert.ok(openMark.classList.contains('ss-state-open'));
  assert.equal(openMark.querySelector('svg').dataset.octicon, 'git-pull-request');
  assert.equal(openMark.textContent, '#4930');
  const stack = open.querySelector('.ss-ref-stack');
  assert.equal(stack.textContent, '2/4');
  assert.equal(stack.querySelector('svg').dataset.octicon, 'stack');
  assert.deepEqual(
    [...open.querySelectorAll('.ss-badge')].map((badge) => [
      badge.querySelector('svg')?.dataset.octicon,
      badge.textContent,
      badge.classList.contains('ss-tone-error') ? 'error' : 'other'
    ]),
    [
      ['file-diff', '', 'error'],
      ['x', '', 'error'],
      [undefined, '1/3', 'other']
    ]
  );
  assert.equal(open.querySelector('.ss-ref-title').textContent, 'Split the build');

  const done = (await line(merged)).querySelector('.ss-ref-mark');
  assert.ok(done.classList.contains('ss-state-merged'));
  assert.equal(done.querySelector('svg').dataset.octicon, 'git-merge');
  // A merged pull request has nothing left to review or run.
  assert.equal((await line(merged)).querySelector('.ss-badge'), null);

  assert.equal((await line(request)).querySelector('.ss-ref-number').textContent, '!12');

  (await line(stacked)).click();
  assert.deepEqual(gui.opened, ['https://github.com/acme/widgets/pull/4930']);
  // The session's own Location answers for it.
  assert.deepEqual(
    client.calls.filter((call) => call.name === 'rpc.refs').map((call) => call.options),
    [{ location: { directory: '/work/widgets' } }]
  );
});
