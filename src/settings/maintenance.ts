import { randomUUID } from 'node:crypto';
import type { Plugin } from '@opencode/plugin/tui';
import { createEffect, createRoot, createSignal, on } from 'solid-js';
import { pluginRpc } from '../host/rpc.js';
import { setArchived } from '../host/session-api.js';
import type { Pins } from '../pins.js';
import type { WorktreeDecision } from '../rpc.js';
import type { ServerSettingsClient, TuiSettings } from './store.js';

// The TUI half of auto-archive and cleanup. The server decides; this side reports what the TUI
// shows (pins and open sessions), archives the sessions the server hands out (the server plugin
// cannot archive), and asks the user before the first worktree removal.

const PRESENCE_DELAY = 1000;
// Under the server's 15-minute presence TTL, with room for one missed report.
const HEARTBEAT = 5 * 60_000;
// Archives are claimed on the server's nudge; this catches a nudge sent before the TUI listened.
const CLAIM_INTERVAL = 10 * 60_000;
const START_DELAY = 3000;
// Retry delay while a dialog or the browser holds the screen.
const BUSY_RETRY = 5000;
// The undo command stays offered this long after an auto-archive.
const UNDO_WINDOW = 10 * 60_000;

/** The TUI half of auto-archive and cleanup. */
export interface Maintenance {
  /** Whether the last auto-archive can still be undone. Reactive. */
  undoable(): boolean;
  /** Restores the last auto-archived sessions and excludes them from auto-archive. */
  undo(): Promise<void>;
  /** Dry run, then asks before removing: the "Run cleanup now" action. */
  runCleanup(): Promise<void>;
  dispose(): void;
}

/** Starts reporting presence and listening for server requests. */
export function installMaintenance(
  context: Plugin.Context,
  tui: TuiSettings,
  pins: Pins,
  server: ServerSettingsClient,
  isBusy: () => boolean
): Maintenance {
  const clientID = randomUUID();
  /** The server plugin's RPC client. */
  const rpc = () => pluginRpc(context.client);
  /** RPC call options: this TUI's Location, else the host's default one. */
  const options = () => ({ location: context.location ?? context.data.location.default() });
  /** Shows a toast. */
  const toast = (message: string, variant: 'info' | 'success' | 'warning' | 'error' = 'info') =>
    context.ui.toast.show({ message, variant });
  const [last, setLast] = createSignal<{ ids: string[]; at: number }>();
  /** The sessions of the last auto-archive while it can still be undone. */
  const recent = () => {
    const value = last();
    return value !== undefined && Date.now() - value.at < UNDO_WINDOW ? value.ids : [];
  };
  let claiming = false;
  // Lists the user already declined in this TUI, so a sweep does not ask again every time.
  const declined = new Set<string>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  /** Keeps a timer for dispose. Unref'd: background upkeep never holds the process open. */
  const keep = (timer: ReturnType<typeof setTimeout>) => {
    timer.unref?.();
    timers.push(timer);
  };

  /** Sessions the TUI shows: the route's session and every open tab. */
  const openSessions = () => {
    const route = context.ui.router.current();
    const ids = context.ui.tabs.list().map((tab) => tab.sessionID);
    if (route.type === 'session') ids.push(context.data.session.root(route.sessionID));
    return [...new Set(ids)];
  };
  let presenceTimer: ReturnType<typeof setTimeout> | undefined;
  /** Sends this TUI's pins and open sessions to the server, once per burst of changes. */
  const report = () => {
    clearTimeout(presenceTimer);
    presenceTimer = setTimeout(() => {
      presenceTimer = undefined;
      // Inside `then`, so any failure stays a rejected promise instead of a throw in a timer.
      void Promise.resolve()
        .then(() =>
          rpc().presence(
            { clientID, pinned: [...pins.ids()].slice(0, 500), open: openSessions() },
            options()
          )
        )
        .catch(() => {});
    }, PRESENCE_DELAY);
    presenceTimer.unref?.();
  };
  // A root of its own: the effect must outlive any component, and it reads only stores.
  const disposeRoot = createRoot((dispose) => {
    createEffect(on(() => [pins.ids().join(','), openSessions().join(',')], report));
    return dispose;
  });
  keep(setInterval(report, HEARTBEAT));

  /** Claims due sessions, rechecks each one here, archives it and reports back. */
  const claim = async () => {
    if (claiming) return;
    claiming = true;
    try {
      const { sessions } = await rpc()['archive.claim']({ clientID }, options());
      if (sessions.length === 0) return;
      const archived: string[] = [];
      const skipped: string[] = [];
      for (const session of sessions) {
        // The server saw the session a while ago; the user may have started it since.
        if (pins.has(session.sessionID) || (await busyHere(context, session.sessionID))) {
          skipped.push(session.sessionID);
          continue;
        }
        try {
          // The archive path that works: the TUI's HTTP client. The server plugin's
          // `session.update` ignores `archived`.
          await setArchived(context.client, session.sessionID, true);
          archived.push(session.sessionID);
          if (tui.closeTabOnArchive()) context.ui.tabs.close(session.sessionID);
        } catch {
          skipped.push(session.sessionID);
        }
      }
      await rpc()
        ['archive.report']({ clientID, archived, skipped }, options())
        .catch(() => {});
      if (archived.length === 0) return;
      setLast({ ids: archived, at: Date.now() });
      toast(
        `Archived ${count(archived.length, 'Done session')}. Undo with /super-sessions undo.`,
        'success'
      );
    } catch {
      // No server plugin, or the daemon restarted; the next nudge or interval tries again.
    } finally {
      claiming = false;
    }
  };

  // The startup check and the server's event can both ask, and the screen can stay busy for a
  // while: one dialog and one retry timer at a time, with the newest list waiting for them.
  let asking = false;
  let waiting: WorktreeDecision[] | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  /** Asks once per list before the first automatic removal. Waits while the screen is busy. */
  const confirm = async (worktrees: WorktreeDecision[]) => {
    const key = worktrees.map((worktree) => worktree.directory).join('\n');
    if (worktrees.length === 0 || declined.has(key)) return;
    if (asking || isBusy()) {
      waiting = worktrees;
      if (!asking && retry === undefined) {
        retry = setTimeout(() => {
          retry = undefined;
          const next = waiting;
          waiting = undefined;
          if (next !== undefined) void confirm(next);
        }, BUSY_RETRY);
        retry.unref?.();
      }
      return;
    }
    asking = true;
    let accepted = false;
    try {
      const answer = await context.ui.dialog.confirm({
        title: `Remove ${count(worktrees.length, 'worktree')}?`,
        message: `${listDecisions(context, worktrees)}\n\nWorktree cleanup asks once. After you confirm, it removes worktrees on its own. Removal cannot be undone.`,
        label: { confirm: 'Remove', cancel: 'Not now' }
      });
      accepted = answer === true;
      if (accepted) await remove(worktrees.map((worktree) => worktree.directory));
      else declined.add(key);
    } finally {
      asking = false;
    }
    // After a confirmation the server removes on its own, so a list that waited needs no dialog.
    const next = waiting;
    waiting = undefined;
    if (next !== undefined && !accepted) void confirm(next);
  };

  /** Removes directories that still qualify on the server and reports the result. */
  const remove = async (directories: string[]) => {
    try {
      const result = await rpc()['cleanup.run']({ directories }, options());
      if (result.removed.length > 0) {
        toast(`Removed ${count(result.removed.length, 'worktree')}`, 'success');
      }
      if (result.kept.length > 0) {
        toast(
          `Kept ${count(result.kept.length, 'worktree')}: ${result.kept[0]?.reason ?? ''}`,
          'warning'
        );
      }
    } catch {
      toast('Cleanup failed. Check that the server plugin is enabled.', 'error');
    }
  };

  const events = rpc().events;
  const offs = [
    events.on('archive.due', () => void claim()),
    events.on('cleanup.confirm', (event) => void confirm(event.data.worktrees)),
    events.on('cleanup.removed', (event) =>
      toast(`Removed ${count(event.data.directories.length, 'worktree')}`, 'success')
    )
  ];
  keep(setInterval(() => void claim(), CLAIM_INTERVAL));
  keep(
    setTimeout(() => {
      void claim();
      void startupCheck();
    }, START_DELAY)
  );

  /** A sweep may have asked before this TUI started listening; ask the server directly. */
  const startupCheck = async () => {
    await server.load();
    const values = server.view()?.values;
    if (values === undefined) return;
    const rules =
      values.cleanupDeleted ||
      values.cleanupMerged ||
      values.cleanupUnchanged ||
      values.cleanupInactiveDays !== null ||
      values.cleanupDoneDays !== null;
    if (!rules) return;
    try {
      const plan = await rpc()['cleanup.plan']({}, options());
      if (plan.confirmed) return;
      await confirm(plan.worktrees.filter((worktree) => worktree.action === 'remove'));
    } catch {}
  };

  return {
    undoable: () => recent().length > 0,
    async undo() {
      const ids = recent();
      if (ids.length === 0) {
        toast('Nothing to undo.');
        return;
      }
      setLast(undefined);
      let failed = 0;
      for (const sessionID of ids) {
        try {
          await setArchived(context.client, sessionID, false);
        } catch {
          failed++;
        }
      }
      await excludeFromAutoArchive(context, ids);
      toast(
        failed === 0
          ? `Restored ${count(ids.length, 'session')}`
          : `Restored ${ids.length - failed}, ${failed} failed`,
        failed === 0 ? 'success' : 'warning'
      );
    },
    async runCleanup() {
      let plan: Awaited<ReturnType<ReturnType<typeof rpc>['cleanup.plan']>>;
      try {
        plan = await rpc()['cleanup.plan']({}, options());
      } catch {
        toast('Cleanup is unavailable. Enable the opencode-super-sessions server plugin.', 'error');
        return;
      }
      const removals = plan.worktrees.filter((worktree) => worktree.action === 'remove');
      const kept = plan.worktrees.filter((worktree) => worktree.action === 'keep');
      if (removals.length === 0) {
        await context.ui.dialog.alert({
          title: 'Nothing to clean up',
          message:
            kept.length === 0
              ? 'No cleanup rule is on, or OpenCode knows no worktrees.'
              : listDecisions(context, kept)
        });
        return;
      }
      const accepted = await context.ui.dialog.confirm({
        title: `Remove ${count(removals.length, 'worktree')}?`,
        message: [
          listDecisions(context, removals),
          ...(kept.length > 0 ? ['', 'Kept:', listDecisions(context, kept)] : []),
          '',
          'Removal cannot be undone. Branches and session history are kept.',
          ...(plan.confirmed
            ? []
            : ['Confirming also turns on automatic removal: later sweeps remove without asking.'])
        ].join('\n'),
        label: { confirm: 'Remove', cancel: 'Cancel' }
      });
      if (accepted) await remove(removals.map((worktree) => worktree.directory));
    },
    dispose() {
      clearTimeout(presenceTimer);
      clearTimeout(retry);
      for (const timer of timers) clearTimeout(timer);
      for (const off of offs) off();
      disposeRoot();
    }
  };
}

/**
 * Tells the server the user restored these sessions, so auto-archive never takes them again.
 * Called after every restore: the undo command, `ctrl+s` in the Archived view and `/unarchive`.
 * Never rejects; without the server plugin there is no auto-archive to stop.
 */
export function excludeFromAutoArchive(
  context: Plugin.Context,
  sessionIDs: readonly string[]
): Promise<void> {
  return Promise.resolve()
    .then(() =>
      pluginRpc(context.client)['archive.exclude'](
        { sessionIDs: [...sessionIDs] },
        { location: context.location ?? context.data.location.default() }
      )
    )
    .then(
      () => {},
      () => {}
    );
}

/** "1 worktree", "2 worktrees". */
function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

/** One line per decision: the directory as the host formats paths, and the reason. */
function listDecisions(context: Plugin.Context, decisions: WorktreeDecision[]): string {
  const shown = decisions.slice(0, 12);
  const lines = shown.map(
    (decision) => `${context.ui.format.path(decision.directory)}: ${decision.reason}`
  );
  if (decisions.length > shown.length) lines.push(`and ${decisions.length - shown.length} more`);
  return lines.join('\n');
}

/** Whether the session is running or waits on a permission or a question in this TUI's view. */
async function busyHere(context: Plugin.Context, sessionID: string): Promise<boolean> {
  const data = context.data.session;
  if (data.family(sessionID).some((id) => data.status(id) === 'running')) return true;
  if (data.status(sessionID) === 'running') return true;
  await Promise.all([
    data.permission.sync(sessionID).catch(() => {}),
    data.form.sync(sessionID).catch(() => {})
  ]);
  return (
    (data.permission.list(sessionID)?.length ?? 0) > 0 ||
    (data.form.list(sessionID)?.length ?? 0) > 0
  );
}
