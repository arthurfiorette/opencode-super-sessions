import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { type BodyIndex, openBodyIndex } from '../../src/server/body-index.js';

const root = await mkdtemp(path.join(tmpdir(), 'opencode-super-sessions-index-'));
after(() => rm(root, { recursive: true, force: true }));

/** Opens a fresh index in its own directory; warnings fail the test unless expected. */
async function open(name: string, warn = (message: string) => assert.fail(message)) {
  return openBodyIndex(path.join(root, name, 'search.db'), warn);
}

/** Session ids a query returns, in order. */
function sessions(index: BodyIndex, query: string): string[] {
  return index.search(query, { limit: 10 }).map((hit) => hit.sessionID);
}

test('re-adding a key replaces its text, and each session appears once with its newest hit', async () => {
  const index = await open('upsert');
  index.add('ses_a', 'msg_1', 'deploy the widgets service', 1_000);
  index.add('ses_b', 'msg_2', 'deploy the gadgets service', 2_000);
  index.add('ses_a', 'msg_3', 'deploy again after the fix', 3_000);
  // Live indexing and the backfill both write msg_2; the second write must not duplicate it.
  index.add('ses_b', 'msg_2', 'deploy the gadgets service', 2_000);
  index.add('ses_b', 'msg_4', 'rollback the canary', 500);

  assert.deepEqual(index.search('deploy', { limit: 10 }), [
    { sessionID: 'ses_a', created: 3_000 },
    { sessionID: 'ses_b', created: 2_000 }
  ]);

  index.add('ses_a', 'msg_1', 'nothing left about it', 1_000);
  assert.deepEqual(sessions(index, 'widgets'), []);
  assert.deepEqual(sessions(index, 'nothing left'), ['ses_a']);
  assert.deepEqual(sessions(index, 'canary'), ['ses_b']);
  index.close();
});

test('query tokens: short ones filter, accents and case fold, quotes and operators are literal', async () => {
  const index = await open('tokens');
  index.add('ses_db', 'msg_1', 'Migrate the db schema before deploy', 1_000);
  index.add('ses_api', 'msg_2', 'deploy the API gateway', 2_000);
  index.add('ses_cv', 'msg_3', 'Update the RÉSUMÉ template', 3_000);
  index.add('ses_quote', 'msg_4', 'the log said "NOT found" and -1 rows*', 4_000);

  for (const [query, expected] of [
    ['deploy', ['ses_api', 'ses_db']],
    ['deploy db', ['ses_db']],
    // Without a token of three or more characters the index is not consulted at all.
    ['db', []],
    ['resume', ['ses_cv']],
    ['"NOT found"', ['ses_quote']],
    ['-1 rows*', ['ses_quote']],
    ['NOT', ['ses_quote']],
    ['"unclosed', []]
  ] as const) {
    assert.deepEqual(sessions(index, query), expected, query);
  }
  index.close();
});

test('removing a session drops its entries and backfill progress, and the index survives reopening', async () => {
  const first = await open('remove');
  first.add('ses_gone', 'msg_1', 'flaky integration test', 1_000);
  first.add('ses_kept', 'msg_2', 'flaky integration test', 2_000);
  first.setBackfillState('ses_gone', { cursor: '1000', done: true });
  first.setBackfillState('ses_kept', { cursor: '2000', done: true });
  first.removeSession('ses_gone');
  first.close();

  const reopened = await open('remove');
  assert.deepEqual(sessions(reopened, 'flaky'), ['ses_kept']);
  assert.equal(reopened.backfillState('ses_gone'), undefined);
  assert.deepEqual(reopened.backfillState('ses_kept'), { cursor: '2000', done: true });
  reopened.close();
});

test('an index that cannot be opened is disabled instead of throwing', async () => {
  // A regular file where the data directory should be makes the database unopenable.
  await writeFile(path.join(root, 'blocked'), '');
  const index = await openBodyIndex(path.join(root, 'blocked', 'search.db'), () => {});
  assert.equal(index.enabled, false);
  index.add('ses_a', 'msg_1', 'some text', 1_000);
  assert.deepEqual(index.search('some text', { limit: 10 }), []);
});
