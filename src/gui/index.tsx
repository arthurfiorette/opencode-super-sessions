import { Command, type DialogHandle, Plugin, type ServerRef, Style } from '@opencode/plugin/gui';
import { createRoot, getOwner, onCleanup } from 'solid-js';
import { claimCommandKeys } from '../host/gui.js';
import browserCss from './browser/browser.css?inline';
import { openBrowser } from './browser/dialog.js';
import { browserEn } from './browser/en.js';
import { type BrowserModel, createBrowserModel } from './browser/model.js';
import { browserPrefs } from './browser/prefs.js';
import { en } from './en.js';
import { createForgeQueue } from './forge-queue.js';
import { octiconSvg } from './octicons.js';
import { reportPresence } from './presence.js';
import { createRefsStore } from './refs-store.js';
import { addStatus } from './status/index.js';
import css from './styles.css?inline';

// The OpenCode Desktop GUI, loaded from the package's `./gui-experimental` export. The host gives
// it the server plugin's id and options. Setup stays synchronous and keeps every piece of state
// inside it: the host runs it once per window and again after each reload.
export default Plugin.define({
  i18n: { en: { ...en, ...browserEn } },
  stores: { browser: browserPrefs },
  // The app's icon catalog has no pull request glyph, and the pill, the panel tab and its menu
  // item take only icon names.
  icons: {
    pull: octiconSvg('git-pull-request'),
    pullDraft: octiconSvg('git-pull-request-draft')
  },
  setup(ctx) {
    ctx.add(Style, css);
    ctx.add(Style, browserCss);
    const refs = createRefsStore(createForgeQueue());
    addStatus(ctx, refs, ctx.icons);
    reportPresence(ctx);
    // One browser model per server, made on the first open and kept for the window's life, so a
    // reopen draws the cached lists at once. Each gets a root under setup's owner, since the first
    // open runs from a command, outside any owner, and the roots end with setup.
    const owner = getOwner();
    // By server id: each mounted session hands out a ref of its own for its server, which lives
    // with that session's screen, while the app's server list keeps one ref per server for the
    // window (packages/app/src/runtime/plugin/host-apis.tsx:547 at v2.4.2). The model takes the
    // window's, so it outlives the session it first opened over.
    const models = new Map<string, { model: BrowserModel; dispose: () => void }>();
    /** The server's browser model, created on first use. */
    const modelFor = (server: ServerRef): BrowserModel => {
      const known = models.get(server.id);
      if (known !== undefined) return known.model;
      const ref = ctx.servers.get(server.id) ?? server;
      const entry = createRoot((dispose) => ({ model: createBrowserModel(ref), dispose }), owner);
      models.set(server.id, entry);
      return entry.model;
    };
    onCleanup(() => {
      for (const entry of models.values()) entry.dispose();
      models.clear();
    });
    // The open browser, if any. Its keys only ever open it: pressed again, they leave it open
    // rather than stack a second browser or reach a command under it.
    let browser: DialogHandle | undefined;
    const browse = () => {
      if (browser !== undefined) return;
      const handle = openBrowser(ctx, ctx.stores.browser, refs, modelFor, () => {
        if (browser === handle) browser = undefined;
      });
      browser = handle;
    };
    ctx.add(
      Command,
      (): Command => ({
        id: 'browse',
        title: ctx.t('command.browse'),
        bind: 'mod+shift+s',
        editable: true,
        run: browse
      })
    );
    // OpenCode Desktop 2.4 archives the open session on the same keys; see claimCommandKeys.
    onCleanup(
      claimCommandKeys<KeyboardEvent>(
        window,
        (event) => ctx.keybinds.matches(`${ctx.id}.browse`, event),
        browse
      )
    );
  }
});
