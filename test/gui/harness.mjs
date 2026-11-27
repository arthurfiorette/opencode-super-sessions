import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

// Runs the BUILT Desktop GUI bundle (`dist/gui-experimental.cjs`) the way the app's window does:
// evaluated as CommonJS with a `require` that hands out the modules the app provides, the real
// `@opencode/plugin/gui` and Solid's DOM build among them, then `setup(ctx)` under the plugin's
// context. The context, the client and the servers are fakes that record what the GUI asks of
// the app. Run under `bun --conditions=browser`, so `solid-js` resolves to the DOM build the
// window uses.

// The DOM must exist before Solid's DOM build loads.
GlobalRegistrator.register();

const root = new URL('../../', import.meta.url);
const sdk = path.dirname(fileURLToPath(import.meta.resolve('@opencode/plugin/gui')));
// The host's module list and plugin context are not exports of the SDK; the window host reads
// the same files (packages/app/src/runtime/plugin/module.ts and host.tsx at v2.4.0).
const { pluginSharedModules, pluginWindowModules } = await import(path.join(sdk, 'modules.js'));
const { PluginContext } = await import(path.join(sdk, 'internal.js'));
const solid = await import('solid-js');
const web = await import('solid-js/web');

/** The plugin id the app gives the GUI: the server plugin's. */
export const PLUGIN_ID = 'opencode-super-sessions';

/**
 * The modules the app provides to a bundle, each the instance the harness itself uses. A window
 * maps `@opencode/plugin/gui/main` to the window SDK. A provided module that does not resolve
 * from this package is left out, and requiring it fails with its name.
 */
async function providedModules() {
  const modules = new Map();
  for (const name of [...pluginSharedModules, ...pluginWindowModules]) {
    const target = name === '@opencode/plugin/gui/main' ? '@opencode/plugin/gui' : name;
    try {
      modules.set(name, await import(target));
    } catch {
      // Not installed here, such as `@opencode/schema/rpc`; the bundle does not require it yet.
    }
  }
  return modules;
}

/**
 * Evaluates the built bundle and returns its `Plugin.define`. A `require` of anything the app does
 * not provide, such as a Node.js built-in that the window would turn into an inert placeholder,
 * throws, so window code that would silently get a placeholder fails here.
 */
export async function loadBundle(bundle = new URL('dist/gui-experimental.cjs', root)) {
  const modules = await providedModules();
  const code = await readFile(bundle, 'utf8');
  const module = { exports: {} };
  const require = (name) => {
    const found = modules.get(name);
    if (found) return found;
    throw new Error(`The GUI bundle requires ${name}, which the app does not provide`);
  };
  new Function('require', 'module', 'exports', code)(require, module, module.exports);
  return 'default' in module.exports ? module.exports.default : module.exports;
}

/** Polls `read` until it returns something truthy, failing after 5 seconds. */
export async function until(read, what = 'condition') {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/**
 * A fake `OpenCodeClient`. `handlers` answers calls by name: `'session.list'` for
 * `client.session.list(input, options)`, `'rpc.refs'` for this plugin's `refs` RPC. A call without
 * a handler rejects with its name. Every call is recorded in `calls`. Unless a handler replaces
 * them, `plugin.list` lists the server plugin, so RPC calls do not wait for a cold Location, and
 * `location.get` resolves every directory; neither is recorded then.
 */
export function createClient(handlers = {}) {
  const calls = [];
  const call = (name, input, options) => {
    calls.push({ name, input, options });
    const handler = handlers[name];
    if (handler === undefined) return Promise.reject(new Error(`The fake client has no ${name}`));
    return Promise.resolve().then(() => handler(input, options));
  };
  const defaults = {
    'plugin.list': () => ({ data: [{ id: PLUGIN_ID, features: { server: true, rpc: true } }] }),
    'location.get': () => ({})
  };
  const namespace = (prefix) =>
    new Proxy(
      {},
      {
        get: (_, method) =>
          method === 'then'
            ? undefined
            : (input, options) =>
                handlers[`${prefix}.${String(method)}`] === undefined &&
                defaults[`${prefix}.${String(method)}`] !== undefined
                  ? Promise.resolve(defaults[`${prefix}.${String(method)}`](input, options))
                  : call(`${prefix}.${String(method)}`, input, options)
      }
    );
  return new Proxy(
    { calls, rpc: () => namespace('rpc') },
    {
      get: (target, name) =>
        name in target || typeof name !== 'string' ? target[name] : namespace(name)
    }
  );
}

/** The error the host answers an RPC with on a server without the server plugin. */
export function rpcUnavailable() {
  return Object.assign(new Error('RPC is unavailable'), { type: 'rpc.unavailable' });
}

/**
 * A fake `Data` event feed: `on` as the app's, and `emit(event)` to deliver an event to the
 * listeners of its `type`. `session` answers like a server that synced none of the sessions,
 * with every session idle, except the ids in `running`, and no cost. `permissions` holds the
 * pending permission requests by session id, which `permission.asked` and `permission.replied`
 * events change as the app's data does. `models` is the model list of every Location. `synced`
 * records each session, permission and form sync, which asks the server over HTTP, as
 * `['session' | 'permission' | 'form', sessionID]`.
 */
export function createData({ running = [], models = [], permissions = {} } = {}) {
  const listeners = new Map();
  const synced = [];
  const [requests, setRequests] = solid.createSignal(structuredClone(permissions));
  return {
    synced,
    session: {
      get: () => undefined,
      sync: async (id) => void synced.push(['session', id]),
      status: (id) => (running.includes(id) ? 'running' : 'idle'),
      active: () => running,
      root: (id) => id,
      family: () => [],
      cost: () => 0,
      permission: {
        list: (id) => requests()[id] ?? [],
        sessions: () => Object.keys(requests()).filter((id) => requests()[id].length > 0),
        sync: async (id) => void synced.push(['permission', id])
      },
      form: {
        list: () => [],
        sessions: () => [],
        sync: async (id) => void synced.push(['form', id])
      }
    },
    location: { model: { list: () => models }, vcs: { info: () => undefined } },
    on(type, handler) {
      const set = listeners.get(type) ?? new Set();
      listeners.set(type, set);
      set.add(handler);
      return () => set.delete(handler);
    },
    emit(event) {
      // The app's data applies permission events to its store before any listener runs
      // (packages/client/src/solid/data.ts:1451-1460 at v2.4.2).
      const id = event.data?.sessionID;
      if (event.type === 'permission.asked') {
        setRequests((all) => ({ ...all, [id]: [...(all[id] ?? []), event.data] }));
      } else if (event.type === 'permission.replied') {
        setRequests((all) => ({
          ...all,
          [id]: (all[id] ?? []).filter((request) => request.id !== event.data.requestID)
        }));
      }
      for (const handler of listeners.get(event.type) ?? []) handler(event);
    },
    listeners: (type) => listeners.get(type)?.size ?? 0
  };
}

/** A fake `ServerRef`, the app's own server unless `builtin` is false. */
export function createServer({
  id = 'sidecar',
  client = createClient(),
  data = createData(),
  builtin = true
} = {}) {
  return {
    id,
    name: id,
    url: 'http://127.0.0.1:4096',
    client,
    data,
    local: true,
    builtin,
    compatible: true,
    connected: true
  };
}

/** Renders `content()` into a new element of `document.body` under the plugin's context. */
function mount(ctx, content) {
  const container = document.createElement('div');
  document.body.append(container);
  const dispose = solid.createRoot((dispose) => {
    setContext(ctx);
    web.insert(container, content);
    return dispose;
  });
  return {
    container,
    dispose() {
      dispose();
      container.remove();
    }
  };
}

/** Gives the current owner the plugin's context, as the host does around setup and renders. */
function setContext(ctx) {
  const owner = solid.getOwner();
  owner.context = { ...owner.context, [PluginContext.id]: ctx };
}

/** A DOM element with `children` inserted reactively. */
function element(tag, attributes, children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  if (children !== undefined) web.insert(node, children);
  return node;
}

/**
 * Minimal `ctx.ui` components: plain elements a test can find, with the props a test reads as
 * attributes.
 */
function createUi() {
  return {
    Dialog: (props) =>
      element('div', { role: 'dialog', 'data-size': props.size ?? 'fit' }, () => [
        element('h2', {}, () => props.title),
        element('div', { class: 'dialog-body' }, () => props.children),
        element('div', { class: 'dialog-footer' }, () => props.footer)
      ]),
    Loader: () => element('div', { role: 'progressbar' }),
    Icon: (props) => element('i', { 'data-icon': props.name }),
    Button: (props) => {
      const node = element(
        'button',
        props.class ? { class: props.class } : {},
        () => props.children
      );
      node.disabled = props.disabled ?? false;
      node.addEventListener('click', (event) => props.onClick?.(event));
      return node;
    },
    IconButton: (props) => {
      const node = element('button', { 'aria-label': props.label, 'data-icon': props.icon });
      node.addEventListener('click', (event) => props.onClick?.(event));
      return node;
    },
    Tooltip: (props) =>
      element('span', { 'data-tooltip': String(props.value ?? '') }, () => props.children),
    Keybind: (props) => element('kbd', {}, () => props.keys.join('+')),
    Markdown: (props) => element('div', { 'data-markdown': '' }, () => props.text),
    TextInput: (props) => {
      const node = element('input', { 'aria-label': props.label });
      node.value = props.value ?? '';
      node.addEventListener('input', () => props.onInput?.(node.value));
      return node;
    }
  };
}

/**
 * A fake window context for `setup(ctx)`. `options.session` is the routed session
 * (`ctx.sessions.current()`), settable later with `setSession`; `options.openSessions` the other
 * session tabs' refs, which `ctx.sessions.list()` lists after it; `options.servers` the listed
 * servers; `options.stores` the stored values of declared stores; `options.tabs` the open tabs
 * (`ctx.tabs.list()`, `{ key, session }`), settable later with `setTabs`. Records what the GUI
 * does: `added` (every `ctx.add`), `opened` (external URLs), `copied`, `tabs` (`ctx.tabs.open`
 * calls), `closed` (`ctx.tabs.close` keys), `toasts`, `dialogs` (each open dialog's `container`
 * in `document.body`), `asked` (each `confirm` and `prompt` with its options), `layout`
 * (`ctx.layout.open` calls), `toggles` (`ctx.layout.toggle` calls), `hides`
 * (`ctx.layout.hide` calls) and `linked` (each
 * `ctx.links.open` link, with `handled`). `options.links(link)` decides what `ctx.links.open`
 * answers, as a matching `LinkHandler` would; without it no handler matches. `replies` answers
 * `confirm` and `prompt` in order; push to it before the GUI asks. An unanswered question
 * resolves as dismissed.
 */
export function createContext(plugin, options = {}) {
  const [session, setSession] = solid.createSignal(options.session);
  const [openTabs, setTabs] = solid.createSignal(options.tabs ?? []);
  const servers = options.servers ?? [options.session?.server ?? createServer()];
  const closed = [];
  const abort = new AbortController();
  const added = [];
  const opened = [];
  const copied = [];
  const tabs = [];
  const toasts = [];
  const dialogs = [];
  const asked = [];
  const replies = [];
  const layout = [];
  const toggles = [];
  const hides = [];
  const linked = [];
  // Panel keys selected in their pane, by session id, and whether that pane is on screen: what
  // `open`, `toggle` and `hide` change and `state` reads.
  const shown = new Map();
  const [layoutVersion, setLayoutVersion] = solid.createSignal(0);
  const show = (key, id, state) => {
    if (state === undefined) shown.delete(`${id}\n${key}`);
    else shown.set(`${id}\n${key}`, state);
    setLayoutVersion((value) => value + 1);
  };
  const messages = plugin.i18n?.en ?? {};
  const translate = (key, params = {}) =>
    (messages[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(params[name] ?? ''));
  const ctx = {
    id: PLUGIN_ID,
    options: options.options ?? {},
    signal: abort.signal,
    get client() {
      return servers.find((server) => server.builtin)?.client ?? createClient();
    },
    add(registry, item) {
      const entry = { registry: registry.id, item };
      added.push(entry);
      return () => {
        const index = added.indexOf(entry);
        if (index >= 0) added.splice(index, 1);
      };
    },
    list: (registry) => added.filter((entry) => entry.registry === registry.id).map(read),
    t: translate,
    plural: (key, count, params = {}) =>
      translate(`${key}.${count === 1 ? 'one' : 'other'}`, { ...params, count }),
    ui: createUi(),
    stores: createStores(plugin, options.stores),
    // The app-wide name of each declared icon, `<plugin id>:<name>`
    // (`pluginIconName` in packages/plugin/src/gui/host.ts at v2.4.0).
    icons: Object.fromEntries(
      Object.keys(plugin.icons ?? {}).map((name) => [name, `${PLUGIN_ID}:${name}`])
    ),
    appearance: { mode: () => options.mode ?? 'dark', font: () => 'monospace' },
    locale: { locale: () => 'en-US', direction: () => 'ltr' },
    // The routed session, then `options.openSessions`: the other session tabs' `SessionRef`s.
    sessions: {
      current: session,
      list: () => [...(session() ? [session()] : []), ...(options.openSessions ?? [])]
    },
    screen: { current: () => undefined },
    servers: {
      list: () => servers.map((server) => server.id),
      get: (id) => servers.find((server) => server.id === id)
    },
    system: {
      openExternal: (url) => void opened.push(url),
      copy: async (text) => void copied.push(text)
    },
    tabs: {
      list: openTabs,
      open: (target, openOptions) => void tabs.push({ ...target, ...openOptions }),
      focus() {},
      move() {},
      close: (key) => void closed.push(key)
    },
    toast: {
      show(toast) {
        toasts.push(toast);
        return { dismiss() {} };
      }
    },
    dialogs: {
      open(render) {
        const handle = { close: () => mounted.dispose() };
        const mounted = mount(ctx, () => render(handle));
        dialogs.push(mounted);
        return handle;
      },
      active: () => dialogs.some((dialog) => dialog.container.isConnected),
      confirm: async (options) => {
        asked.push({ kind: 'confirm', options });
        return replies.shift() ?? false;
      },
      prompt: async (options) => {
        asked.push({ kind: 'prompt', options });
        return replies.shift();
      }
    },
    links: {
      // The app's link handlers: none matches unless `options.links` answers true for a link.
      open(link) {
        const handled = options.links?.(link) === true;
        linked.push({ ...link, handled });
        return handled;
      },
      exists: () => false
    },
    layout: {
      narrow: () => false,
      ready: () => true,
      open(key, target, openOptions) {
        layout.push({ key, session: target.id, ...openOptions });
        show(key, target.id, 'visible');
      },
      toggle(key, target) {
        toggles.push({ key, session: target.id });
        show(
          key,
          target.id,
          shown.get(`${target.id}\n${key}`) === 'visible' ? undefined : 'visible'
        );
      },
      // Closes the region while the key shows; the tab stays selected in its hidden pane, which
      // the app reads as `active` (selectPanelState in
      // packages/app/src/runtime/plugin/host-layout-machine.ts:17 at v2.4.2).
      hide(key, target) {
        hides.push({ key, session: target.id });
        if (shown.get(`${target.id}\n${key}`) === 'visible') show(key, target.id, 'active');
      },
      state(key, target) {
        layoutVersion();
        return shown.get(`${target.id}\n${key}`) ?? 'closed';
      }
    },
    keybinds: {
      keybind: () => [],
      keys: (bind) => bind.split('+'),
      // The command's default `bind`, read as the app reads it on macOS: `mod` is cmd.
      matches(command, event) {
        const bind = added
          .filter((entry) => entry.registry === 'command')
          .map((entry) => (typeof entry.item === 'function' ? entry.item() : entry.item))
          .find((item) => `${PLUGIN_ID}.${item.id}` === command)?.bind;
        if (bind === undefined) return false;
        const parts = bind.toLowerCase().split('+');
        const has = (name) => parts.includes(name);
        return (
          event.key.toLowerCase() === parts.at(-1) &&
          event.metaKey === (has('mod') || has('cmd')) &&
          event.ctrlKey === has('ctrl') &&
          event.shiftKey === has('shift') &&
          event.altKey === has('alt')
        );
      }
    }
  };
  return {
    ctx,
    added,
    opened,
    copied,
    tabs,
    toasts,
    dialogs,
    asked,
    replies,
    layout,
    toggles,
    hides,
    linked,
    closed,
    setSession,
    setTabs,
    abort
  };
}

/**
 * The plugin's declared stores as the host hands them out (`ctx.stores.name`): loaded, reactive,
 * starting from `values[name]` or the declaration's `initial`.
 */
function createStores(plugin, values = {}) {
  return Object.fromEntries(
    Object.entries(plugin.stores ?? {}).map(([name, declaration]) => {
      const [value, setValue] = solid.createSignal(
        structuredClone(values[name] ?? declaration.initial)
      );
      return [
        name,
        {
          get value() {
            return value();
          },
          ready: () => true,
          update(mutate) {
            const draft = structuredClone(value());
            mutate(draft);
            setValue(() => draft);
          },
          set: (next) => setValue(() => next)
        }
      ];
    })
  );
}

/** An item `ctx.add` received, read the way the host reads a reactive one. */
function read(entry) {
  return typeof entry.item === 'function' ? entry.item() : entry.item;
}

/**
 * Loads the built bundle, or the one at `options.bundle`, such as another checkout's for
 * scripts/bench-gui.mjs, and runs its `setup` with a fake context (see {@link createContext}).
 * Returns the context's records, `items(registryId)` to read what the GUI contributed,
 * `command(id)` to read one command, `slot(at, input)` to render a `Slot`, `panel(id, session)` to
 * render a side `Panel`'s tab of the same id (`session` may be a getter, to route another later), `pill(id, session)` to read what a `ComposerPill`
 * shows (reactive, so read it again after a change), `applyStyles()` to add the GUI's
 * stylesheets to the document for computed styles, and `dispose` to tear the plugin and
 * everything it rendered down.
 */
export async function startGui(options = {}) {
  const plugin = await loadBundle(options.bundle);
  const fake = createContext(plugin, options);
  const rendered = [];
  const dispose = solid.createRoot((dispose) => {
    setContext(fake.ctx);
    const cleanup = plugin.setup(fake.ctx);
    if (typeof cleanup === 'function') solid.onCleanup(cleanup);
    return dispose;
  });
  const items = (registry) =>
    fake.added
      .filter((entry) => entry.registry === registry)
      .map(read)
      .filter(Boolean);
  return {
    plugin,
    ...fake,
    items,
    command: (id) => items('command').find((command) => command.id === id),
    slot(at, input) {
      const shown = items('slot')
        .filter((slot) => slot.at === at)
        .map((slot) => mount(fake.ctx, () => slot.render(input)));
      rendered.push(...shown);
      return shown;
    },
    panel(id, session) {
      const panel = items('panel').find((item) => item.id === id);
      // A function is the routed session's getter, as the host hands it: the render stays
      // mounted and reads the next session from it.
      const current = typeof session === 'function' ? session : () => session;
      const [tab] = panel.list({ session: current(), screen: {}, open: [id] });
      const props = {
        tab,
        screen: {},
        get session() {
          return current();
        }
      };
      const shown = mount(fake.ctx, () => panel.render(props));
      rendered.push(shown);
      return shown;
    },
    /** Adds the stylesheets the GUI contributed to the document, as the app does. */
    applyStyles() {
      for (const css of items('style')) {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.append(style);
      }
    },
    pill(id, session) {
      const pill = items('composer-pill').find((item) => item.id === id);
      return pill.show({ session, screen: {} });
    },
    dispose() {
      for (const mounted of [...rendered, ...fake.dialogs]) mounted.dispose();
      fake.abort.abort();
      dispose();
      document.body.replaceChildren();
      document.head.replaceChildren();
    }
  };
}
