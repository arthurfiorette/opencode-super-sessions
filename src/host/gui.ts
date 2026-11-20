import type { PluginInfo } from '@opencode/client';
import type { ServerRef, Servers, SlotMap, Tabs } from '@opencode/plugin/gui';

// What the OpenCode Desktop GUI (`src/gui`) assumes about the app beyond its types. The SDK names
// these as plain strings and documents their meaning in prose, so a rename or a changed meaning
// would compile and only show as a missing header or a tab that never opens. Line numbers refer to
// the OpenCode repository at v2.3.2. test/contract/server.test.ts reads the plugin listing through
// `shipsGui`; the rest is not checked against a host, since only the desktop app renders it.

/**
 * The package export the desktop app loads as the plugin's GUI. The server lists a plugin with
 * `features.gui` when its package exports it (packages/core/src/plugin/module.ts:157), and the
 * app's main process loads the GUI of every active, non-built-in plugin listed so
 * (`shipsPluginGui`, packages/plugin/src/gui/host.ts:385), from the app's own server only.
 */
export const GUI_EXPORT = './gui-experimental';

/** Whether the server lists a plugin with a GUI the desktop app loads (see {@link GUI_EXPORT}). */
export function shipsGui(plugin: Pick<PluginInfo, 'features'>): boolean {
  return plugin.features.gui === true;
}

/**
 * The slot in a session's title row (packages/plugin/src/gui/registries.ts:867). Its input has
 * `compact` while the title needs the room, and the host keeps a hidden timeline's header mounted
 * with `active` false.
 */
export const HEADER_SLOT = 'session.header' satisfies keyof SlotMap;

/** The `+` menu before the side panel's tabs, where `MenuItem` adds entries (registries.ts:89). */
export const PANEL_MENU = 'session.panel';

/**
 * The layout key of one of the plugin's side panel tabs, which `ctx.layout.open` and `state` take:
 * `${plugin}:${tab id}` (packages/plugin/src/gui/host-apis.ts:813, registries.ts:158).
 */
export function panelKey(plugin: string, tab: string): string {
  return `${plugin}:${tab}`;
}

/**
 * Opens a session in a tab. `tabs.open` keeps an open tab of the session where it is instead of
 * adding a second one, and opens in the background unless `focus` is set
 * (packages/plugin/src/gui/host-apis.ts:1606). The desktop app applies it after the interface
 * mounts (packages/app/src/runtime/plugin/host-apis.tsx:398).
 */
export function openSession(
  tabs: Pick<Tabs, 'open'>,
  session: { server: string; id: string },
  focus: boolean
): void {
  tabs.open(session, { focus });
}

/**
 * The sessions open in the window's tabs on one server. `tabs.list()` lists every tab of the strip
 * and gives a session's tab the `SessionRef` of the session it opened, keyed by the server's
 * `ServerRef.id`; a subagent opened inside that tab keeps the tab on its root session
 * (packages/app/src/runtime/plugin/host-apis.tsx:1041 and :601). Drafts have no session.
 */
export function openSessionIDs(tabs: Pick<Tabs, 'list'>, server: string): string[] {
  return tabs.list().flatMap((tab) => (tab.session?.server.id === server ? [tab.session.id] : []));
}

/**
 * Closes the session's tab when one is open, as the user does, so it lists under recently closed
 * tabs. `tabs.close` takes the tab's key and does nothing for a key no tab has
 * (packages/app/src/runtime/plugin/host-apis.tsx:1088).
 */
export function closeSessionTab(
  tabs: Pick<Tabs, 'list' | 'close'>,
  session: { server: string; id: string }
): void {
  for (const tab of tabs.list()) {
    if (tab.session?.server.id === session.server && tab.session.id === session.id) {
      tabs.close(tab.key);
    }
  }
}

/**
 * The desktop app's own server, the one that runs this plugin's server half
 * (`ServerRef.builtin`, packages/plugin/src/gui/host-apis.ts:29). The app lists it among
 * `servers.list()` (packages/app/src/runtime/plugin/host-apis.tsx:586); undefined before the app
 * interface mounts.
 */
export function builtinServer(servers: Pick<Servers, 'list' | 'get'>): ServerRef | undefined {
  for (const id of servers.list()) {
    const server = servers.get(id);
    if (server?.builtin) return server;
  }
  return undefined;
}
