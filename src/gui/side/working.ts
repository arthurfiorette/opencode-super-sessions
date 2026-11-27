import type { SessionInfo } from '@opencode/client';
import type { ServerRef } from '@opencode/plugin/gui';
import {
  type Accessor,
  createEffect,
  createMemo,
  getOwner,
  type Owner,
  runWithOwner,
  untrack
} from 'solid-js';
import { activityTime, isBusy, isUnread } from '../../host/session-info.js';
import { waitingFor } from '../browser/list.js';
import type { Machines } from '../browser/machines.js';
import type { BrowserModel } from '../browser/model.js';

// The sessions the side tab's Working section lists: every connected machine's root sessions that
// wait on the user, run, or finished unread in the last day. The lists come from the browser
// models' every-project list, asked once per machine, and the app's synced data keeps them
// current from session events; nothing here polls.

/** Why a session needs attention, in the order the section lists them. */
export type Attention = 'waiting' | 'running' | 'unread';

/** How long a finished, unread session stays listed after its run ended. */
const UNREAD_FOR = 24 * 3_600_000;

/** The place of each {@link Attention} in the list. */
const RANK: Readonly<Record<Attention, number>> = { waiting: 0, running: 1, unread: 2 };

/** A listed session. */
export interface WorkingEntry {
  /** `${server id}\n${session id}`, unique across machines. */
  readonly key: string;
  readonly server: ServerRef;
  /** The app's live copy once it synced the session, else the copy the list loaded. */
  readonly session: SessionInfo;
  readonly attention: Attention;
  /** What a waiting session waits for. */
  readonly waiting: 'permission' | 'question' | undefined;
  /** When it last ran or finished, for its age and its place within its kind. */
  readonly at: number;
}

/** Whether two lists hold the same strings in the same order. */
export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * One machine's listed sessions. The candidates are the machine's every-project active list and
 * every session seen running or waiting since the window opened, so a session created after that
 * list loaded, or older than its 200 rows, still lists while it runs and once it finished. Each
 * reads the app's live copy when the app synced it, since only those follow `session.viewed`
 * and a run's end (packages/client/src/solid/data.ts:1320-1364 at v2.4.2).
 */
function machineEntries(model: BrowserModel, now: Accessor<number>) {
  const server = model.server;
  // Only grows: a session that ran keeps its place among the candidates once it stops, to list
  // as unread. The memo below rereads it whenever one of the event-driven lists changes.
  const seen = new Set<string>();
  /**
   * Sessions running or waiting now, as the app's data knows them from events: a running
   * subagent counts for its root, as the app's sidebar counts it
   * (packages/app/src/shell/titlebar/inbox-model.ts:171-176 at v2.4.2).
   */
  const flagged = createMemo(
    () => {
      const sessions = server.data.session;
      for (const id of sessions.active()) seen.add(sessions.root(id));
      for (const id of sessions.permission.sessions()) seen.add(id);
      for (const id of sessions.form.sessions()) seen.add(id);
      return [...seen];
    },
    [],
    { equals: sameList }
  );
  const listed = createMemo(
    () => new Map((model.everyActive() ?? []).map((session) => [session.id, session]))
  );

  // The app keeps a session's `time.idle` and `time.viewed` current only once it synced the
  // session, so a running or waiting one it has not is read once, as the app's sidebar reads
  // every working one (packages/app/src/shell/titlebar/inbox.tsx:257-263 at v2.4.2).
  const asked = new Set<string>();
  createEffect(() => {
    const sessions = server.data.session;
    for (const id of flagged()) {
      if (asked.has(id) || sessions.get(id) !== undefined) continue;
      asked.add(id);
      untrack(() => void sessions.sync(id).catch(() => {}));
    }
  });

  return createMemo((): WorkingEntry[] => {
    const sessions = server.data.session;
    const snapshot = listed();
    const since = now() - UNREAD_FOR;
    const entries: WorkingEntry[] = [];
    for (const id of new Set([...snapshot.keys(), ...flagged()])) {
      const loaded = sessions.get(id);
      const session = loaded ?? snapshot.get(id);
      // Subagents list under their root in the browser and the app's sidebar, never alone.
      if (session === undefined || session.parentID !== undefined) continue;
      if (session.time.archived !== undefined) continue;
      const waiting = waitingFor(sessions, id);
      // A loaded copy says when its run started; the list's copy may predate the run's end, so
      // only the live status counts for it.
      const running = model.isRunning(id) || (loaded !== undefined && isBusy(loaded));
      const attention: Attention | undefined =
        waiting !== undefined
          ? 'waiting'
          : running
            ? 'running'
            : isUnread(session) && (session.time.idle ?? 0) >= since
              ? 'unread'
              : undefined;
      if (attention === undefined) continue;
      entries.push({
        key: `${server.id}\n${id}`,
        server,
        session,
        attention,
        waiting,
        at: activityTime(session)
      });
    }
    return entries;
  });
}

/**
 * The Working section's sessions on every connected machine: waiting on the user first, then
 * running, then finished and unread in the last day, each kind newest first. `shown` is whether
 * the section is on screen: the first time it shows, each connected machine whose browser model
 * holds no every-project list yet is asked for one, once per window. `now` moves the 24-hour
 * cut. Call it under the section's owner.
 */
export function createWorking(
  machines: Machines,
  input: { readonly shown: Accessor<boolean>; readonly now: Accessor<number> }
) {
  const owner: Owner | null = getOwner();
  const warmed = new Set<string>();
  createEffect(() => {
    if (!input.shown()) return;
    for (const model of machines.models()) {
      if (!model.server.connected || warmed.has(model.server.id)) continue;
      warmed.add(model.server.id);
      untrack(() => {
        if (model.everyActive() === undefined) model.wantEveryActive();
      });
    }
  });

  // One memo per machine, made on first read under the section's owner.
  const perMachine = new Map<BrowserModel, Accessor<WorkingEntry[]>>();
  /** A machine's entries, from its memo. */
  const entriesOf = (model: BrowserModel) => {
    let found = perMachine.get(model);
    if (found === undefined) {
      found = runWithOwner(owner, () => machineEntries(model, input.now)) as Accessor<
        WorkingEntry[]
      >;
      perMachine.set(model, found);
    }
    return found();
  };

  return createMemo((): WorkingEntry[] => {
    // The same server reached twice, such as the app's own and a loopback connection to its
    // port, lists each session once: the first machine's, as the browser merges them.
    const ids = new Set<string>();
    const entries: WorkingEntry[] = [];
    for (const model of machines.models()) {
      if (!model.server.connected) continue;
      for (const entry of entriesOf(model)) {
        if (ids.has(entry.session.id)) continue;
        ids.add(entry.session.id);
        entries.push(entry);
      }
    }
    return entries.sort((a, b) => RANK[a.attention] - RANK[b.attention] || b.at - a.at);
  });
}
