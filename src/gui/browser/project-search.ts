import { homePath } from '../../host/gui.js';
import type { ProjectEntry } from './projects.js';

// How the project picker and the Projects view search and order projects, so the two agree. The
// app's "Search projects" dialog matches a name, path or server name holding the query and keeps
// its own order (PROJECT_SEARCH in src/host/gui.ts); here a closer match of the name comes first,
// since a list of every machine's projects is long and a typed name should land on top.

/** Projects the picker lists before its "Other projects" row while nothing is typed. */
export const RECENT_PROJECTS = 12;

/**
 * How well a project matches a lowercased, trimmed query: 0 for a name starting with it, 1 for a
 * name holding it, 2 for a path holding it, as written or with `~` for the home directory, 3 for
 * the machine name a row shows. Undefined when nothing holds it.
 */
export function projectRank(project: ProjectEntry, needle: string): number | undefined {
  const name = project.look.name.toLowerCase();
  if (name.startsWith(needle)) return 0;
  if (name.includes(needle)) return 1;
  const root = project.look.root;
  if (root.toLowerCase().includes(needle) || homePath(root).toLowerCase().includes(needle)) {
    return 2;
  }
  if (project.machine?.toLowerCase().includes(needle)) return 3;
  return undefined;
}

/**
 * The projects that match `query`, best match first and in their given order within a rank, or
 * every project as given for an empty query.
 */
export function searchProjects(
  projects: readonly ProjectEntry[],
  query: string
): readonly ProjectEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return projects;
  return projects
    .map((project) => ({ project, rank: projectRank(project, needle) }))
    .filter((item): item is { project: ProjectEntry; rank: number } => item.rank !== undefined)
    .sort((a, b) => a.rank - b.rank)
    .map((item) => item.project);
}

/**
 * The picker's projects without a query: the {@link RECENT_PROJECTS} with the newest activity,
 * as given, and the rest by name, then by machine and path so same-named projects keep one order.
 */
export function splitRecent(projects: readonly ProjectEntry[]): {
  readonly recent: readonly ProjectEntry[];
  readonly others: readonly ProjectEntry[];
} {
  const others = projects
    .slice(RECENT_PROJECTS)
    .sort(
      (a, b) =>
        a.look.name.localeCompare(b.look.name, undefined, { sensitivity: 'base' }) ||
        (a.machine ?? '').localeCompare(b.machine ?? '') ||
        a.look.root.localeCompare(b.look.root)
    );
  return { recent: projects.slice(0, RECENT_PROJECTS), others };
}
