// Auto-archive decides on the server, where ref states live, and archives in a TUI: the server
// plugin's `session.update` ignores `archived` (OpenCode 2.2.5, packages/core/src/plugin/host.ts),
// and the daemon's HTTP credentials never reach plugins. A TUI claims due sessions over RPC and
// archives them with its HTTP client, so nothing is archived while no TUI is open.

const DAY = 24 * 60 * 60_000;
// A TUI that claimed sessions and never reported back (closed, crashed) loses them after this.
const LEASE_MS = 2 * 60_000;
const CLAIM_LIMIT = 50;

/** What the auto-archive decision needs about one top-level session. */
export interface ArchiveFacts {
  sessionID: string;
  title: string;
  archived: boolean;
  running: boolean;
  /** A permission request waits for the user. */
  pending: boolean;
  /** Pinned in a TUI that reported its pins. */
  pinned: boolean;
  /** The user undid an earlier auto-archive of this session. */
  excluded: boolean;
  done: boolean;
  /** When the session became Done, if the refs say. */
  doneAt?: number | undefined;
}

/**
 * Whether a session is due for auto-archive with `days` (null: off). Pinned, excluded, running
 * and waiting sessions never are. A Done session without a close time is due only with 0 days,
 * since there is nothing to count the days from.
 */
export function isArchiveDue(facts: ArchiveFacts, days: number | null, now: number): boolean {
  if (days === null || facts.archived || !facts.done) return false;
  if (facts.pinned || facts.excluded || facts.running || facts.pending) return false;
  if (days === 0) return true;
  return facts.doneAt !== undefined && now - facts.doneAt >= days * DAY;
}

/** Due sessions handed out to TUIs one claim at a time. */
export interface ArchiveQueue {
  /** Replaces the due list after a sweep. Returns how many sessions are due. */
  replace(due: Array<{ sessionID: string; title: string }>): number;
  /** Up to 50 due sessions no other TUI holds, leased to `clientID`. */
  claim(clientID: string, now: number): Array<{ sessionID: string; title: string }>;
  /** Drops reported sessions: archived ones are done, skipped ones wait for the next sweep. */
  report(sessionIDs: readonly string[]): void;
  size(): number;
}

/** Creates an empty queue. */
export function createArchiveQueue(): ArchiveQueue {
  const due = new Map<string, string>();
  const leases = new Map<string, { clientID: string; until: number }>();
  return {
    replace(next) {
      due.clear();
      for (const session of next) due.set(session.sessionID, session.title);
      for (const id of leases.keys()) if (!due.has(id)) leases.delete(id);
      return due.size;
    },
    claim(clientID, now) {
      const claimed: Array<{ sessionID: string; title: string }> = [];
      for (const [sessionID, title] of due) {
        if (claimed.length >= CLAIM_LIMIT) break;
        const lease = leases.get(sessionID);
        if (lease !== undefined && lease.until > now && lease.clientID !== clientID) continue;
        leases.set(sessionID, { clientID, until: now + LEASE_MS });
        claimed.push({ sessionID, title });
      }
      return claimed;
    },
    report(sessionIDs) {
      for (const id of sessionIDs) {
        due.delete(id);
        leases.delete(id);
      }
    },
    size: () => due.size
  };
}
