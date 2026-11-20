import { Command, Plugin, Style } from '@opencode/plugin/gui';
import { en } from './en.js';
import { TrackedWork } from './placeholder.js';
import { createRefsStore } from './refs-store.js';
import css from './styles.css?inline';

// The OpenCode Desktop GUI, loaded from the package's `./gui-experimental` export. The host gives
// it the server plugin's id and options. Setup stays synchronous and keeps every piece of state
// inside it: the host runs it once per window and again after each reload.
export default Plugin.define({
  i18n: { en },
  setup(ctx) {
    ctx.add(Style, css);
    const refs = createRefsStore();
    ctx.add(
      Command,
      (): Command => ({
        id: 'browse',
        title: ctx.t('command.browse'),
        bind: 'mod+shift+s',
        run: () => {
          ctx.dialogs.open(() => (
            <ctx.ui.Dialog title={ctx.t('browser.title')} size="x-large">
              <TrackedWork refs={refs} />
            </ctx.ui.Dialog>
          ));
        }
      })
    );
  }
});
