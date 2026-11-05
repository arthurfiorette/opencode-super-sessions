import type { PullCheck } from '../refs/ref.js';

/** One check as read from the forge, before re-runs are folded together. */
export interface CheckEntry {
  check: PullCheck;
  /** GitHub's workflow name, which tells apart jobs that share a name in different workflows. */
  group?: string | undefined;
  /** When it last moved, as epoch milliseconds; a check still running counts as newest. */
  at: number;
}

// Order of the preview's check list: what needs a look first, then what still runs.
const RANK: Record<PullCheck['status'], number> = {
  failure: 0,
  cancelled: 0,
  action_required: 0,
  pending: 1,
  success: 2,
  neutral: 2,
  skipped: 2
};

/**
 * Keeps the newest run of each check and orders failures first, then running checks, then the
 * rest, each in the forge's order. A rollup repeats a check for every re-run and for overlapping
 * push and pull request runs, as in t3code's `dedupeChecks`; a name two groups share gets its
 * group in front.
 */
export function foldChecks(entries: readonly CheckEntry[]): PullCheck[] {
  const newest = new Map<string, CheckEntry>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.group ?? '', entry.check.name]);
    const kept = newest.get(key);
    if (kept === undefined || entry.at >= kept.at) newest.set(key, entry);
  }
  const kept = [...newest.values()];
  const names = new Map<string, number>();
  for (const entry of kept) names.set(entry.check.name, (names.get(entry.check.name) ?? 0) + 1);
  return kept
    .map((entry) =>
      entry.group && (names.get(entry.check.name) ?? 0) > 1
        ? { ...entry.check, name: `${entry.group} / ${entry.check.name}` }
        : entry.check
    )
    .map((check, index) => ({ check, index }))
    .sort((a, b) => RANK[a.check.status] - RANK[b.check.status] || a.index - b.index)
    .map(({ check }) => check);
}
