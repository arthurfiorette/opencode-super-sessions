import { Command, type DialogHandle, Plugin, Style } from '@opencode/plugin/gui';
import { onCleanup } from 'solid-js';
import { claimCommandKeys } from '../host/gui.js';
import browserCss from './browser/browser.css?inline';
import { openBrowser } from './browser/dialog.js';
import { browserEn } from './browser/en.js';
import { browserPrefs } from './browser/prefs.js';
import { en } from './en.js';
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
  setup(ctx) {
    ctx.add(Style, css);
    ctx.add(Style, browserCss);
    const refs = createRefsStore();
    addStatus(ctx, refs);
    reportPresence(ctx);
    // The open browser, if any. Its keys only ever open it: pressed again, they leave it open
    // rather than stack a second browser or reach a command under it.
    let browser: DialogHandle | undefined;
    const browse = () => {
      if (browser !== undefined) return;
      const handle = openBrowser(ctx, ctx.stores.browser, refs, () => {
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
