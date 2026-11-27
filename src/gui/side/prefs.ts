import { Store } from '@opencode/plugin/gui';
import { Schema } from 'effect';

// The side tab's lasting choices, one value for the app.

const SidePrefs = Schema.Struct({
  /** The Work section is folded to its header line. Absent shows it unfolded. */
  workFolded: Schema.optional(Schema.Boolean)
});

export type SidePrefs = typeof SidePrefs.Type;

/** The `Store.global` declaration, under `stores.side` in `Plugin.define`. */
export const sidePrefs = Store.global(SidePrefs, {});
