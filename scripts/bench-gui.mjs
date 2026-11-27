// Times the Desktop browser's opens in the GUI test harness (test/gui/harness.mjs) against a fake
// server with the latencies measured on a real one, behind the app's four request slots per
// server: when the first rows show, when their ref lines do, and what the window asked for. The
// warm open times the synchronous mount of the dialog over cached lists, the task the window
// spends before it can paint, and counts the elements it adds, which the window then styles and
// lays out in that same task. Not part of `pnpm check`.
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
const SESSIONS = 400;
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
// The synced projects a row's avatar looks up, as many as a busy machine has.
data.project = {
  list: () =>
    Array.from({ length: 30 }, (_, index) => ({
      id: index === 0 ? 'proj' : `proj_${index}`,
      name: index === 0 ? 'widgets' : `project ${index}`,
      canonical: index === 0 ? '/work/widgets' : `/work/project-${index}`
    }))
};
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
  servers: [server],
  // Every project, where each row draws its project's avatar.
  stores: { browser: { rail: 'all' } }
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

/**
 * Opens the browser over lists the model already holds, as a second open within 30 seconds
 * does, and prints the median synchronous mount time over `count` opens, the rows and elements
 * it mounted, and the rows mounted once the window was idle for a second.
 */
async function warm(count) {
  const dialog = () => document.querySelector('[role="dialog"]');
  const times = [];
  let rows = 0;
  let elements = 0;
  for (let index = 0; index < count; index++) {
    const start = performance.now();
    gui.command('browse').run();
    times.push(performance.now() - start);
    rows = document.querySelectorAll('[role="listbox"] [data-session]').length;
    elements = dialog()?.querySelectorAll('*').length ?? 0;
    await sleep(index === count - 1 ? 1000 : 200);
    if (index < count - 1) dialog().querySelector('.ss-esc').click();
  }
  const idle = document.querySelectorAll('[role="listbox"] [data-session]').length;
  dialog().querySelector('.ss-esc').click();
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  console.log(
    `warm     open ${median.toFixed(1).padStart(6)} ms  rows ${rows}  elements ${elements}  rows after 1 s idle ${idle}  (${count} opens, ${SESSIONS} sessions)`
  );
}

/** The routed session, settable for the side tab's route switches. */
function routeRef(id) {
  return { server, id, key: `${server.id}\n${id}`, directory: '/work/widgets' };
}

/**
 * Shows the side tab and routes from one session to the next, as a click on a session tab does,
 * and prints how long the window's synchronous update of each switch took: the route signal and
 * every effect it ran, in the same task.
 */
async function switches(count) {
  const { createSignal } = await import('solid-js');
  const [routed, setRouted] = createSignal(routeRef(sessions[0].id));
  const SIDE = `${gui.ctx.id}:sessions`;
  gui.ctx.layout.open(SIDE, routed());
  gui.panel('sessions', routed);
  await until(() => document.querySelectorAll('.ss-side [data-session]').length > 20, 'side rows');
  await sleep(1000);
  counted.clear();
  const times = [];
  for (let index = 1; index <= count; index++) {
    const next = routeRef(sessions[index % 40].id);
    // The tab shows in the next session already, as it does once it was open there.
    gui.ctx.layout.open(SIDE, next);
    const start = performance.now();
    setRouted(next);
    times.push(performance.now() - start);
    await sleep(50);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const calls = [...counted].map(([call, total]) => `${call} ${total}`).join(', ') || 'none';
  console.log(
    `switch   median ${median.toFixed(1).padStart(6)} ms  max ${times.at(-1).toFixed(1).padStart(6)} ms  (${count} switches)`
  );
  console.log(`         ${calls}`);
}

await open('cold');
await sleep(500);
await open('reopen');
await sleep(500);
await warm(10);
await switches(20);
gui.dispose();
process.exit(0);
