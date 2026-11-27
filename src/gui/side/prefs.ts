import { Store } from '@opencode/plugin/gui';
import { Schema } from 'effect';

// The side tab's lasting choices, one value for the app. Apart from the browser dialog's project
// pick (../browser/prefs.ts): picking a project there does not move the tab, nor the reverse.

const SidePrefs = Schema.Struct({
  /** Whether the Work section is folded to its summary line. Absent folds it. */
  workFolded: Schema.optional(Schema.Boolean),
  /** Which sessions the list shows. Absent lists the routed session's project. */
  scope: Schema.optional(Schema.Literal('all'))
});

export type SidePrefs = typeof SidePrefs.Type;

/** The `Store.global` declaration, under `stores.side` in `Plugin.define`. */
export const sidePrefs = Store.global(SidePrefs, {});

/** Whether the Work section shows folded. */
export function workFolded(prefs: SidePrefs): boolean {
  return prefs.workFolded !== false;
}

/** Whether the list shows every project's sessions rather than the routed project's. */
export function listsAllProjects(prefs: SidePrefs): boolean {
  return prefs.scope === 'all';
}
