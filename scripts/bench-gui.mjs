// Times the Desktop browser's opens in the GUI test harness (test/gui/harness.mjs) against a fake
// server with the latencies measured on a real one, behind the app's four request slots per
// server: when the first rows show, when their ref lines do, and what the window asked for. Not
// part of `pnpm check`.
//
// Usage: bun --conditions=browser scripts/bench-gui.mjs [--bundle <dist/gui-experimental.cjs>]
// `--bundle` defaults to this checkout's build. Pass another checkout's to compare.

import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { createClient, createData, createServer, startGui, until } from '../test/gui/harness.mjs';

const { values } = parseArgs({ options: { bundle: { type: 'string' } } });

const NOW = Date.now();
const HOUR = 3_600_000;
const SESSIONS = 300;
// Milliseconds per call, from the DevTools trace of an open on a real server.
const LATENCY = {
  'session.list': 30,
  'rpc.refs': 150,
  'rpc.refresh': 1500,
  'rpc.done.facts': 30,
  'rpc.search': 50,
  'message.list': 80,
  sync: 100
};
// The app's request queue (packages/app/src/runtime/server/request-queue-machine.ts:4 at v2.4.2).
const SLOTS = 4;

const ref = (number) => ({
  provider: 'github',
  host: 'github.com',
  repo: 'acme/widgets',
  kind: 'pr',
  number
});
const key = (item) => `github:github.com/acme/widgets/pr/${item.number}`;
const sessions = Array.from({ length: SESSIONS }, (_, index) => ({
  id: `ses_${String(index).padStart(4, '0')}`,
  title: `Session ${index}`,
  projectID: 'proj',
  location: { directory: '/work/widgets' },
  time: { created: NOW - (index + 2) * HOUR, updated: NOW - (index + 1) * HOUR }
}));
/** Every other session tracks a pull request; every eighth one is merged, so Done asks about it. */
const viewOf = (index) => {
  if (index % 2 === 1) return { links: [], branchRefs: [], states: {} };
  const item = ref(1000 + index);
  const merged = index % 8 === 0;
  return {
    links: [{ ref: item, source: 'agent', linkedAt: 1 }],
    branchRefs: [],
    states: {
      [key(item)]: {
        status: merged ? 'merged' : 'open',
        title: `Pull ${index}`,
        url: 'https://github.com/acme/widgets/pull/1',
        ...(merged ? { mergedAt: NOW - HOUR / 2 } : {})
      }
    }
  };
};
const views = (ids) => Object.fromEntries(ids.map((id) => [id, viewOf(Number(id.slice(4)))]));

let active = 0;
let peak = 0;
const waiting = [];
/** Runs `answer` after the call's latency, in one of the server's request slots. */
async function slot(name, answer) {
  if (active >= SLOTS) await new Promise((resolve) => waiting.push(resolve));
  active++;
  peak = Math.max(peak, active);
  try {
    await sleep(LATENCY[name] ?? 20);
    return answer();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

const counted = new Map();
const handlers = Object.fromEntries(
  Object.entries({
    'session.get': ({ sessionID }) => sessions.find((item) => item.id === sessionID),
    'session.list': ({ archived }) => ({ data: archived ? [] : sessions }),
    'message.list': () => ({
      data: [{ id: 'msg_user', type: 'user', text: 'Prompt', time: { created: NOW - HOUR } }],
      cursor: {}
    }),
    'rpc.refs': ({ sessionIDs }) => views(sessionIDs),
    'rpc.refresh': ({ sessionIDs }) => views(sessionIDs),
    'rpc.done.facts': ({ sessionIDs }) =>
      Object.fromEntries(
        sessionIDs.map((id) => [id, { pending: false, lastUserMessageAt: NOW - HOUR }])
      ),
    'rpc.search': () => [],
    'rpc.pull.details': () => ({ checks: [] })
  }).map(([name, answer]) => [
    name,
    (input) => {
      counted.set(name, (counted.get(name) ?? 0) + 1);
      return slot(name, () => answer(input));
    }
  ])
);
const data = createData();
// The app's permission and form syncs are HTTP requests too.
for (const domain of [data.session.permission, data.session.form]) {
  domain.sync = () => {
    counted.set('permission/form sync', (counted.get('permission/form sync') ?? 0) + 1);
    return slot('sync', () => undefined);
  };
}
const server = createServer({ client: createClient(handlers), data });
const gui = await startGui({
  ...(values.bundle === undefined ? {} : { bundle: values.bundle }),
  session: {
    server,
    id: sessions[0].id,
    key: `${server.id}\n${sessions[0].id}`,
    directory: '/work/widgets'
  },
  servers: [server]
});

const first = () => document.querySelector('[role="listbox"] [data-session]');
const refLine = () => document.querySelector('[role="listbox"] [data-session] .ss-ref');
const doneCount = () => document.querySelector('[data-view="done"] .ss-tab-count')?.textContent;

/** Opens the browser and prints when the rows, their refs and Done showed. */
async function open(name) {
  counted.clear();
  peak = 0;
  const start = performance.now();
  await gui.command('browse').run();
  await until(first, 'the first row');
  const rows = performance.now() - start;
  await until(refLine, 'a ref line');
  const refs = performance.now() - start;
  await until(() => doneCount() === String(Math.ceil(SESSIONS / 8)), 'the Done count');
  const done = performance.now() - start;
  // What the open still asks for while it stays on screen.
  await sleep(3000);
  const calls = [...counted].map(([call, count]) => `${call} ${count}`).join(', ');
  console.log(
    `${name.padEnd(8)} rows ${rows.toFixed(0).padStart(5)} ms  refs ${refs.toFixed(0).padStart(5)} ms  done ${done.toFixed(0).padStart(5)} ms  peak slots ${peak}`
  );
  console.log(`         ${calls}`);
  document.querySelector('[role="dialog"] .ss-esc').click();
}

await open('cold');
await sleep(500);
await open('reopen');
gui.dispose();
process.exit(0);
