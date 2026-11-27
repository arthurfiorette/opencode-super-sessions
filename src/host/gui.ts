import type { PluginInfo } from '@opencode/client';
import type {
  Links,
  ServerRef,
  Servers,
  SessionRef,
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
 * The horizontal padding of a plugin dialog's content: the `px-4` of its `[data-scrollable]`
 * wrapper (packages/app/src/runtime/plugin/ui.tsx:156 at v2.4.2). The browser's rail starts at it
 * and its preview ends at it, so both sides of the dialog match (src/gui/browser/browser.css).
 */
export const DIALOG_PADDING = 16;

/**
 * The surface the browser's project rail and preview column take: the one the composer takes
 * in dark mode, `--v2-background-bg-layer-01` (packages/app/src/composer/editor/editor.css:87-95
 * at v2.4.2), a step off the x-large dialog's `--v2-background-bg-base`
 * (packages/ui/src/overlays/dialog/dialog.css:175). In light mode the composer stays on
 * `--v2-background-bg-base` (editor.tsx:260). Layer-01 is grey-100 over the dialog's grey-50 in
 * light mode and grey-1000 over its grey-1100 in dark mode
 * (packages/ui/src/styles/tokens/theme.css:6-8, 151-153), so the columns are set off in both.
 * It is the preview's surface from before the browser followed the sidebar's look. CSS cannot
 * import this constant; it records the assumption. When the variable goes, the columns take the
 * dialog's background.
 */
export const COMPOSER_SURFACE = '--v2-background-bg-layer-01';

/**
 * The markup of the app's text input, which `ui.TextInput` renders and whose stylesheet fixes its
 * width at 280px inside the `components` cascade layer
 * (packages/ui/src/forms/text-input/text-input.css:5 at v2.4.2). `ui.TextInput` takes no class,
 * so the browser's CSS widens its search field through this selector. When the markup changes,
 * the field keeps the app's width.
 */
export const TEXT_INPUT = '[data-component="text-input-v2"]';

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

/**
 * The keys that move along the browser's project rail, and why the app does not run its own
 * command on them while the browser is open. The app binds `alt+arrowup` and `alt+arrowdown` to
 * the previous and next session tab (packages/app/src/shell/titlebar/tab-strip.tsx:64 at
 * v2.4.2), but its keymap runs no command while a dialog is open
 * (packages/app/src/shell/commands/command.tsx:437). On macOS the Go menu gives the same keys as
 * Option+Up and Option+Down (packages/app/src/shell/commands/desktop-menu.ts:250), and macOS hands
 * the menu only the keys the page leaves unhandled (packages/desktop/src/renderer/platform/menu.ts:26),
 * so the browser calls `preventDefault` on them.
 */
export const RAIL_KEYS = { previous: 'alt+arrowup', next: 'alt+arrowdown' } as const;

/** The `+` menu before the side panel's tabs, where `MenuItem` adds entries (registries.ts:105). */
export const PANEL_MENU = 'session.panel';

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
