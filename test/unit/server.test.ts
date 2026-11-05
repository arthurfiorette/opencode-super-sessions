import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type RefLink, readSessionRefs } from '../../src/refs/ref.js';
import { mergeLinks } from '../../src/refs/store.js';
import { createEventHub, type EventContext, type HandledEvent } from '../../src/server/events.js';
import { createWriteQueue, type SessionAccess } from '../../src/server/queue.js';
import type { Runtime } from '../../src/server/runtime.js';

/** Yields to the event loop so concurrent fake calls interleave the way real I/O does. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Host times of a session that ran, so writes add no `activeAt` stamp. */
const RAN = { created: 0, updated: 0, idle: 0 };

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
      return { metadata: structuredClone(metadata), time: RAN };
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
    get: async () => ({ metadata: { 'super-sessions': newer }, time: RAN }),
    update: async (input: { metadata?: Record<string, unknown> }) => {
      writes.push(input.metadata);
    }
  } as unknown as SessionAccess;
  const queue = createWriteQueue();
  await assert.rejects(queue.update(session, 'ses_1', (refs) => mergeLinks(refs, [link(1)])));
  assert.deepEqual(writes, []);

  // A session without the key is a first write, not an unreadable one.
  const fresh = {
    ...session,
    get: async () => ({ metadata: {}, time: RAN })
  } as unknown as SessionAccess;
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
