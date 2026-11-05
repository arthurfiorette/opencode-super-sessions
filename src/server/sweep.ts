import type { SessionInfo } from '@opencode/client';
import type { Plugin } from '@opencode/plugin';
import type { RpcHandlers, RpcRegistration } from '@opencode/plugin/promise/rpc';
import { lastUserMessageAt } from '../host/events.js';
import { isBusy } from '../host/session-api.js';
import { projectWorktrees, removeWorktree } from '../host/worktree.js';
import { doneAt, isDone } from '../refs/summary.js';
import type { SessionRefView, SuperSessions, WorktreeDecision } from '../rpc.js';
import { type ArchiveFacts, createArchiveQueue, isArchiveDue } from './auto-archive.js';
import {
  assignSessions,
  cleanupEnabled,
  decideWorktree,
  defaultBranchRef,
  mergedHeads,
  mergedPull,
  readPullHead,
  readWorktreeGit,
  type WorktreeFacts,
  type WorktreeSession
} from './cleanup.js';
import type { LifecycleEvent } from './events.js';
import { resolveRepo } from './links.js';
import type { Runtime } from './runtime.js';
import { warn } from './runtime.js';
import { collectViews } from './views.js';

// Auto-archive and worktree cleanup sweeps: on daemon start, every 10 minutes, and soon after a
// session finishes, is deleted, or a tracked pull request merges. One sweep runs at a time, and
// the dry run and "Run cleanup now" queue behind it, so two removals never race.

const SWEEP_INTERVAL = 10 * 60_000;
const START_DELAY = 5000;
// Lifecycle events come in bursts (a run ends, a subagent ends); one sweep covers the burst.
const TRIGGER_DELAY = 5000;
// A TUI reports every 5 minutes; three missed reports mean it is gone.
const PRESENCE_TTL = 15 * 60_000;
const MAX_SESSIONS = 10_000;
const VIEW_BATCH = 50;
const EXCLUDED_LIMIT = 5000;

/** Emits RPC events to TUIs through one Location's registration. */
export type Emit = RpcRegistration<typeof SuperSessions>['events']['emit'];

/** A Location the sweeper can work through. */
interface Live {
  context: Plugin.Context;
  emit: Emit;
}

/** Cleanup state persisted in the plugin's key-value storage. */
interface CleanupState {
  /** The user confirmed a removal once; sweeps remove on their own from then on. */
  confirmed: boolean;
  /** Worktrees whose sessions were deleted while the plugin ran. */
  orphaned: string[];
  /** Sessions last seen in a worktree, so a deletion can be traced to its worktree. */
  sessions: Record<string, string>;
  /** Projects that had linked worktrees at the last sweep. */
  projects: string[];
}

/** Process-wide auto-archive and cleanup scheduler. */
export interface Sweeper {
  /** Adds a Location. The first live one runs sweeps and emits events. Returns the detach. */
  attach(context: Plugin.Context, emit: Emit): () => void;
  presence(clientID: string, pinned: readonly string[], open: readonly string[]): void;
  claim(clientID: string): Array<{ sessionID: string; title: string }>;
  report(archived: readonly string[], skipped: readonly string[]): void;
  exclude(sessionIDs: readonly string[]): Promise<void>;
  plan(): Promise<{ confirmed: boolean; worktrees: WorktreeDecision[] }>;
  run(directories: readonly string[]): Promise<{
    removed: string[];
    kept: Array<{ directory: string; reason: string }>;
  }>;
  /** Runs a sweep soon, coalescing with any already scheduled. */
  schedule(delay?: number): void;
  /** Stops the timers and drops every Location, for a disposed runtime. */
  dispose(): void;
}

/**
 * The sweeper of `runtime`, created on first use and hooked into its events. It lives on the
 * runtime, not in module state: a local-path plugin loads as one module per Location, and each
 * module's own sweeper would sweep and remove in parallel.
 */
export function getSweeper(runtime: Runtime): Sweeper {
  runtime.sweeper ??= createSweeper(runtime);
  return runtime.sweeper;
}

/** RPC handlers for auto-archive and cleanup, backed by the process-wide sweeper. */
export function maintenanceHandlers(
  runtime: Runtime
): Pick<
  RpcHandlers<typeof SuperSessions>,
  | 'presence'
  | 'archive.claim'
  | 'archive.report'
  | 'archive.exclude'
  | 'cleanup.plan'
  | 'cleanup.run'
> {
  const sweeper = getSweeper(runtime);
  return {
    async presence({ clientID, pinned, open }) {
      sweeper.presence(clientID, pinned, open);
      return {};
    },
    'archive.claim': async ({ clientID }) => ({ sessions: sweeper.claim(clientID) }),
    async 'archive.report'({ archived, skipped }) {
      sweeper.report(archived, skipped);
      return {};
    },
    async 'archive.exclude'({ sessionIDs }) {
      await sweeper.exclude(sessionIDs);
      return {};
    },
    'cleanup.plan': () => sweeper.plan(),
    'cleanup.run': ({ directories }) => sweeper.run(directories)
  };
}

/** Writes an info line to the daemon log, prefixed with the plugin id. */
function log(message: string): void {
  console.info(`[opencode-super-sessions] ${message}`);
}

/** Creates the sweeper. Nothing runs until a Location attaches. */
function createSweeper(runtime: Runtime): Sweeper {
  const live: Live[] = [];
  const queue = createArchiveQueue();
  const presence = new Map<string, { pinned: string[]; open: string[]; at: number }>();
  let state: CleanupState | undefined;
  let excluded: Set<string> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  let interval: NodeJS.Timeout | undefined;
  let sweeping = false;
  // The worktree list of the last confirmation request, so each TUI is asked once per list.
  let asked: string | undefined;

  /** The Location that sweeps and emits: the first one still attached. */
  const owner = () => live[0];

  /** Runs `task` after every queued sweep, dry run and removal. */
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  };

  /** Live TUI reports, pruning those past their TTL. */
  const reports = (now: number) => {
    for (const [id, entry] of presence) if (now - entry.at > PRESENCE_TTL) presence.delete(id);
    return [...presence.values()];
  };

  /** The cleanup state, read from storage once per process. An unreadable value starts empty. */
  const loadState = async (context: Plugin.Context): Promise<CleanupState> => {
    if (state !== undefined) return state;
    const stored = await context.storage.get('cleanup').catch(() => undefined);
    state = readCleanupState(stored);
    return state;
  };
  /** Writes the cleanup state back. Never rejects; a failed write only logs. */
  const saveState = (context: Plugin.Context) =>
    state === undefined
      ? Promise.resolve()
      : context.storage
          .set('cleanup', state as unknown as Parameters<Plugin.Context['storage']['set']>[1])
          .catch((error: unknown) => warn('Saving cleanup state failed', error));
  /** Sessions the user restored from auto-archive, read from storage once per process. */
  const loadExcluded = async (context: Plugin.Context) => {
    if (excluded !== undefined) return excluded;
    const stored = await context.storage.get('archive-excluded').catch(() => undefined);
    excluded = new Set(
      Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []
    );
    return excluded;
  };

  /** One automatic sweep: queue due archives, then remove or ask about worktrees. */
  const sweep = async () => {
    const current = owner();
    if (current === undefined) return;
    const settings = runtime.settings.current();
    const now = Date.now();
    // Archiving needs a TUI, so without one there is no point fetching ref states for it.
    const archiving = settings.autoArchiveDays !== null && reports(now).length > 0;
    const cleaning = cleanupEnabled(settings);
    if (!archiving) queue.replace([]);
    if (!archiving && !cleaning) return;
    sweeping = true;
    try {
      const gathered = await gather(current.context, { archiving, cleaning }, now);
      if (archiving) {
        const count = queue.replace(gathered.due);
        if (count > 0) await current.emit('archive.due', { count });
      }
      if (!cleaning) return;
      const removals = gathered.decisions.filter((decision) => decision.action === 'remove');
      if (removals.length === 0) return;
      const cleanup = await loadState(current.context);
      if (!cleanup.confirmed) {
        // Removal has no undo, so the first one waits for the user to see the list.
        const key = removals.map((decision) => decision.directory).join('\n');
        if (key === asked) return;
        asked = key;
        await current.emit('cleanup.confirm', { worktrees: removals });
        return;
      }
      const { removed } = await removeAll(current.context, gathered, removals);
      if (removed.length > 0) await current.emit('cleanup.removed', { directories: removed });
    } finally {
      sweeping = false;
    }
  };

  /**
   * Reads sessions, ref states and worktrees, and decides. `archiving` adds the auto-archive due
   * list; `cleaning` adds the worktree decisions.
   */
  const gather = async (
    context: Plugin.Context,
    want: { archiving: boolean; cleaning: boolean },
    now: number
  ) => {
    const settings = runtime.settings.current();
    const sessions = await listSessions(context);
    const byID = new Map(sessions.map((info) => [info.id, info]));
    /** The top-level session `id` belongs to, following parent links. */
    const rootOf = (id: string) => {
      let info = byID.get(id);
      // Bounded: a malformed parent chain must not loop forever.
      for (let depth = 0; info?.parentID !== undefined && depth < 50; depth++) {
        const parent = byID.get(info.parentID);
        if (parent === undefined) break;
        info = parent;
      }
      return info?.id ?? id;
    };
    const running = new Set(sessions.filter(isBusy).map((info) => rootOf(info.id)));
    const roots = sessions.filter((info) => info.parentID === undefined);
    const clients = reports(now);
    const pinned = new Set(clients.flatMap((entry) => entry.pinned));
    const open = new Set(clients.flatMap((entry) => entry.open.map(rootOf)));

    // The plugin cannot list projects. Sessions name most of them; open Locations and projects
    // seen before cover those whose sessions were all deleted.
    const remembered = want.cleaning ? (await loadState(context)).projects : [];
    const projects = [
      ...new Set([
        ...roots.map((info) => info.projectID),
        ...live.map((entry) => entry.context.location.project.id),
        ...remembered
      ])
    ].filter((id) => id !== 'global');
    const worktrees = want.cleaning ? await listWorktrees(runtime, context, projects) : [];
    const owners = await assignSessions(
      roots.map((info) => ({ id: info.id, directory: info.location.directory })),
      worktrees.map((worktree) => worktree.directory)
    );

    // Done needs forge state; only sessions a decision reads pay for it. The main checkout is
    // always kept, so its sessions are left out.
    const doneFor = new Set<string>();
    if (want.archiving) {
      for (const info of roots) if (info.time.archived === undefined) doneFor.add(info.id);
    }
    for (const worktree of worktrees) {
      if (worktree.root) continue;
      for (const id of owners.get(worktree.directory) ?? []) doneFor.add(id);
    }
    const done = await doneFacts(context, [...doneFor], running);

    const due: Array<{ sessionID: string; title: string }> = [];
    if (want.archiving) {
      const skip = await loadExcluded(context);
      for (const info of roots) {
        const fact = done.get(info.id);
        const facts: ArchiveFacts = {
          sessionID: info.id,
          title: info.title ?? '',
          archived: info.time.archived !== undefined,
          running: running.has(info.id),
          pending: fact?.pending ?? false,
          pinned: pinned.has(info.id),
          excluded: skip.has(info.id),
          done: fact?.done ?? false,
          doneAt: fact?.doneAt
        };
        if (isArchiveDue(facts, settings.autoArchiveDays, now)) {
          due.push({ sessionID: info.id, title: facts.title });
        }
      }
    }

    const decisions: WorktreeDecision[] = [];
    const facts = new Map<string, Gathered>();
    if (want.cleaning) {
      const cleanup = await loadState(context);
      // Remember where sessions live now, so a later deletion maps to its worktree.
      const seen: Record<string, string> = {};
      for (const [directory, ids] of owners) {
        const worktree = worktrees.find((entry) => entry.directory === directory);
        if (worktree?.root === false) for (const id of ids) seen[id] = directory;
      }
      const known = new Set(worktrees.map((entry) => entry.directory));
      cleanup.sessions = seen;
      cleanup.orphaned = cleanup.orphaned.filter((directory) => known.has(directory));
      // Only projects that still have linked worktrees need remembering.
      cleanup.projects = [
        ...new Set(worktrees.filter((entry) => !entry.root).map((entry) => entry.projectID))
      ];
      await saveState(context);

      for (const worktree of worktrees) {
        const ids = owners.get(worktree.directory) ?? [];
        const git = worktree.root ? {} : await readWorktreeGit(worktree.directory, worktree.base);
        // The checkout's view: a pull request on this branch decides for the worktree whichever
        // of its sessions opened it.
        const views = ids.flatMap((id) => {
          const view = done.get(id)?.checkout;
          return view === undefined ? [] : [view];
        });
        const merged = mergedPull(views);
        // Only worth the git calls when a plain merge does not already explain the branch.
        const head =
          merged && !worktree.root && git.contained !== true
            ? await readPullHead(worktree.directory, mergedHeads(views))
            : undefined;
        // Read for every session here, not only the Done candidates `doneFacts` checked: the
        // inactive rule removes worktrees of sessions that are not Done.
        const waiting = worktree.root
          ? []
          : await Promise.all(
              ids.map(
                async (id) => done.get(id)?.pending || (await hasPending(runtime, context, id))
              )
            );
        const fact: WorktreeFacts = {
          directory: worktree.directory,
          root: worktree.root,
          deleted: cleanup.orphaned.includes(worktree.directory),
          sessions: ids.map((id, index): WorktreeSession => {
            const info = byID.get(id);
            const session = done.get(id);
            return {
              id,
              archived: info?.time.archived !== undefined,
              done: session?.done ?? false,
              doneAt: session?.doneAt,
              updated: info?.time.updated ?? now,
              running: running.has(id),
              pending: waiting[index] ?? false,
              open: open.has(id),
              pinned: pinned.has(id)
            };
          }),
          changed: git.changed,
          ahead: git.ahead,
          merged,
          contained: git.contained,
          referenced: git.referenced,
          head
        };
        facts.set(worktree.directory, {
          projectID: worktree.projectID,
          ...(worktree.base === undefined ? {} : { base: worktree.base }),
          facts: fact
        });
        decisions.push(decideWorktree(fact, settings, now));
      }
    }
    return { due, decisions, facts };
  };

  /** Ref views, Done and pending state of top-level sessions, in batches. */
  const doneFacts = async (context: Plugin.Context, ids: string[], running: Set<string>) => {
    const result = new Map<
      string,
      {
        view: SessionRefView;
        checkout: SessionRefView;
        done: boolean;
        doneAt?: number;
        pending: boolean;
      }
    >();
    for (let start = 0; start < ids.length; start += VIEW_BATCH) {
      const batch = ids.slice(start, start + VIEW_BATCH);
      const views = await collectViews(runtime, context.session, batch, { wait: true });
      for (const [id, { view, checkout }] of Object.entries(views)) {
        const base = { running: running.has(id), archived: false, view };
        // Cheap check first; only possible Done sessions pay for the pending and message reads.
        if (!isDone({ ...base, pending: false })) {
          result.set(id, { view, checkout, done: false, pending: false });
          continue;
        }
        const pending = await hasPending(runtime, context, id);
        // The user's mark decides on its own, so it needs no message read.
        const last = view.done === undefined ? await lastMessage(context, id) : undefined;
        const done = isDone({ ...base, pending, lastUserMessageAt: last });
        const at = doneAt(view);
        result.set(id, {
          view,
          checkout,
          done,
          pending,
          ...(at === undefined ? {} : { doneAt: at })
        });
      }
    }
    return result;
  };

  /**
   * The facts of a worktree read again right before its removal. The sweep read them seconds or
   * minutes earlier, and since then the agent may have written or committed, a session may have
   * started, resumed or asked a question there, and a TUI may have opened or pinned one. A
   * session the sweep did not see counts as active, so it keeps the worktree.
   */
  const freshFacts = async (context: Plugin.Context, entry: Gathered): Promise<WorktreeFacts> => {
    const clients = reports(Date.now());
    const pinned = new Set(clients.flatMap((client) => client.pinned));
    const open = new Set(clients.flatMap((client) => client.open));
    const known = new Map(entry.facts.sessions.map((session) => [session.id, session]));
    const listed = await context.session.list({
      directory: entry.facts.directory,
      parentID: null,
      limit: 200
    });
    const ids = [...new Set([...known.keys(), ...listed.data.map((info) => info.id)])];
    const sessions = await Promise.all(
      ids.map(async (id): Promise<WorktreeSession> => {
        const info = await context.session.get({ sessionID: id });
        return {
          ...(known.get(id) ?? { id, done: false }),
          archived: info.time.archived !== undefined,
          updated: info.time.updated,
          running: isBusy(info),
          pending: await hasPending(runtime, context, id),
          open: open.has(id),
          pinned: pinned.has(id)
        };
      })
    );
    const git = await readWorktreeGit(entry.facts.directory, entry.base);
    return {
      ...entry.facts,
      sessions,
      changed: git.changed,
      ahead: git.ahead,
      contained: git.contained,
      referenced: git.referenced
    };
  };

  /** Removes worktrees the decision selected, deciding each one again on {@link freshFacts}. */
  const removeAll = async (
    context: Plugin.Context,
    gathered: { facts: Map<string, Gathered> },
    removals: WorktreeDecision[]
  ) => {
    const settings = runtime.settings.current();
    const removed: string[] = [];
    const kept: Array<{ directory: string; reason: string }> = [];
    for (const decision of removals) {
      const entry = gathered.facts.get(decision.directory);
      // A newer build's sweeper took over mid-run; removing alongside it would race.
      if (runtime.disposed) {
        kept.push({
          directory: decision.directory,
          reason: 'a newer build of the plugin took over'
        });
        continue;
      }
      if (entry === undefined) {
        kept.push({ directory: decision.directory, reason: 'not a worktree OpenCode knows' });
        continue;
      }
      let recheck: WorktreeDecision;
      try {
        recheck = decideWorktree(await freshFacts(context, entry), settings, Date.now());
      } catch (error) {
        warn(`Checking worktree ${decision.directory} again failed`, error);
        kept.push({
          directory: decision.directory,
          reason: 'its sessions could not be read again'
        });
        continue;
      }
      if (recheck.action !== 'remove') {
        kept.push({ directory: decision.directory, reason: recheck.reason });
        continue;
      }
      try {
        await removeWorktree(context, entry.projectID, decision.directory);
        removed.push(decision.directory);
        log(`Removed worktree ${decision.directory} (${decision.reason})`);
      } catch (error) {
        warn(`Removing worktree ${decision.directory} failed`, error);
        kept.push({ directory: decision.directory, reason: 'git refused to remove it' });
      }
    }
    if (removed.length > 0 && state !== undefined) {
      const gone = new Set(removed);
      state.orphaned = state.orphaned.filter((directory) => !gone.has(directory));
      await saveState(context);
    }
    return { removed, kept };
  };

  const sweeper: Sweeper = {
    attach(context, emit) {
      // A disposed runtime's sweeper may be created after the dispose, on its first use.
      if (runtime.disposed) return () => {};
      const entry = { context, emit };
      live.push(entry);
      if (live.length === 1) {
        void runtime.settings.load(context.storage);
        sweeper.schedule(START_DELAY);
        interval ??= setInterval(() => sweeper.schedule(0), SWEEP_INTERVAL);
        interval.unref?.();
      }
      return () => {
        const index = live.indexOf(entry);
        if (index !== -1) live.splice(index, 1);
        if (live.length > 0) return;
        clearTimeout(timer);
        clearInterval(interval);
        timer = undefined;
        interval = undefined;
      };
    },
    presence(clientID, pinned, open) {
      const first = presence.size === 0;
      presence.set(clientID, { pinned: [...pinned], open: [...open], at: Date.now() });
      // The first TUI to appear may be the first chance to archive anything.
      if (first && runtime.settings.current().autoArchiveDays !== null) sweeper.schedule();
    },
    claim: (clientID) => queue.claim(clientID, Date.now()),
    report(archived, skipped) {
      queue.report([...archived, ...skipped]);
      for (const id of archived) log(`Archived session ${id} (Done)`);
    },
    async exclude(sessionIDs) {
      const context = owner()?.context;
      if (context === undefined) return;
      const set = await loadExcluded(context);
      for (const id of sessionIDs) set.add(id);
      // Oldest first in insertion order; dropping them only lets old sessions be archived again.
      const list = [...set].slice(-EXCLUDED_LIMIT);
      excluded = new Set(list);
      await context.storage.set('archive-excluded', list);
    },
    plan: () =>
      exclusive(async () => {
        const current = owner();
        if (current === undefined) return { confirmed: false, worktrees: [] };
        const cleanup = await loadState(current.context);
        if (!cleanupEnabled(runtime.settings.current())) {
          return { confirmed: cleanup.confirmed, worktrees: [] };
        }
        const gathered = await gather(
          current.context,
          { archiving: false, cleaning: true },
          Date.now()
        );
        return { confirmed: cleanup.confirmed, worktrees: sortDecisions(gathered.decisions) };
      }),
    run: (directories) =>
      exclusive(async () => {
        const current = owner();
        if (current === undefined) {
          return {
            removed: [],
            kept: directories.map((directory) => ({ directory, reason: 'the server is closing' }))
          };
        }
        const gathered = await gather(
          current.context,
          { archiving: false, cleaning: true },
          Date.now()
        );
        const wanted = new Set(directories);
        const decisions = gathered.decisions.filter((decision) => wanted.has(decision.directory));
        const kept = [...wanted]
          .filter((directory) => !decisions.some((decision) => decision.directory === directory))
          .map((directory) => ({ directory, reason: 'not a worktree OpenCode knows' }));
        for (const decision of decisions) {
          if (decision.action === 'keep')
            kept.push({ directory: decision.directory, reason: decision.reason });
        }
        const cleanup = await loadState(current.context);
        if (directories.length > 0 && !cleanup.confirmed) {
          cleanup.confirmed = true;
          await saveState(current.context);
        }
        const result = await removeAll(
          current.context,
          gathered,
          decisions.filter((decision) => decision.action === 'remove')
        );
        return { removed: result.removed, kept: [...kept, ...result.kept] };
      }),
    schedule(delay = TRIGGER_DELAY) {
      if (timer !== undefined || runtime.disposed) return;
      timer = setTimeout(() => {
        timer = undefined;
        exclusive(sweep).catch((error: unknown) => warn('Sweep failed', error));
      }, delay);
      timer.unref?.();
    },
    dispose() {
      live.length = 0;
      clearTimeout(timer);
      clearInterval(interval);
      timer = undefined;
      interval = undefined;
    }
  };

  // Merges found by the sweep's own refresh would only schedule the same sweep again.
  runtime.onMerged = () => {
    if (!sweeping) sweeper.schedule();
  };
  runtime.onLifecycle = (event: LifecycleEvent) => {
    if (event.type === 'session.deleted') {
      const directory = state?.sessions[event.data.sessionID];
      const context = owner()?.context;
      if (directory !== undefined && state !== undefined && context !== undefined) {
        delete state.sessions[event.data.sessionID];
        if (!state.orphaned.includes(directory)) state.orphaned.push(directory);
        void saveState(context);
      }
    }
    sweeper.schedule();
  };
  return sweeper;
}

/** Removals first, then by directory, so the dry run reads top-down. */
function sortDecisions(decisions: WorktreeDecision[]): WorktreeDecision[] {
  return [...decisions].sort(
    (a, b) =>
      (a.action === b.action ? 0 : a.action === 'remove' ? -1 : 1) ||
      a.directory.localeCompare(b.directory)
  );
}

/** Reads a stored cleanup state, falling back to an unconfirmed empty one. */
function readCleanupState(value: unknown): CleanupState {
  const record =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const sessions =
    typeof record.sessions === 'object' && record.sessions !== null
      ? Object.fromEntries(
          Object.entries(record.sessions).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        )
      : {};
  /** The string entries of a stored list; anything else reads as empty. */
  const strings = (list: unknown) =>
    Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
  return {
    confirmed: record.confirmed === true,
    orphaned: strings(record.orphaned),
    sessions,
    projects: strings(record.projects)
  };
}

/** Every session, archived and children included, newest first, following list cursors. */
async function listSessions(context: Plugin.Context): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await context.session.list({
      limit: 200,
      order: 'desc',
      ...(cursor ? { cursor } : {})
    });
    sessions.push(...page.data);
    cursor = page.cursor.next ?? undefined;
  } while (cursor && sessions.length < MAX_SESSIONS);
  return sessions;
}

/** One worktree's facts from a sweep, with what removing it and reading it again need. */
interface Gathered {
  projectID: string;
  /** The default branch ref, for reading `ahead` and `contained` again. */
  base?: string;
  facts: WorktreeFacts;
}

/** A worktree OpenCode knows, with the default branch ref its project compares against. */
interface KnownWorktree {
  projectID: string;
  directory: string;
  /** No strategy owns it: the checkout OpenCode discovered the project from. */
  root: boolean;
  base?: string;
}

/** Lists the worktrees of every project in `projects`. The global project has none. */
async function listWorktrees(
  runtime: Runtime,
  context: Plugin.Context,
  projects: readonly string[]
): Promise<KnownWorktree[]> {
  const result: KnownWorktree[] = [];
  for (const projectID of projects) {
    const entries = await projectWorktrees(context, projectID).catch((error: unknown) => {
      warn(`Listing worktrees of ${projectID} failed`, error);
      return [];
    });
    const root = entries.find((entry) => entry.main)?.directory;
    const base =
      root === undefined
        ? undefined
        : await defaultBranchRef(root, await resolveRepo(runtime, root));
    for (const entry of entries) {
      result.push({
        projectID,
        directory: entry.directory,
        root: entry.main,
        ...(base === undefined ? {} : { base })
      });
    }
  }
  return result;
}

/**
 * Whether a permission request or a question waits on the session, like the TUI's recheck before
 * it archives. A failed permission read counts as waiting.
 */
async function hasPending(
  runtime: Runtime,
  context: Plugin.Context,
  sessionID: string
): Promise<boolean> {
  if (runtime.forms.has(sessionID)) return true;
  try {
    return (await context.permission.list({ sessionID })).length > 0;
  } catch {
    return true;
  }
}

/**
 * Time of the user's last message; see {@link lastUserMessageAt}. Null when unknown, including
 * a failed read, which keeps the session from counting as Done.
 */
async function lastMessage(
  context: Plugin.Context,
  sessionID: string
): Promise<number | undefined | null> {
  try {
    return lastUserMessageAt(await context.session.context({ sessionID }));
  } catch {
    return null;
  }
}
