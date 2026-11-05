import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { cp, mkdtemp, rm, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Plugin } from '@opencode/plugin';
import { parseOptions } from '../../src/config.js';
import type { ForgeProvider } from '../../src/providers/provider.js';
import { type RefLink, readSessionRefs } from '../../src/refs/ref.js';
import { mergeLinks } from '../../src/refs/store.js';
import { createEventHub, type EventContext, type HandledEvent } from '../../src/server/events.js';
import { createWriteQueue, type SessionAccess } from '../../src/server/queue.js';
import type { Runtime } from '../../src/server/runtime.js';

/** Yields to the event loop so concurrent fake calls interleave the way real I/O does. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A tracked link to `acme/widgets#number`. */
function link(number: number): RefLink {
  return {
    ref: { provider: 'github', host: 'github.com', repo: 'acme/widgets', kind: 'pr', number },
    source: 'agent',
    linkedAt: number
  };
}

test('the write queue keeps every concurrent link and foreign metadata, and survives a failed write', async () => {
  // Like the host: reads and writes are async and `update` replaces the whole metadata object.
  let metadata: Record<string, unknown> = { 'other-plugin': { keep: true } };
  const session = {
    get: async () => {
      await tick();
      return { metadata: structuredClone(metadata) };
    },
    update: async (input: { metadata?: Record<string, unknown> }) => {
      await tick();
      const written = readSessionRefs(input.metadata).links.map((stored) => stored.ref.number);
      if (written.includes(6)) throw new Error('database is locked');
      metadata = structuredClone(input.metadata ?? {});
    }
  } as unknown as SessionAccess;

  const queue = createWriteQueue();
  const add = (number: number) =>
    queue.update(session, 'ses_1', (refs) => mergeLinks(refs, [link(number)]));

  const [failed, ...rest] = [6, 1, 2, 3, 4, 5, 7, 8].map(add);
  await assert.rejects(failed ?? Promise.resolve(), /database is locked/);
  await Promise.all(rest);

  assert.deepEqual(metadata['other-plugin'], { keep: true });
  assert.deepEqual(
    readSessionRefs(metadata).links.map((stored) => stored.ref.number),
    [1, 2, 3, 4, 5, 7, 8]
  );
});

/** In-memory event bus whose subscriptions end when their signal aborts, like the host's. */
function fakeBus() {
  const subscribers = new Set<(event: HandledEvent | undefined) => void>();
  return {
    publish(event: HandledEvent) {
      for (const push of subscribers) push(event);
    },
    subscribe(signal: AbortSignal): AsyncIterable<HandledEvent> {
      const queue: HandledEvent[] = [];
      let wake: (() => void) | undefined;
      let done = false;
      const push = (event: HandledEvent | undefined) => {
        if (event === undefined) done = true;
        else queue.push(event);
        wake?.();
      };
      subscribers.add(push);
      signal.addEventListener('abort', () => {
        subscribers.delete(push);
        push(undefined);
      });
      return {
        async *[Symbol.asyncIterator]() {
          while (true) {
            const event = queue.shift();
            if (event !== undefined) {
              yield event;
              continue;
            }
            if (done) return;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        }
      };
    }
  };
}

test('the write queue never overwrites a stored value it cannot read, such as a newer schema', async () => {
  const newer = { v: 2, links: [{ future: true }], dismissed: [] };
  const writes: unknown[] = [];
  const session = {
    get: async () => ({ metadata: { 'super-sessions': newer } }),
    update: async (input: { metadata?: Record<string, unknown> }) => {
      writes.push(input.metadata);
    }
  } as unknown as SessionAccess;
  const queue = createWriteQueue();
  await assert.rejects(queue.update(session, 'ses_1', (refs) => mergeLinks(refs, [link(1)])));
  assert.deepEqual(writes, []);

  // A session without the key is a first write, not an unreadable one.
  const fresh = { ...session, get: async () => ({ metadata: {} }) } as unknown as SessionAccess;
  await queue.update(fresh, 'ses_2', (refs) => mergeLinks(refs, [link(1)]));
  assert.equal(writes.length, 1);
});

test('every copy of the plugin module gets the one sweeper of the shared runtime', async () => {
  // The daemon loads a local-path plugin once per Location, each a module of its own; a query
  // string gives the same file a new module instance the same way.
  type SweepModule = typeof import('../../src/server/sweep.js');
  const path = '../../src/server/sweep.js';
  const first: SweepModule = await import(`${path}?location=a`);
  const second: SweepModule = await import(`${path}?location=b`);
  assert.notEqual(first.getSweeper, second.getSweeper);
  const runtime = {} as Runtime;
  assert.equal(first.getSweeper(runtime), second.getSweeper(runtime));
});

test('a new build of the plugin takes the runtime over instead of reading the old caches', async (t) => {
  // A rebuild loads the code again in a running daemon while Locations that have not reloaded
  // keep the old module. This replays it on a copy of dist/: each Location imports the file
  // under its own query, like the host's Node loader, and the rebuild writes the file again.
  type RuntimeModule = typeof import('../../src/server/runtime.js');
  type SweepModule = typeof import('../../src/server/sweep.js');
  const root = await mkdtemp(join(realpathSync.native(tmpdir()), 'opencode-super-sessions-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = fileURLToPath(new URL('../../', import.meta.url));
  await cp(join(project, 'dist'), join(root, 'dist'), {
    recursive: true,
    filter: (source) => !source.endsWith('.d.ts')
  });
  // So the copy loads as ES modules and resolves its dependencies. A junction needs no privilege
  // on Windows.
  await cp(join(project, 'package.json'), join(root, 'package.json'));
  await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'junction');
  const runtimeFile = join(root, 'dist', 'server', 'runtime.js');
  /** Imports the copied runtime module the way a Location named `name` would. */
  const load = (name: string): Promise<RuntimeModule> =>
    import(`${pathToFileURL(runtimeFile).href}?location=${name}`);
  const { getSweeper }: SweepModule = await import(
    pathToFileURL(join(root, 'dist', 'server', 'sweep.js')).href
  );
  const older = await load('a');
  const sameBuild = await load('b');
  await utimes(runtimeFile, new Date(), new Date(2000, 0, 1));
  const newer = await load('c');
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());

  const bus = fakeBus();
  const subscriptions: Array<{ name: string; signal: AbortSignal }> = [];
  const listed: string[] = [];
  /** A Location whose subscriptions and sweeps are recorded under `name`. */
  const location = (name: string) =>
    ({
      event: {
        subscribe: ({ signal }: { signal: AbortSignal }) => {
          subscriptions.push({ name, signal });
          return bus.subscribe(signal);
        }
      },
      session: {
        // The first read of a sweep. It never answers, so the sweep stops here.
        list: () => {
          listed.push(name);
          return new Promise(() => {});
        }
      },
      storage: { get: async () => undefined, set: async () => {} }
    }) as unknown as Plugin.Context;
  const subscribed = () =>
    subscriptions.filter((entry) => !entry.signal.aborted).map((entry) => entry.name);
  /** Attaches `context` to the runtime's subscriber and sweeper, like the plugin's setup. */
  const attach = (runtime: Runtime, context: Plugin.Context) => {
    runtime.events.attach(context);
    getSweeper(runtime).attach(context, async () => {});
  };
  // A cleanup rule is on, so a sweep reads sessions.
  const options = parseOptions({ search: { body: false }, cleanup: { deletedSessions: true } });
  const handle = async () => {};

  const first = older.getRuntime(options, handle);
  attach(first, location('older'));
  assert.equal(sameBuild.getRuntime(options, handle), first);
  // Another build may store another shape here, as a8e637b did when branch entries gained
  // `createdAt`, so nothing the old build cached may reach the new one.
  const repo = { provider: 'github', host: 'github.com', repo: 'acme/app' } as const;
  const target = { repo, branch: 'feat' };
  const pull = { ref: { ...repo, kind: 'pr', number: 7 }, createdAt: 0 };
  await first.branches.ensure(
    { branchPullRequests: async () => [pull] } as unknown as ForgeProvider,
    target
  );
  assert.equal(first.branches.get(target)?.length, 1);

  const second = newer.getRuntime(options, handle);
  t.after(() => second.dispose());
  attach(second, location('newer'));
  assert.notEqual(second, first);
  assert.equal(second.branches.get(target), undefined);
  assert.deepEqual(subscribed(), ['newer']);

  // Past the first sweep and the timed one: only the new build's sweeper runs.
  mock.timers.tick(10 * 60_000);
  await tick();
  assert.deepEqual(listed, ['newer']);

  // The old module set up again, as the host does when the new one fails in a Location.
  const fallback = older.getRuntime(options, handle);
  attach(fallback, location('older'));
  assert.equal(newer.getRuntime(options, handle), second);
  assert.deepEqual(subscribed(), ['newer']);
});

test('one subscriber handles each event once across Locations, including after a handover', async () => {
  const bus = fakeBus();
  const handled: Array<[string, string]> = [];
  const waiters = new Map<string, () => void>();
  const names = new Map<EventContext, string>();
  const location = (name: string) => {
    const context = {
      event: { subscribe: (options: { signal: AbortSignal }) => bus.subscribe(options.signal) }
    } as unknown as EventContext;
    names.set(context, name);
    return context;
  };
  const hub = createEventHub({
    handle: async (event, context) => {
      handled.push([event.id, names.get(context) ?? '']);
      waiters.get(event.id)?.();
    },
    onError: (error) => assert.fail(String(error))
  });
  const event = (id: string) =>
    ({ id, type: 'session.text.ended', data: { sessionID: 'ses_1', text: '' } }) as HandledEvent;
  /** Publishes events and waits until the last one was handled. */
  const deliver = async (...ids: string[]) => {
    const last = ids.at(-1) ?? '';
    const handledLast = new Promise<void>((resolve) => waiters.set(last, resolve));
    for (const id of ids) bus.publish(event(id));
    await handledLast;
  };

  const detachA = hub.attach(location('a'));
  hub.attach(location('b'));
  await deliver('e1');
  detachA();
  // The new owner's stream may replay an event the old one delivered.
  await deliver('e1', 'e2');

  assert.deepEqual(handled, [
    ['e1', 'a'],
    ['e2', 'b']
  ]);
});
