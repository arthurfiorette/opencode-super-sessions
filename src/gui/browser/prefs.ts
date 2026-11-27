import { Store } from '@opencode/plugin/gui';
import { Schema } from 'effect';

// The browser's lasting choices, one value for the app. Only the project picker's choice lives
// here: the view, search and selection start over with every open.

const BrowserPrefs = Schema.Struct({
  /**
   * What the user last picked in the project picker: `all` for every project, `project` for a
   * project, which the next open reads as the routed session's own. Absent follows `rail`, then
   * `allProjects`, then the `scope` plugin option.
   */
  pick: Schema.optional(Schema.Literals(['all', 'project'])),
  /** The same choice as the project rail before the picker stored it. Read, never written. */
  rail: Schema.optional(Schema.Literals(['all', 'project'])),
  /** The scope switch's pick, from before the rail: true for all projects. Read, never written. */
  allProjects: Schema.optional(Schema.Boolean)
});

export type BrowserPrefs = typeof BrowserPrefs.Type;

/** The `Store.global` declaration, under `stores.browser` in `Plugin.define`. */
export const browserPrefs = Store.global(BrowserPrefs, {});

/**
 * Whether the browser opens on every project: the user's last pick, else their pick of the older
 * rail or scope switch, else the `scope` plugin option.
 */
export function opensOnAll(prefs: BrowserPrefs, scopeOption: unknown): boolean {
  const pick = prefs.pick ?? prefs.rail;
  if (pick !== undefined) return pick === 'all';
  if (prefs.allProjects !== undefined) return prefs.allProjects;
  return scopeOption === 'all';
}
