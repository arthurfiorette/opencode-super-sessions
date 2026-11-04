import type { BoxRenderable } from '@opentui/core';
import { jsx } from '@opentui/solid/jsx-runtime';
import {
  createComponent,
  createEffect,
  createMemo,
  createSignal,
  Index,
  on,
  onCleanup,
  onMount,
  untrack
} from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { useCliSettings } from './cli-settings.js';
import { createMarquee } from './marquee.js';
import { type Ref, refKey } from './refs/ref.js';
import { sidebarRefs } from './refs/summary.js';
import { type SessionRefView, SuperSessions } from './rpc.js';
import { tuiSettingsFor } from './settings/store.js';
import type { SidebarProps } from './sidebar.js';
import { createSidebarState } from './sidebar-state.js';
import { workRow } from './work-row.js';

const REFRESH_INTERVAL = 60_000;

/**
 * The session's tracked pull requests and issues at the top of the sidebar, without a heading.
 * Earlier versions stored an expanded flag under `sidebar`; nothing reads it any more.
 */
export default function Sidebar(props: SidebarProps) {
  const context = props.context;
  const theme = () => context.theme;
  const [data, setData] = createStore<{ view: SessionRefView | undefined }>({ view: undefined });
  const [width, setWidth] = createSignal(0);
  const cli = useCliSettings();
  const settings = tuiSettingsFor(context);
  // One timer for every row: only the hovered title scrolls, and unmounting clears it.
  const marquee = createMarquee({ animated: () => settings.titleScroll(cli.animations) });
  let box: BoxRenderable | undefined;

  const rpc = context.client.rpc(SuperSessions);
  /**
   * RPC options for a session. Its own Location answers for it, like on the page; the TUI's
   * Location is only a fallback for a session this client has not synced yet.
   */
  const rpcOptions = (sessionID: string) => {
    const location =
      context.data.session.get(sessionID)?.location ??
      context.location ??
      context.data.location.default();
    return { location: { directory: location.directory } };
  };
  const controller = createSidebarState(
    {
      refs: async (sessionID) =>
        (await rpc.refs({ sessionIDs: [sessionID] }, rpcOptions(sessionID)))[sessionID],
      refresh: async (sessionID) =>
        (await rpc.refresh({ sessionIDs: [sessionID] }, rpcOptions(sessionID)))[sessionID]
    },
    (view) => setData(reconcile({ view }))
  );

  const listed = createMemo(() =>
    data.view ? sidebarRefs(data.view) : { refs: [] as Ref[], mentioned: 0 }
  );
  const shown = () => listed().refs.length > 0 || listed().mentioned > 0;
  const stateOf = (ref: Ref) => data.view?.states[refKey(ref)];

  createEffect(on(props.sessionID, (sessionID) => void controller.show(sessionID)));
  let polling: ReturnType<typeof setInterval> | undefined;
  onMount(() => {
    polling = setInterval(() => void controller.refresh(), REFRESH_INTERVAL);
  });
  // Links change through tools, the bash hook and the page; each write updates the metadata.
  const off = context.data.on('session.metadata.updated', (event) => {
    const sessionID = untrack(props.sessionID);
    if (event.data.sessionID === sessionID) void controller.show(sessionID);
  });
  onCleanup(() => {
    clearInterval(polling);
    off();
    controller.dispose();
  });

  /** Key of the session's branch PR, which leads the list with a `branch` marker. */
  const branchKey = () => {
    const ref = data.view?.branchRefs[0];
    return ref === undefined ? undefined : refKey(ref);
  };
  /**
   * One ref line; the shared Work row also draws the preview's Work section. Its review and CI
   * icons stand in for the preview's status line, which the narrow sidebar has no room for.
   */
  const row = (ref: () => Ref, index: number) =>
    workRow({
      context,
      options: props.options,
      theme,
      ref,
      state: () => stateOf(ref()),
      width,
      marquee,
      marker: () => (refKey(ref()) === branchKey() ? 'branch' : undefined),
      id: `super-sessions-sidebar-ref-${index}`
    });

  return jsx('box', {
    flexShrink: 0,
    get visible() {
      return shown();
    },
    ref: (value: BoxRenderable) => {
      box = value;
      setWidth(value.width);
    },
    onSizeChange: () => setWidth(box?.width ?? 0),
    // No heading: the rows sit right under the session title. The host's `gap` between the
    // sidebar sections leaves the blank line before Context.
    children: [
      createComponent(Index, {
        get each() {
          return listed().refs;
        },
        children: row
      }),
      jsx('box', {
        get visible() {
          return listed().mentioned > 0;
        },
        children: jsx('text', {
          wrapMode: 'none',
          get fg() {
            return theme().text.muted;
          },
          get children() {
            return `+${listed().mentioned} mentioned`;
          }
        })
      })
    ]
  });
}
