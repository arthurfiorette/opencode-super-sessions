import type { PluginInfo } from '@opencode/client';
import type {
  AppIconName,
  Layout,
  Links,
  ServerRef,
  Servers,
  SessionRef,
  Sessions,
  SlotMap,
  System,
  Tabs
} from '@opencode/plugin/gui';

// What the OpenCode Desktop GUI (`src/gui`) assumes about the app beyond its types. The SDK names
// these as plain strings and documents their meaning in prose, so a rename or a changed meaning
// would compile and only show as a missing header or a tab that never opens. Line numbers refer to
// the OpenCode repository at v2.4.0. test/contract/server.test.ts reads the plugin listing through
// `shipsGui`; the rest is not checked against a host, since only the desktop app renders it.

/**
 * The package export the desktop app loads as the plugin's GUI. The server lists a plugin with
 * `features.gui` when its package exports it (packages/core/src/plugin/module.ts:157), and the
 * app's main process loads the GUI of every active, non-built-in plugin listed so
 * (`shipsPluginGui`, packages/plugin/src/gui/host.ts:401), from the app's own server only.
 */
export const GUI_EXPORT = './gui-experimental';

/** Whether the server lists a plugin with a GUI the desktop app loads (see {@link GUI_EXPORT}). */
export function shipsGui(plugin: Pick<PluginInfo, 'features'>): boolean {
  return plugin.features.gui === true;
}

/**
 * The slot in a session's title row (packages/plugin/src/gui/registries.ts:884). Its input has
 * `compact` while the title needs the room, and the host keeps a hidden timeline's header mounted
 * with `active` false.
 */
export const HEADER_SLOT = 'session.header' satisfies keyof SlotMap;

/**
 * The markup of the app's dialog frame, which the browser's CSS (src/gui/browser/browser.css)
 * matches to grow past the `x-large` size: `[data-component="dialog-v2"][data-size="x-large"]`
 * around a `[data-slot="dialog-container"]` sized by `--dialog-height` and `width`
 * (packages/ui/src/overlays/dialog/dialog.tsx:131, dialog.css:178). CSS cannot import this
 * constant; it records the assumption. When the markup changes, the rule matches nothing and the
 * browser opens at the plain `x-large` size.
 *
 * The same CSS hides the frame's `[data-slot="dialog-header"]`, keeping its title for screen
 * readers, and turns the `[data-scrollable]` wrapper around the content into a column the browser
 * fills (`Dialog` in packages/app/src/runtime/plugin/ui.tsx:152-157). When those change, the app's
 * title shows above the browser's own header, or the dialog scrolls as a whole.
 */
export const DIALOG_FRAME = '[data-component="dialog-v2"][data-size="x-large"]';

/**
 * The surfaces of the app's main window, which the browser dialog takes: the window's shell is
 * `--v2-background-bg-deep` (packages/app/src/shell/shell.tsx:216 at v2.4.2), and the session
 * content sits on it in an island of `--v2-background-bg-base` with 10px corners and the raised
 * elevation, whose first ring is the island's hairline (`SessionPanelFrame` in
 * packages/app/src/session/session-frame.tsx:20, the side region in
 * packages/app/src/runtime/plugin/side-region.tsx:112). The dialog's header, footer and preview
 * sit on the shell color, and its list in the island (src/gui/browser/browser.css). CSS cannot
 * import this constant; it records the assumption. When a variable goes, the dialog and the list
 * draw on the dialog's own background.
 */
export const WINDOW_SURFACES = {
  shell: '--v2-background-bg-deep',
  island: '--v2-background-bg-base',
  islandRadius: 10,
  islandElevation: '--v2-elevation-raised'
} as const;

/**
 * The markup of the app's text input (`TextInput` in
 * packages/ui/src/forms/text-input/text-input.tsx:57-79 at v2.4.2), which the app's stylesheet
 * draws in its `components` cascade layer (text-input.css:4-140): a
 * `[data-component="text-input-v2"]` with `data-leading-icon`, around a
 * `[data-slot="text-input-v2-value"]` holding a `text-input-v2-leading-icon` and the
 * `text-input-v2-input`. `ui.TextInput` has no leading icon, so the browser's search field
 * renders this markup itself with the app's magnifying glass, and takes the look of the Settings
 * screen's filter fields such as "Search models" (`SettingsSearchField` in
 * packages/app/src/settings/search-field.tsx:61-69, `.settings-filter-search` in
 * packages/app/src/settings/settings.css:1400-1420): 36px, filled with layer-02 at 60%, no
 * shadow, the icon 16px in. That stylesheet loads only with the Settings screen, so browser.css
 * states its values. When the markup changes, the field draws as a plain input.
 */
export const TEXT_INPUT = '[data-component="text-input-v2"]';

/**
 * The app's button markup (`Button` in packages/ui/src/actions/button/button.tsx:35-51 at
 * v2.4.2): a `button[data-component="button-v2"]` with `data-size` and `data-variant`, drawn by
 * button.css in the `components` layer. The browser's project picker is the Settings server
 * switcher's trigger (packages/app/src/settings/servers/switcher.tsx:22-33): a small outline
 * button with an icon, a name and a muted chevron, 6px gaps and insets and at most 240px wide
 * (settings.css:670-702). `ui.Button` has no outline variant and `ui.Select` shows text only, so
 * the picker renders this markup itself. When it changes, the picker draws as a plain button.
 */
export const BUTTON = '[data-component="button-v2"]';

/**
 * The app's "Search projects" dialog, which the browser's project picker follows
 * (`NewSessionLocationDialog` in packages/app/src/new-session/location/dialog.tsx:371-565 at
 * v2.4.2, opened by `project.select`, packages/app/src/shell/titlebar/titlebar.tsx:63). It is a
 * dialog of its own over the screen (`size="large" fit`, dialog.tsx:371, so 680px wide and as tall
 * as its rows up to 600px, packages/ui/src/overlays/dialog/dialog.css:163-193), without a header:
 * the search field with the magnifying glass on top (28px, no fill, 6px insets,
 * new-session-location/dialog.css:1-41), a 0.5px line under it (dialog.css:43-49), then 32px rows
 * with 8px and 6px insets (dialog.css:83-86) of the avatar, the 13px name at weight 440 taking at
 * most 55% (dialog.css:139-147), the server chip ({@link SERVER_CHIP}) and the project's full
 * worktree path in the faint description (dialog.tsx:575-613), the active row on the overlay
 * hover color (palette-menu.css:58-61). Without a query it ends with an "Other projects" row with
 * the menu icon and a faint count (dialog.tsx:487-500, dialog.css:115-125), then a line and the
 * "Add project" row with the plus icon and its keybind (dialog.tsx:501-519). It matches a project
 * by name, worktree path or server name, each holding the query (dialog.tsx:155-159 and 185).
 * Those stylesheets load with that dialog, so browser.css states the values. CSS cannot import
 * this constant; it records the assumption. `ui.Dialog` has no `fit`, so browser.css also lets the
 * picker's frame grow with its rows, and hides its header as the browser's.
 */
export const PROJECT_SEARCH = '.ss-project-search';

/**
 * The chip the app's "Search projects" rows show after the name of a project on another server
 * (`ServerTag` in packages/app/src/new-session/location/dialog.tsx:632-645 at v2.4.2): the app's
 * `Badge` (`span[data-component="tag"]` with `data-appearance="compact"` and
 * `data-variant="subtle"`, packages/ui/src/data-display/badge/badge.tsx:9-25), a 16px pill of
 * layer-03 with 2px corners and 11px muted text at weight 530 (badge.css:1-45), at most 160px
 * with 3px gaps and a 12px icon (new-session-location/dialog.css:165-186). The icon is `globe`
 * for a remote server and `terminal` for one a plugin connects, such as SSH (`serverIcon`,
 * dialog.tsx:673-677). `ServerRef` does not say how a server is connected, so every other machine
 * gets the globe. The project's own server gets no chip (`tagged`, dialog.tsx:669-671), which
 * {@link machineTag} decides here as the session rows do.
 */
export const SERVER_CHIP = { icon: 'globe' } as const satisfies { icon: AppIconName };

/**
 * The app's "Add project" row and its keybind. In the app it runs `project.open` (`mod+o`), which
 * the "Search projects" dialog registers only while it is mounted
 * (packages/app/src/new-session/location/dialog.tsx:254-272 at v2.4.2), so `ctx.commands.run`
 * cannot reach it from the browser and answers false (packages/app/src/runtime/plugin/
 * host-apis.tsx:1120-1129). Its flow is the app's directory picker titled "Open project"
 * (`command.project.open`, packages/app/src/runtime/i18n/en.ts:54), then the folder is added as
 * a project and a new session opens there (`addProject` in
 * packages/app/src/new-session/project/controller.ts:82-99). `ctx.layout.project(server, title)`
 * runs the same picker, adds the project and opens a new draft
 * (host-apis.tsx:487, 993-1022 and 1190), so the browser's row calls that. With more than one
 * ready server the app asks for the server first (packages/app/src/new-session/location/
 * machine.ts:122-131), and so does the browser. The app's keymap runs no command while a dialog
 * is open (packages/app/src/shell/commands/command.tsx:437), so the picker takes `mod+o` itself.
 */
export const ADD_PROJECT = { chord: 'mod+o' } as const;

/**
 * The look of the app's segmented control (packages/ui/src/navigation/segmented-control/
 * segmented-control.css at v2.4.2): a 28px track of layer-01 with a 0.5px ring of the base border
 * and 6px corners, 13px muted items at weight 440, the pressed one on the base background with a
 * 0.5px ring of the strong border. Only the app's stories render it, so its stylesheet may not be
 * loaded; the browser's view tabs state these values in browser.css. CSS cannot import this
 * constant; it records the assumption.
 */
export const SEGMENTED_CONTROL = '[data-slot="segmented-control-v2"]';

/**
 * The key that opens the browser's project picker, matched by its physical key since `alt+p`
 * types `π` on macOS. The app binds no command to it (its `alt` keys are `alt+arrowup` and
 * `alt+arrowdown`, packages/app/src/shell/titlebar/tab-strip.tsx:64-66 at v2.4.2; the macOS menu
 * has only Option+Up and Option+Down, packages/app/src/shell/commands/desktop-menu.ts:250-256),
 * and its keymap runs no command while a dialog is open
 * (packages/app/src/shell/commands/command.tsx:437).
 */
export const PICKER_KEY = { code: 'KeyP', chord: 'alt+p' } as const;

/** The copy {@link relativeTime} reads, in the app's words (packages/app/src/runtime/i18n/en.ts:829-832). */
export interface RelativeTimeCopy {
  readonly justNow: string;
  readonly minutes: (count: number) => string;
  readonly hours: (count: number) => string;
  readonly days: (count: number) => string;
}

/**
 * A session's age as the app's session search writes it (`getRelativeTime` in
 * packages/app/src/shell/time.ts:9-31 at v2.4.2, drawn by
 * packages/app/src/shell/commands/dialog.tsx:292): "Just now" under a minute, then `5m ago`,
 * `3h ago` and `2d ago`, and from a week on the date, with the year only when it is not this
 * year's.
 */
export function relativeTime(
  then: number,
  now: number,
  copy: RelativeTimeCopy,
  locale: string | undefined
): string {
  const seconds = Math.floor((now - then) / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (seconds < 60) return copy.justNow;
  if (minutes < 60) return copy.minutes(minutes);
  if (hours < 24) return copy.hours(hours);
  if (days < 7) return copy.days(days);
  const date = new Date(then);
  return dateFormat(locale, date.getFullYear() !== new Date(now).getFullYear()).format(date);
}

/** Date formats by locale and whether they show the year; a list formats hundreds of dates. */
const DATE_FORMATS = new Map<string, Intl.DateTimeFormat>();

/** The date format of {@link relativeTime}, made once per locale and year choice. */
function dateFormat(locale: string | undefined, year: boolean): Intl.DateTimeFormat {
  const key = `${locale ?? ''}\n${year}`;
  let format = DATE_FORMATS.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
      year: year ? 'numeric' : undefined
    });
    DATE_FORMATS.set(key, format);
  }
  return format;
}

/** The parts of a DOM `KeyboardEvent` {@link claimCommandKeys} uses; this file also builds without DOM types. */
interface KeyEvent {
  readonly isComposing: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

/** The parts of the window {@link claimCommandKeys} listens on. */
interface KeyTarget<E> {
  addEventListener(type: 'keydown', listener: (event: E) => void, options: { capture: true }): void;
  removeEventListener(
    type: 'keydown',
    listener: (event: E) => void,
    options: { capture: true }
  ): void;
}

/**
 * Takes a command's keys before the app's own commands see them, and runs `run` instead.
 *
 * Since 2.4.0 the app binds `mod+shift+s` to its own "Archive session"
 * (packages/app/src/session/commands/use-session-commands.tsx:577). When a plugin
 * command shares a key with a built-in, the built-in wins: commands rank by `when`, then by a
 * user-set keybind, then by registration order, and built-ins register first
 * (packages/app/src/shell/commands/keymap.ts:82). The plugin `scope` field would rank higher, but
 * a scope around the whole window also turns off the app's `ctrl+r` rename everywhere
 * (packages/app/src/runtime/plugin/commands.tsx:80,
 * packages/app/src/session/timeline/message-timeline.tsx:301).
 *
 * The app's keymap reads keys in the capture phase on the document root (keymap.ts:20), so a
 * capture listener on the window runs first and can stop the key there. `matches` reads the
 * command's effective keybind, so a key the user rebinds in Settings > Shortcuts follows.
 *
 * @returns A function that removes the listener.
 */
export function claimCommandKeys<E extends KeyEvent>(
  target: KeyTarget<E>,
  matches: (event: E) => boolean,
  run: () => void
): () => void {
  const listener = (event: E) => {
    if (event.isComposing || !matches(event)) return;
    event.preventDefault();
    event.stopPropagation();
    run();
  };
  target.addEventListener('keydown', listener, { capture: true });
  return () => target.removeEventListener('keydown', listener, { capture: true });
}

/** The `+` menu before the side panel's tabs, where `MenuItem` adds entries (registries.ts:105). */
export const PANEL_MENU = 'session.panel';

/**
 * Shows a pinned side tab of the plugin in a session, or hides the side region while the tab
 * shows there, for a toggle such as the session header's `+N`. A pinned tab is listed in every
 * strip and never closed, so `layout.toggle`, which closes a visible tab, does not apply.
 * `layout.open` without a placement only selects a pinned tab, without storing it, and opens the
 * side region (packages/app/src/runtime/plugin/host-apis.tsx:910-917 at v2.4.2); a `select`
 * placement would store it in the strip (:889). `layout.hide` closes the region while the tab is
 * visible (:978).
 */
export function togglePinnedTab(
  layout: Pick<Layout, 'open' | 'hide' | 'state'>,
  key: string,
  session: SessionRef
): void {
  if (layout.state(key, session) === 'visible') layout.hide(key, session);
  else layout.open(key, session);
}

/**
 * Opens a session in a focused tab from a side tab of the plugin, keeping that tab on screen
 * there when it was visible. The side region's open state belongs to each session tab
 * (`region` in packages/app/src/shell/tabs/tabs.tsx:878 at v2.4.2), unless Settings > General >
 * "Keep side panel open across sessions" is on, when one value holds for every tab (tabs.tsx:124
 * and :881; `sharedSidePanel`, off by default, packages/app/src/settings/model.tsx:475). So a
 * session that never showed its side region opens without it. `layout.open` on the session's own
 * `SessionRef`, which `sessions.list()` holds for every session tab (host-apis.tsx:605), selects
 * the pinned tab there and opens its region (see {@link togglePinnedTab}); `background` keeps a
 * narrow window on the conversation. With the shared setting on, the open only selects the tab.
 */
export function openSessionKeepingTab(
  app: {
    readonly tabs: Pick<Tabs, 'open'>;
    readonly sessions: Pick<Sessions, 'list'>;
    readonly layout: Pick<Layout, 'open'>;
  },
  key: string,
  session: { server: string; id: string },
  keep: boolean
): void {
  openSession(app.tabs, session, true);
  if (!keep) return;
  const ref = app.sessions
    .list()
    .find((open) => open.server.id === session.server && open.id === session.id);
  if (ref !== undefined) app.layout.open(key, ref, { background: true });
}

/**
 * The layout key of one of the plugin's side panel tabs, which `ctx.layout.open` and `state` take:
 * `${plugin}:${tab id}` (packages/plugin/src/gui/host-apis.ts:849, registries.ts:174).
 */
export function panelKey(plugin: string, tab: string): string {
  return `${plugin}:${tab}`;
}

/**
 * Opens a session in a tab. `tabs.open` keeps an open tab of the session where it is instead of
 * adding a second one, and opens in the background unless `focus` is set
 * (packages/plugin/src/gui/host-apis.ts:1642). The desktop app applies it after the interface
 * mounts (packages/app/src/runtime/plugin/host-apis.tsx:401).
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
 * (packages/app/src/runtime/plugin/host-apis.tsx:1058 and :605). Drafts have no session.
 */
export function openSessionIDs(tabs: Pick<Tabs, 'list'>, server: string): string[] {
  return tabs.list().flatMap((tab) => (tab.session?.server.id === server ? [tab.session.id] : []));
}

/**
 * Closes the session's tab when one is open, as the user does, so it lists under recently closed
 * tabs. `tabs.close` takes the tab's key and does nothing for a key no tab has
 * (packages/app/src/runtime/plugin/host-apis.tsx:1105).
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
 * `servers.list()` (packages/app/src/runtime/plugin/host-apis.tsx:590); undefined before the app
 * interface mounts.
 */
export function builtinServer(servers: Pick<Servers, 'list' | 'get'>): ServerRef | undefined {
  for (const id of servers.list()) {
    const server = servers.get(id);
    if (server?.builtin) return server;
  }
  return undefined;
}

/**
 * The app icon the Desktop sidebar draws before a machine's name when it groups sessions by
 * server (`GroupHeaderView` in packages/app/src/shell/titlebar/sidebar-customized.tsx:616 at
 * v2.4.2). The name beside it is `servers.label(conn)` (sidebar-customized.tsx:560), which is what
 * `ServerRef.name` returns (packages/app/src/runtime/plugin/host-apis.tsx:571): the user's name
 * for the server, else the hostname of the app's own one (or "This computer"), else the server's
 * address without its scheme (`serverLabel`, packages/app/src/runtime/server/registry.tsx:34).
 */
export const MACHINE_ICON = 'server' satisfies AppIconName;

/**
 * The machine name a session row shows at its end, as the sidebar's rows do: none while the app
 * lists one server, and none for the app's own server (`servers.tag` in
 * packages/app/src/runtime/server/registry.tsx:346 at v2.4.2, drawn by
 * packages/app/src/shell/titlebar/project-session-row.tsx:164). The sidebar leaves out only the
 * current server; a loopback connection to the app's own port (`ServerRef.local`) runs on this
 * machine too, so its rows go unlabeled here as well.
 */
export function machineTag(
  server: Pick<ServerRef, 'name' | 'local' | 'builtin'>,
  machines: number
): string | undefined {
  return machines < 2 || server.builtin || server.local ? undefined : server.name;
}

/**
 * A server's home directory, read from a path on it the way the app infers it: the API names no
 * home, so the app takes a `/Users/<name>`, `/home/<name>`, `/root` or `C:\Users\<name>` prefix
 * (`inferHomeDirectory` in packages/app/src/runtime/server/global-sync/bootstrap.ts:76 at v2.4.2).
 * Undefined when the path starts with none of them.
 */
export function inferHome(path: string): string | undefined {
  const normalized = path.replaceAll('\\', '/');
  const match = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:\/Users\/[^/]+)(?=\/|$)/.exec(
    normalized
  )?.[1];
  if (match === undefined) return undefined;
  return path.includes('\\') ? match.replaceAll('/', '\\') : match;
}

/**
 * A path as the app's tab preview writes it: `~` for the home directory when the path is in it,
 * else the full path (`previewPath` in packages/app/src/shell/titlebar/tab-nav.tsx:191-201 at
 * v2.4.2), with the home from {@link inferHome}.
 */
export function homePath(path: string): string {
  const home = inferHome(path);
  if (home === undefined || !/^([/\\]|$)/.test(path.slice(home.length))) return path;
  return `~${path.slice(home.length)}`;
}

/** The modifier keys of a click, which send a link past the app's link handlers. */
export interface LinkModifiers {
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
}

/**
 * Opens a web link the way a click on one in the session's timeline does, and says where it
 * went. The app hands a plain click on an `a[href]` in the session's panes to `links.open` with
 * the routed session, and leaves a click with shift, cmd, ctrl or alt to the system
 * (`webLink` in packages/app/src/runtime/plugin/render.tsx:224 at v2.4.2). The built-in Browser
 * plugin's `LinkHandler` takes an http(s) link without `origin` when its "Open links in OpenCode"
 * preference (Settings > Browser) is on and its pane can open for `session`, and opens it in that
 * session's pane (packages/gui-plugins/src/browser/renderer.tsx:462). "Can open" needs a
 * `SessionRef` with an id on a compatible server outside the narrow layout, not the session on
 * screen (`available` in packages/gui-plugins/src/browser/model.ts:746). The setting says that
 * shift and click uses the default browser (packages/gui-plugins/src/browser/i18n/en.ts:197).
 * Without a matching handler `links.open` returns false and the link goes to the system browser.
 *
 * The plugin's links stop their click, so the window never navigates and the app's own listener
 * never sees them, and those in dialogs render outside `[data-pane-row]`, which that listener
 * skips anyway. This function is their only route to the pane.
 */
export function openWebLink(
  app: { readonly links: Pick<Links, 'open'>; readonly system: Pick<System, 'openExternal'> },
  href: string,
  session: SessionRef | undefined,
  modifiers?: LinkModifiers
): 'app' | 'system' {
  const plain =
    modifiers === undefined ||
    !(modifiers.shiftKey || modifiers.metaKey || modifiers.ctrlKey || modifiers.altKey);
  if (plain && app.links.open(session === undefined ? { href } : { href, session })) return 'app';
  app.system.openExternal(href);
  return 'system';
}

/**
 * The attributes of the app's activity spinner, the dot grid its sidebar shows beside a running
 * session (`ActivityRing` in packages/ui/src/feedback/activity-ring/activity-ring.tsx at v2.4.2,
 * drawn by packages/app/src/shell/titlebar/project-session-row.tsx:163). The SDK's `ui.Loader` is
 * the ring the app shows while something loads, not for AI activity
 * (packages/ui/src/components/spinner.tsx:4), and the SDK has no spinner component. The spinner
 * is one element that the app's global stylesheet paints through `[data-slot="spinner-dots"]` and
 * its `--spinner-*` variables (packages/ui/src/styles/index.css:31). When that markup changes the
 * element draws nothing, and the row's tooltip still says the session runs.
 */
export function activitySpinner(size: number): Record<string, string> {
  return {
    'data-component': 'activity-ring',
    'data-slot': 'spinner-dots',
    'aria-hidden': 'true',
    style: `--spinner-width: ${size}px; --spinner-height: ${size}px`
  };
}

/** A project's icon as the server stores it, or as the user set it locally. */
export interface ProjectIconInfo {
  readonly url?: string | undefined;
  readonly override?: string | undefined;
  readonly color?: string | undefined;
}

/** What draws a project's avatar; see {@link projectLook}. */
export interface ProjectLook {
  /** The name the sidebar shows, also the avatar's tooltip. */
  readonly name: string;
  /** The project's root directory, or the directory of a session outside a project. */
  readonly root: string;
  /** The letter of the letter avatar. */
  readonly initial: string;
  /** The image the avatar shows instead of the letter. */
  readonly src: string | undefined;
  /** The avatar's color, one of the app's avatar variants. */
  readonly variant: string;
}

/** The avatar colors the app has (`PROJECT_AVATAR_VARIANTS`); any other stored color draws gray. */
const AVATAR_VARIANTS = new Set([
  'orange',
  'yellow',
  'cyan',
  'green',
  'red',
  'pink',
  'blue',
  'purple',
  'gray'
]);

/** The OpenCode repository's project ids, which the app draws with OpenCode's own icon. */
const OPENCODE_PROJECT_IDS = new Set([
  '012780c4098d08caa4ea8c479ed0a4690489f38d',
  '476fbfe6befa9e63ddd7f9ae71655999a0104256',
  '4b0ea68d7af9a6031a7ffda7ad66e0cb83315750'
]);

/** The first character of a name as a reader sees it, such as one emoji. */
function firstGrapheme(value: string): string {
  const segment = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    .segment(value)
    [Symbol.iterator]()
    .next().value?.segment;
  return segment ?? Array.from(value)[0] ?? '';
}

/**
 * A project's avatar as the sidebar draws it (`ProjectIcon` in
 * packages/app/src/shell/layout/project-icon.tsx at v2.4.2, over
 * packages/ui/src/data-display/project-avatar/project-avatar.tsx:67-140). The name is the user's
 * or the server's, else the root directory's last segment (`displayName`). The image is the
 * user's override, none once a color is chosen, OpenCode's icon for its own repository, else the
 * discovered `url` (`getProjectAvatarSource`). The color maps `mint` to cyan, `lime` to green and
 * anything unknown to gray (`getProjectAvatarVariant`). The app draws letters by default; its
 * experimental generated avatars are not drawn here.
 */
export function projectLook(project: {
  readonly id: string;
  readonly name?: string | undefined;
  readonly root: string;
  readonly icon?: ProjectIconInfo | undefined;
}): ProjectLook {
  const trimmed = project.root.replace(/[/\\]+$/, '');
  const base = trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1);
  const name = project.name || base || project.root;
  const icon = project.icon;
  let src: string | undefined;
  if (icon?.override) src = icon.override;
  else if (!icon?.color) {
    src = OPENCODE_PROJECT_IDS.has(project.id) ? 'https://opencode.ai/favicon.svg' : icon?.url;
  }
  const color = icon?.color === 'mint' ? 'cyan' : icon?.color === 'lime' ? 'green' : icon?.color;
  return {
    name,
    root: project.root,
    initial: firstGrapheme(name),
    src,
    variant: color !== undefined && AVATAR_VARIANTS.has(color) ? color : 'gray'
  };
}

/**
 * The markup of the app's project avatar, which its stylesheet sizes and colors: a 16px
 * `[data-component="project-avatar-v2"]` around a `[data-slot="project-avatar-surface"]` with
 * `data-variant` and `data-has-image`, holding a `project-avatar-initial` letter or a
 * `project-avatar-media` image (project-avatar.tsx:165, project-avatar.css:1). The plugin's
 * `ProjectAvatar` (src/gui/project-avatar.tsx) renders it. CSS cannot import this constant; it
 * records the assumption. When the markup changes, the avatar shows its letter unstyled.
 */
export const PROJECT_AVATAR = '[data-component="project-avatar-v2"]';

/**
 * The rows of the app's session search, which the browser's rows follow (`PaletteSessionRow` in
 * packages/app/src/shell/commands/dialog.tsx:224-317 at v2.4.2, with
 * packages/app/src/shell/commands/dialog.css:44-235): 32px rows with 8px and 6px insets, the
 * project avatar, a 13px title at weight 440 taking at most 60% beside a faint description, an
 * 11px muted age at the end where a running session shows the activity ring instead, the
 * overlay hover color on the active row, and 12px faint group headers with 10px above. The
 * description of a row of another machine reads `{{project}} · {{server}}`
 * (`palette.session.location` in packages/app/src/runtime/i18n/en.ts:141, applied in
 * packages/app/src/shell/commands/session-search.tsx:51-57). The palette's stylesheet loads with
 * the palette, so browser.css states these values. CSS cannot import this constant; it records
 * the assumption.
 */
export const PALETTE_ROW = '.command-palette-row';

/**
 * The sidebar's "Working" shelf, which the side tab's bottom section reproduces
 * (`InboxSessionList` in packages/app/src/shell/titlebar/inbox.tsx:681-711 at v2.4.2): a group
 * pinned under the list, at most 40% of the sidebar's height, 7px under a 1px
 * `--v2-border-border-muted` line across the whole width, with 8px between its header and its
 * rows and 2px between rows. Its header (`SectionHeader`, inbox.tsx:727-776) is a 24px button of
 * 13px medium muted text 8px in, base on hover, with `aria-expanded` and the `fill-triangle-down`
 * icon after the label, turned a quarter while collapsed. The label is
 * `sidebar.inbox.section.working`, "Working" (packages/app/src/runtime/i18n/en.ts:845), and the
 * app keeps its expanded state in its own global store (inbox.tsx:72-73), which plugins cannot read.
 *
 * Each row (`InboxSessionCard`, inbox.tsx:831-985) is a 54px button with 8px padding, 6px
 * corners and 6px between its two 16px lines, on the hover overlay under the pointer and the
 * pressed overlay with `data-state="active"` and `aria-current="page"` when current. The first
 * line is the 16px project avatar and the 13px medium base title (tracking -0.04px). The second,
 * 24px in, is 13px muted: the `server` icon in the inset for a session of another machine, the
 * project name, the `outline-worktree` icon when the session's directory is not the project's
 * root (`inboxInWorktree`, inbox-model.ts:535-539) and the `branch` icon with the branch as its
 * tooltip once the location's VCS info is synced (inbox-model.ts:455-456), then at the end, in
 * 12px tabular figures 6px apart, a 7px dot in `--v2-state-fg-warning` while it waits on a
 * permission or question, the activity ring while it runs, a 7px dot in
 * `--v2-background-bg-accent` when done and unread, and the faint age (`compact`, inbox.tsx:857-875,
 * with the `sidebar.inbox.elapsed.*` and `sidebar.inbox.time.now` strings, en.ts:860-868).
 * Those rules are Tailwind classes in the app's markup, so side.css states them. CSS cannot import
 * this constant; it records the assumption.
 */
export const WORKING_SHELF = '[data-slot="sidebar-inbox-working"]';

/** The copy {@link shelfAge} reads, in the app's words (packages/app/src/runtime/i18n/en.ts:860-868). */
export interface ShelfAgeCopy {
  readonly now: string;
  readonly minutes: (count: number) => string;
  readonly hours: (count: number) => string;
  readonly days: (count: number) => string;
}

/**
 * A row's age as the sidebar's Working shelf writes it (`compact` and `age` in
 * packages/app/src/shell/titlebar/inbox.tsx:857-875 at v2.4.2): "now" under a minute, then `5m`,
 * `3h` and `2d`. The app counts a running row's first minute in seconds; the side tab ticks by
 * the minute, so it writes "now" there.
 */
export function shelfAge(then: number, now: number, copy: ShelfAgeCopy): string {
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return copy.now;
  if (seconds < 3600) return copy.minutes(Math.floor(seconds / 60));
  if (seconds < 86_400) return copy.hours(Math.floor(seconds / 3600));
  return copy.days(Math.floor(seconds / 86_400));
}

/**
 * Whether a session runs in a worktree of its project, by the sidebar's rule: its directory is
 * not the project's root (`inboxInWorktree` in packages/app/src/shell/titlebar/inbox-model.ts:535
 * at v2.4.2, where the root is the project's `canonical`, global-sync/utils.ts:162). The app
 * compares paths with `comparablePath`; this drops trailing separators and unifies them.
 */
export function inWorktree(root: string, directory: string): boolean {
  const comparable = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '');
  return comparable(root) !== comparable(directory);
}
