import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLimiter, run } from '../../src/process.js';

test('children run in the home directory and see gh credentials and stdin but not daemon secrets', async (t) => {
  process.env.SUPER_SESSIONS_TEST_SECRET = 'leak';
  process.env.GH_SUPER_SESSIONS_TEST = 'kept';
  // Only a call to an enterprise host gets this one; see enterpriseTokens.
  process.env.GH_ENTERPRISE_TOKEN = 'enterprise';
  t.after(() => {
    delete process.env.SUPER_SESSIONS_TEST_SECRET;
    delete process.env.GH_SUPER_SESSIONS_TEST;
    delete process.env.GH_ENTERPRISE_TOKEN;
  });

  // Windows looks a bare command name up in the working directory first, so a child started in
  // a project directory could run a binary the agent wrote there.
  const script = `
    let input = '';
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => {
      const env = process.env;
      console.log(JSON.stringify({
        input,
        cwd: require('node:fs').realpathSync(process.cwd()),
        secret: env.SUPER_SESSIONS_TEST_SECRET ?? null,
        enterprise: env.GH_ENTERPRISE_TOKEN ?? null,
        gh: env.GH_SUPER_SESSIONS_TEST ?? null,
        extra: env.GH_PROMPT_DISABLED ?? null
      }));
    });`;
  const result = await run(process.execPath, ['-e', script], {
    timeoutMs: 10_000,
    input: '{"query":"{ viewer { login } }"}',
    env: { GH_PROMPT_DISABLED: '1' }
  });

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    input: '{"query":"{ viewer { login } }"}',
    cwd: realpathSync(homedir()),
    secret: null,
    enterprise: null,
    gh: 'kept',
    extra: '1'
  });
});

test('a hung child is killed at the timeout instead of blocking the caller', async () => {
  const result = await run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 200
  });
  assert.equal(result.failure, 'timeout');
  assert.equal(result.code, null);
});

test('an executable that does not exist resolves as missing instead of throwing', async () => {
  const result = await run(join(import.meta.dirname, 'no-such-gh-binary'), ['--version'], {
    timeoutMs: 5000
  });
  assert.equal(result.failure, 'missing');
});

test('the limiter never runs more than its cap and still completes every task', async () => {
  const limit = createLimiter(2);
  let active = 0;
  let peak = 0;
  let done = 0;
  const releases: Array<() => void> = [];

  const tasks = Array.from({ length: 5 }, (_, index) =>
    limit(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      done++;
      return index;
    })
  );

  // Releases one running task per turn, so queued tasks only start when a slot frees up.
  while (done < tasks.length) {
    await new Promise((resolve) => setImmediate(resolve));
    releases.shift()?.();
  }

  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
});
