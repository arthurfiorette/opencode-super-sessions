import { type SessionRef, usePlugin } from '@opencode/plugin/gui';
import { createContext, type JSX, useContext } from 'solid-js';
import { type LinkModifiers, openWebLink } from '../host/gui.js';

// Where the GUI's links open. Each surface says which session its links belong to, so the app's
// link setting (Settings > Browser) can open them in that session's browser pane
// (`openWebLink` in src/host/gui.ts). A surface without a session opens them in the system
// browser.

/** The session a surface's links belong to, and what to do once one opened. */
export interface LinkScope {
  /** The open session the links belong to; undefined sends them to the system browser. */
  session(): SessionRef | undefined;
  /** Runs after a link opened, in the app's pane or in the system browser. */
  opened?(where: 'app' | 'system', session: SessionRef | undefined): void;
}

/** No session: every link goes to the system browser, as outside any surface. */
const NONE: LinkScope = { session: () => undefined };

const LinkScopeContext = createContext<LinkScope>(NONE);

/** Gives the links rendered under it their session. */
export function LinkScopeProvider(props: { scope: LinkScope; children: JSX.Element }) {
  return (
    <LinkScopeContext.Provider value={props.scope}>{props.children}</LinkScopeContext.Provider>
  );
}

/** Opens an http(s) URL; `event` is the click, whose modifiers send it to the system browser. */
export type OpenUrl = (url: string, event?: LinkModifiers) => void;

/** Whether a URL is an http(s) page, the only kind the GUI opens. */
export function webUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/** The opener of the surface the caller renders in. Call it while rendering. */
export function useOpenUrl(): OpenUrl {
  const ctx = usePlugin();
  const scope = useContext(LinkScopeContext);
  return (url, event) => {
    if (!webUrl(url)) return;
    const session = scope.session();
    const where = openWebLink(ctx, url, session, event);
    scope.opened?.(where, session);
  };
}
