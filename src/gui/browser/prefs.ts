import { Store } from '@opencode/plugin/gui';
import { Schema } from 'effect';

// The browser's lasting choices, one value for the app. Only the scope lives here: the view,
// search and selection start over with every open.

const BrowserPrefs = Schema.Struct({
  /** The scope the user last picked; absent follows the `scope` plugin option. */
  allProjects: Schema.optional(Schema.Boolean)
});

export type BrowserPrefs = typeof BrowserPrefs.Type;

/** The `Store.global` declaration, under `stores.browser` in `Plugin.define`. */
export const browserPrefs = Store.global(BrowserPrefs, {});
