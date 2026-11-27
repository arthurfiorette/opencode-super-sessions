import { Store } from '@opencode/plugin/gui';
import { Schema } from 'effect';

// The side tab's lasting choices, one value for the app. Older versions stored `workFolded` and
// `scope` here too; nothing reads them any more.

const SidePrefs = Schema.Struct({
  /** Whether the Working section is collapsed to its header. Absent expands it, as the app's does. */
  workingCollapsed: Schema.optional(Schema.Boolean)
});

export type SidePrefs = typeof SidePrefs.Type;

/** The `Store.global` declaration, under `stores.side` in `Plugin.define`. */
export const sidePrefs = Store.global(SidePrefs, {});

/** Whether the Working section shows collapsed. */
export function workingCollapsed(prefs: SidePrefs): boolean {
  return prefs.workingCollapsed === true;
}
