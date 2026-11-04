import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type RefLink, readSessionRefs } from '../../src/refs/ref.js';
import { mergeLinks } from '../../src/refs/store.js';
import { createEventHub, type EventContext, type HandledEvent } from '../../src/server/events.js';
import { createWriteQueue, type SessionAccess } from '../../src/server/queue.js';

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
