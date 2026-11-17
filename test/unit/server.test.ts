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
import { applySettings, createSettingsStore, serverDefaults } from '../../src/server/settings.js';
import { followGroups, registerTools } from '../../src/server/tools.js';
import { parseGroups } from '../../src/settings/definitions.js';

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

test('groups are unique names other than the built-in headers, in the order given', () => {
  assert.deepEqual(parseOptions({ groups: [' Coding ', 'Testing'] }).groups, ['Coding', 'Testing']);
  assert.equal(parseOptions(undefined).groupBy, 'day');
  for (const groups of [['Coding', 'Coding'], ['Running'], ['today'], [''], ['x'.repeat(41)]]) {
    assert.throws(() => parseOptions({ groups }), JSON.stringify(groups));
  }
  assert.throws(() => parseOptions({ groupBy: 'stage' }));
});

test('the Groups prompt reads names separated by commas, and refuses invalid ones', () => {
  assert.deepEqual(parseGroups(' Coding, Testing ,, PR open '), {
    groups: ['Coding', 'Testing', 'PR open']
  });
  assert.deepEqual(parseGroups('  '), { groups: [] });
  assert.ok('error' in parseGroups('Coding, Coding'));
  assert.ok('error' in parseGroups('Pinned'));
});

test('set_session_group follows the groups setting and moves the top-level session', async () => {
  type Tool = {
    name: string;
    input: { safeParse(value: unknown): { success: boolean } };
    execute(input: unknown, tool: { sessionID: string }): Promise<{ content: string }>;
  };
  type Stored = { time: typeof RAN; parentID?: string; metadata: Record<string, unknown> };
  const root: Stored = { time: RAN, metadata: { 'other-plugin': { keep: true } } };
  const child: Stored = { time: RAN, parentID: 'ses_root', metadata: {} };
  const sessions: Record<string, Stored> = { ses_root: root, ses_child: child };
  const session = {
    get: async ({ sessionID }: { sessionID: string }) => structuredClone(sessions[sessionID]),
    update: async (input: { sessionID: string; metadata: Record<string, unknown> }) => {
      const stored = sessions[input.sessionID];
      if (stored) stored.metadata = structuredClone(input.metadata);
    }
  };
  // Like the host: a reload runs every transform again on an empty tool list.
  let tools: Tool[] = [];
  const transforms: Array<(editor: unknown) => void> = [];
  const run = () => {
    tools = [];
    for (const edit of transforms) edit({ add: (tool: Tool) => tools.push(tool) });
  };
  let reloaded = () => {};
  const context = {
    session,
    tool: {
      transform: async (edit: (editor: unknown) => void) => {
        transforms.push(edit);
        run();
      },
      reload: async () => {
        run();
        reloaded();
      }
    }
  } as unknown as Plugin.Context;
  const base = parseOptions({});
  const settings = createSettingsStore(serverDefaults(base), () => {});
  const storage = { get: async () => undefined, set: async () => {} };
  const runtime = {
    get options() {
      return applySettings(base, settings.current());
    },
    settings,
    writes: createWriteQueue()
  } as unknown as Runtime;
  await registerTools(runtime, context);
  const stop = followGroups(runtime, context);
  /** Sets the groups as the settings dialog does, and waits for the tools to follow. */
  const setGroups = async (groups: string[]) => {
    const done = new Promise<void>((resolve) => {
      reloaded = resolve;
    });
    await settings.set(storage, { groups });
    await done;
  };
  const named = (name: string) => tools.find((item) => item.name === name);

  // No groups, so other agents never see the tool.
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['link_work', 'unlink_work']
  );
  await setGroups(['Coding', 'Testing']);
  const tool = named('set_session_group');
  assert.ok(tool);
  assert.equal(tool.input.safeParse({ group: 'Shipping' }).success, false);
  assert.equal(tool.input.safeParse({ group: null }).success, true);

  // A subagent's call moves the session the list shows: its parent.
  const moved = await tool.execute({ group: 'Testing' }, { sessionID: 'ses_child' });
  assert.equal(moved.content, 'Moved this session to Testing. Other groups: Coding.');
  assert.equal(readSessionRefs(root.metadata).group, 'Testing');
  assert.deepEqual(root.metadata['other-plugin'], { keep: true });
  assert.deepEqual(child.metadata, {});

  const out = await tool.execute({ group: null }, { sessionID: 'ses_root' });
  assert.equal(out.content, 'Moved this session out of Testing. Other groups: Coding, Testing.');
  assert.equal(readSessionRefs(root.metadata).group, undefined);

  // A turn that read the tool before the change still has the old choices.
  await setGroups(['Investigating']);
  const stale = await tool.execute({ group: 'Testing' }, { sessionID: 'ses_root' });
  assert.equal(stale.content, 'Not moved: Testing is no longer a group. Groups: Investigating.');
  assert.equal(readSessionRefs(root.metadata).group, undefined);
  assert.equal(named('set_session_group')?.input.safeParse({ group: 'Testing' }).success, false);

  await setGroups([]);
  assert.equal(named('set_session_group'), undefined);
  stop();
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
