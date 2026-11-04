import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Plugin } from '@opencode/plugin/tui';

/** Pinned sessions owned by this plugin, independent of the host's own pin list. */
export interface Pins {
  /** Pinned session ids in pin order. Reactive when read in a Solid computation. */
  ids(): readonly string[];
  /** The first nine pins that still exist as root sessions, for the quick switch slots. */
  slots(): string[];
  /** Whether the session is pinned. */
  has(sessionID: string): boolean;
  /** Pins or unpins a session. Resolves once the change is written. */
  toggle(sessionID: string): Promise<void>;
  /** Stops listening for deleted sessions. */
  dispose(): void;
}

interface PinState {
  imported: boolean;
  ids: string[];
}

/**
 * Creates the pin store. On the first run it copies the host's pins from `session.json` so the
 * user keeps the pins they already had; after that the host file is never read again.
 */
export function createPins(context: Plugin.Context): Pins {
  const [store, update] = context.storage.store<PinState>('pins', {
    initial: { imported: false, ids: [] }
  });
  if (!store.imported) void importHostPins(update);
  const off = context.data.on('session.deleted', (event) => {
    const id = event.data.sessionID;
    if (!store.ids.includes(id)) return;
    void update((draft) => {
      draft.ids = draft.ids.filter((item) => item !== id);
    }).catch(() => {});
  });
  return {
    ids: () => store.ids,
    slots() {
      // Same rule as the host's quick switch: only sessions the TUI knows as roots get a slot.
      const roots = new Set(
        context.data.session
          .list()
          .filter((session) => session.parentID === undefined)
          .map((session) => session.id)
      );
      return store.ids.filter((id) => roots.has(id)).slice(0, 9);
    },
    has: (sessionID) => store.ids.includes(sessionID),
    toggle: (sessionID) =>
      update((draft) => {
        draft.ids = draft.ids.includes(sessionID)
          ? draft.ids.filter((id) => id !== sessionID)
          : [...draft.ids, sessionID];
      }),
    dispose: off
  };
}

/** Path of the host TUI's `session.json`, honoring `XDG_STATE_HOME` like the host does. */
export function hostSessionStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const state = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(state, 'opencode', 'session.json');
}

/**
 * Copies the host's pins once. A missing or malformed file still marks the import as done so a
 * broken host file is not read on every start.
 */
async function importHostPins(update: (mutation: (draft: PinState) => void) => Promise<void>) {
  const pinned = await readFile(hostSessionStatePath(), 'utf8')
    .then((text) => {
      const value: unknown = JSON.parse(text);
      const list =
        typeof value === 'object' && value !== null && 'pinned' in value ? value.pinned : [];
      return Array.isArray(list)
        ? list.filter((item): item is string => typeof item === 'string')
        : [];
    })
    .catch((): string[] => []);
  await update((draft) => {
    // Another TUI instance may have imported between the read and this write.
    if (draft.imported) return;
    draft.imported = true;
    draft.ids = [...new Set([...draft.ids, ...pinned])];
  }).catch(() => {});
}
