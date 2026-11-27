import { Command, type DialogHandle, Plugin, Style } from '@opencode/plugin/gui';
import { onCleanup, untrack } from 'solid-js';
import { claimCommandKeys } from '../host/gui.js';
import browserCss from './browser/browser.css?inline';
import { openBrowser } from './browser/dialog.js';
import { browserEn } from './browser/en.js';
import { createMachines } from './browser/machines.js';
import { browserPrefs, opensOnAll } from './browser/prefs.js';
import { en } from './en.js';
import { createForgeQueue } from './forge-queue.js';
import { octiconSvg } from './octicons.js';
import { reportPresence } from './presence.js';
import { createRefsStore } from './refs-store.js';
import { addSidePanel } from './side/index.js';
import { sidePrefs } from './side/prefs.js';
import { addStatus } from './status/index.js';
import css from './styles.css?inline';

// The OpenCode Desktop GUI, loaded from the package's `./gui-experimental` export. The host gives
// it the server plugin's id and options. Setup stays synchronous and keeps every piece of state
// inside it: the host runs it once per window and again after each reload.
export default Plugin.define({
  i18n: { en: { ...en, ...browserEn } },
  stores: { browser: browserPrefs, side: sidePrefs },
  // The app's icon catalog has no pull request glyph, and the pill, the side tab's menu item and
  // its narrow-screen view take only icon names.
  icons: {
    pull: octiconSvg('git-pull-request'),
    pullDraft: octiconSvg('git-pull-request-draft')
  },
  setup(ctx) {
    ctx.add(Style, css);
    ctx.add(Style, browserCss);
    reportPresence(ctx);
    // Every server's browser model, made on first use by the dialog or the side tab and kept for
    // the window's life, so both draw the cached lists at once. The dialog's first project pick,
    // until it picks, is the user's last, else the `scope` option.
    const machines = createMachines(
      ctx,
      opensOnAll(
        untrack(() => ctx.stores.browser.value),
        ctx.options.scope
      )
        ? { type: 'all' }
        : { type: 'routed' }
    );
    // A session the browser listed shows its refs from the browser's copy at once, so the side
    // tab's Work section and the header never wait on the `refs` RPC after a session switch.
    const refs = createRefsStore(
      createForgeQueue(),
      (target) => machines.made(target.server.id)?.data.refs[target.sessionID]
    );
    // The open browser, if any. Its keys only ever open it: pressed again, they leave it open
    // rather than stack a second browser or reach a command under it.
    let browser: DialogHandle | undefined;
    const browse = () => {
      if (browser !== undefined) return;
      const handle = openBrowser(ctx, ctx.stores.browser, refs, machines, () => {
        if (browser === handle) browser = undefined;
      });
      browser = handle;
    };
    const side = addSidePanel(ctx, {
      refs,
      icons: ctx.icons,
      machines,
      sidePrefs: ctx.stores.side,
      browse
    });
    addStatus(ctx, refs, ctx.icons, side);
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
