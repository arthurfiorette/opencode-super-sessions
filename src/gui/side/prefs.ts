import { Store } from '@opencode/plugin/gui';
import { Schema } from 'effect';

// The side tab's lasting choices, one value for the app.

const SidePrefs = Schema.Struct({
  /** Whether the Work section is folded to its summary line. Absent folds it. */
  workFolded: Schema.optional(Schema.Boolean)
});

export type SidePrefs = typeof SidePrefs.Type;

/** The `Store.global` declaration, under `stores.side` in `Plugin.define`. */
export const sidePrefs = Store.global(SidePrefs, {});

/** Whether the Work section shows folded. */
export function workFolded(prefs: SidePrefs): boolean {
  return prefs.workFolded !== false;
}
