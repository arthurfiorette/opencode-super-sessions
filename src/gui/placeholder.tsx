import { usePlugin } from '@opencode/plugin/gui';
import { createMemo, For, Match, Switch } from 'solid-js';
import { refKey } from '../refs/ref.js';
import { sidebarRefs, workLinks } from '../refs/summary.js';
import { RefLine, WorkLinkLine } from './ref-view.js';
import type { RefsStore, SessionTarget } from './refs-store.js';

// The browser command's dialog until the session browser replaces it: the routed session's
// tracked refs and work links, drawn by the shared ref lines.

/** Props of {@link TrackedWork}. */
export interface TrackedWorkProps {
  readonly refs: RefsStore;
}

/** The routed session's pull requests, issues and work links, like the TUI sidebar lists them. */
export function TrackedWork(props: TrackedWorkProps) {
  const ctx = usePlugin();
  const target = (): SessionTarget | undefined => {
    const session = ctx.sessions.current();
    return session === undefined
      ? undefined
      : { server: session.server, sessionID: session.id, directory: session.directory };
  };
  const state = props.refs.use(target);
  const view = () => state()?.view;
  const listed = createMemo(() => {
    const current = view();
    return current === undefined ? [] : sidebarRefs(current).refs;
  });
  const links = createMemo(() => {
    const current = view();
    return current === undefined ? [] : workLinks(current);
  });
  return (
    <div class="ss-work">
      <Switch>
        <Match when={state() === undefined}>
          <p class="ss-note">{ctx.t('refs.none')}</p>
        </Match>
        <Match when={state()?.status === 'unavailable'}>
          <p class="ss-note">{ctx.t('refs.unavailable')}</p>
        </Match>
        <Match when={state()?.status === 'loading'}>
          <ctx.ui.Loader />
        </Match>
        <Match when={listed().length === 0 && links().length === 0}>
          <p class="ss-note">{ctx.t('refs.empty')}</p>
        </Match>
        <Match when={true}>
          <ul class="ss-work-list">
            <For each={listed()}>
              {(ref) => (
                <li>
                  <RefLine item={ref} state={view()?.states[refKey(ref)]} />
                </li>
              )}
            </For>
            <For each={links()}>
              {(link) => (
                <li>
                  <WorkLinkLine link={link} />
                </li>
              )}
            </For>
          </ul>
        </Match>
      </Switch>
    </div>
  );
}
