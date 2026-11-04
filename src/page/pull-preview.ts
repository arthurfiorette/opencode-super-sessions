import type { SessionInfo } from '@opencode/client';
import type { Plugin } from '@opencode/plugin/tui';
import type { ResolvedTheme } from '@opencode/theme/tui';
import {
  MouseButton,
  type MouseEvent,
  type RGBA,
  type ScrollBoxRenderable,
  TextAttributes
} from '@opentui/core';
import { jsx } from '@opentui/solid/jsx-runtime';
import {
  createComponent,
  createEffect,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup
} from 'solid-js';
import { createStore } from 'solid-js/store';
import { useCliSettings } from '../cli-settings.js';
import type { Options } from '../config.js';
import { clickLink } from '../link.js';
import { createMarquee } from '../marquee.js';
import { type PullCheck, type PullDetails, type Ref, refKey, refNumber } from '../refs/ref.js';
import { trackedRefs } from '../refs/summary.js';
import type { SessionRefView } from '../rpc.js';
import { tuiSettingsFor } from '../settings/store.js';
import { workRow } from '../work-row.js';
import { ICONS, refColor, STATE_WORDS } from './icons.js';
import { createSyntax } from './preview.js';
import { cells, fitText, formatAge, pullLead, type Segment } from './row.js';
import type { PullRow } from './state.js';

/** Inputs of {@link PullPreview}. */
export interface PullPreviewProps {
  context: Plugin.Context;
  options: Options;
  /** The selected pull request; the pane follows it after a short delay. */
  pull(): PullRow | undefined;
  /** Refs of a session, for the issues its sessions track. */
  refs(sessionID: string): SessionRefView | undefined;
  /** Author, branches, description and checks, from the server. Rejects when it cannot answer. */
  details(ref: Ref): Promise<PullDetails>;
  /** Details a reload fetched, drawn at once when they belong to the pull request on screen. */
  reloaded?(): { key: string; details: PullDetails } | undefined;
  /** Index of the session row the keyboard selected, while the pane has the arrow keys. */
  selectedSession(): number | undefined;
  /** Opens a session, as a click on its row does. */
  open(sessionID: string): void;
  now(): number;
  /** Cells available for text inside the pane. */
  width(): number;
  theme(): ResolvedTheme;
}

const FOLLOW_DELAY = 150;
// Cells taken by a check glyph and its trailing space.
const ICON = 2;

/** A check status's glyph and color, in GitHub's colors; cancelled and skipped read muted. */
function checkLook(status: PullCheck['status'], theme: ResolvedTheme): [string, string | RGBA] {
  const { feedback, muted } = theme.text;
  if (status === 'success') return [ICONS.checksPassing, feedback.success.base];
  if (status === 'failure' || status === 'action_required') {
    return [ICONS.checksFailing, feedback.error.base];
  }
  if (status === 'cancelled') return [ICONS.checksFailing, muted];
  if (status === 'pending') return [ICONS.checksPending, feedback.warning.base];
  if (status === 'skipped') return [ICONS.issueNotPlanned, muted];
  return [ICONS.checksPending, muted];
}

/**
 * The preview of the Pull requests view: title and state, branches, author, review, every CI
 * check, the issues it closes and the ones its sessions track, the description as markdown, and
 * the sessions that worked on it. Details come from one `pull.details` call for the pull request
 * the selection rests on; everything else is snapshot data the list already has.
 */
export function PullPreview(props: PullPreviewProps): JSX.Element {
  const context = props.context;
  const theme = props.theme;
  const muted = () => theme().text.muted;
  const [state, setState] = createStore<{
    pull: PullRow | undefined;
    status: 'loading' | 'ready' | 'error';
    details: PullDetails | undefined;
  }>({ pull: undefined, status: 'loading', details: undefined });
  let token = 0;
  let follow: ReturnType<typeof setTimeout> | undefined;
  /** Shows `pull` and asks for its details, ignoring answers for a pull request left since. */
  const show = (pull: PullRow | undefined) => {
    const current = ++token;
    if (pull === undefined) {
      setState({ pull, status: 'ready', details: undefined });
      return;
    }
    setState({ pull, status: 'loading', details: undefined });
    // A synchronous throw, such as an RPC client without the method, reads as a failed load.
    Promise.resolve()
      .then(() => props.details(pull.ref))
      .then(
        (details) => {
          if (current === token) setState({ status: 'ready', details });
        },
        () => {
          if (current === token) setState({ status: 'error' });
        }
      );
  };
  // Moving through the list quickly would otherwise ask the forge for every row passed. A new
  // snapshot of the pull request on screen redraws at once without asking again.
  createEffect(
    on(props.pull, (pull) => {
      clearTimeout(follow);
      if (pull !== undefined && pull.key === state.pull?.key) {
        setState('pull', pull);
        return;
      }
      follow = setTimeout(() => show(pull), FOLLOW_DELAY);
    })
  );
  onCleanup(() => clearTimeout(follow));
  createEffect(
    on(
      () => props.reloaded?.(),
      (fresh) => {
        if (fresh === undefined || fresh.key !== state.pull?.key) return;
        // An answer still loading for the old details is dropped.
        token++;
        setState({ status: 'ready', details: fresh.details });
      },
      { defer: true }
    )
  );

  const cli = useCliSettings();
  const marquee = createMarquee({
    animated: () => tuiSettingsFor(context).titleScroll(cli.animations)
  });
  const syntax = createSyntax(context, theme);
  const pull = () => state.pull;
  const status = () => pull()?.state?.status;
  const width = () => Math.max(0, Math.floor(props.width()));
  const details = () => state.details;
  const checks = () => details()?.checks ?? [];
  const review = () =>
    status() === 'open' || status() === 'draft' ? pull()?.state?.review : undefined;

  /** A muted line, or one in `fg`, cut to the pane and hidden while empty. */
  const line = (text: () => string, fg: () => string | RGBA = muted) =>
    jsx('text', {
      flexShrink: 0,
      wrapMode: 'none',
      get visible() {
        return text() !== '';
      },
      get fg() {
        return fg();
      },
      get children() {
        return fitText(text(), width());
      }
    });
  /** Colored segments on one line, cut to the pane and hidden while empty. */
  const segments = (parts: () => Segment[]) =>
    jsx('text', {
      flexShrink: 0,
      wrapMode: 'none',
      get visible() {
        return parts().length > 0;
      },
      get children() {
        let left = width();
        return parts().flatMap((part) => {
          if (left <= 0) return [];
          const text = fitText(part.text, left);
          left -= cells(text);
          return [
            jsx('span', { style: { fg: part.fg, bold: part.bold ?? false }, children: text })
          ];
        });
      }
    });
  /** A bold heading over `children`, a blank line above it, hidden while `visible()` is false. */
  const section = (title: () => string, visible: () => boolean, children: JSX.Element[]) =>
    jsx('box', {
      flexShrink: 0,
      paddingTop: 1,
      get visible() {
        return visible();
      },
      children: [
        jsx('text', {
          get fg() {
            return theme().text.base;
          },
          get children() {
            return jsx('b', { children: title() });
          }
        }),
        ...children
      ]
    });

  /** Issues to list: the ones it closes, then the other issues its sessions track. */
  const issues = (): Array<{ ref: Ref; closes: boolean }> => {
    const current = pull();
    if (current === undefined) return [];
    const found = new Map<string, { ref: Ref; closes: boolean }>();
    for (const issue of current.state?.closes ?? []) {
      found.set(refKey(issue), { ref: issue, closes: true });
    }
    for (const session of current.sessions) {
      const view = props.refs(session.id);
      if (view === undefined) continue;
      for (const link of view.links) {
        if (link.source === 'closes' && link.via === current.key && !found.has(refKey(link.ref))) {
          found.set(refKey(link.ref), { ref: link.ref, closes: true });
        }
      }
      for (const tracked of trackedRefs(view)) {
        if (tracked.kind === 'issue' && !found.has(refKey(tracked))) {
          found.set(refKey(tracked), { ref: tracked, closes: false });
        }
      }
    }
    return [...found.values()];
  };
  /** An issue's state from any of the sessions' views. */
  const issueState = (issue: Ref) => {
    for (const session of pull()?.sessions ?? []) {
      const found = props.refs(session.id)?.states[refKey(issue)];
      if (found) return found;
    }
    return undefined;
  };

  const header = jsx('box', {
    flexShrink: 0,
    children: [
      jsx('text', {
        flexShrink: 0,
        get fg() {
          return theme().text.base;
        },
        children: jsx('b', {
          get children() {
            const current = pull();
            return current?.state?.title ?? (current ? refNumber(current.ref) : '');
          }
        })
      }),
      segments(() => {
        const current = pull();
        if (current === undefined) return [];
        const word = current.state === undefined ? 'unknown' : STATE_WORDS[current.state.status];
        return [
          ...pullLead(current.ref, current.state, {
            options: props.options,
            theme: theme(),
            mode: context.themeMode
          }),
          { text: ` ${word}`, fg: refColor(props.options, status(), theme(), context.themeMode) }
        ];
      }),
      line(() => {
        const found = details();
        return found?.head === undefined || found.base === undefined
          ? ''
          : `${found.head} -> ${found.base}`;
      }),
      line(() => (details()?.author ? `by ${details()?.author}` : '')),
      segments(() => {
        const current = review();
        if (current === undefined) return [];
        const { feedback } = theme().text;
        const parts: Segment[] = [];
        if (current.decision === 'changes_requested') {
          parts.push({ text: 'changes requested', fg: feedback.error.base });
        } else if (current.decision === 'approved') {
          parts.push({ text: 'approved', fg: feedback.success.base });
        } else if (current.decision === 'review_required') {
          parts.push({ text: 'review required', fg: muted() });
        }
        const count = current.unresolved ?? 0;
        if (count > 0) {
          if (parts.length > 0) parts.push({ text: ' · ', fg: muted() });
          parts.push({
            text: `${count} unresolved ${count === 1 ? 'thread' : 'threads'}`,
            fg: feedback.warning.base
          });
        }
        return parts;
      })
    ]
  });

  const checksSection = section(
    () => {
      const current = review();
      return current?.checksTotal === undefined
        ? 'Checks'
        : `Checks ${current.checksPassed ?? 0}/${current.checksTotal}`;
    },
    () => state.status !== 'ready' || checks().length > 0,
    [
      line(
        () =>
          state.status === 'error'
            ? 'Could not load the details.'
            : state.status === 'loading'
              ? 'Loading…'
              : '',
        () => (state.status === 'error' ? theme().text.feedback.error.base : muted())
      ),
      createComponent(For, {
        get each() {
          return checks();
        },
        children: (check: PullCheck) => {
          // A check with a page is a link: hover makes its name bold, like a Work row's number.
          const [hovered, setHovered] = createSignal(false);
          return jsx('box', {
            flexDirection: 'row',
            height: 1,
            flexShrink: 0,
            onMouseOver: () => setHovered(check.url !== undefined),
            onMouseOut: () => setHovered(false),
            onMouseUp: (event: MouseEvent) => {
              clickLink(context, check.url, event);
            },
            children: segments(() => {
              const [glyph, fg] = checkLook(check.status, theme());
              return [
                { text: `${glyph} `, fg },
                {
                  text: fitText(check.name, width() - ICON),
                  fg: theme().text.base,
                  bold: hovered()
                }
              ];
            })
          });
        }
      }),
      line(() =>
        details()?.checksTruncated === true ? 'More checks ran than the first 100 shown.' : ''
      )
    ]
  );

  const issuesSection = section(
    () => 'Issues',
    () => issues().length > 0,
    [
      createComponent(For, {
        get each() {
          return issues();
        },
        children: (item: { ref: Ref; closes: boolean }) =>
          workRow({
            context,
            options: props.options,
            theme,
            ref: () => item.ref,
            state: () => issueState(item.ref),
            width,
            marquee,
            marker: () => (item.closes ? 'closes' : undefined)
          })
      })
    ]
  );

  const description = section(
    () => 'Description',
    () => state.status === 'ready' && (details()?.body.trim() ?? '') !== '',
    [
      jsx('markdown', {
        get syntaxStyle() {
          return syntax().markdown;
        },
        get content() {
          return details()?.body.trim() ?? '';
        },
        internalBlockMode: 'top-level',
        tableOptions: { style: 'grid', cellPaddingX: 1 },
        conceal: true,
        get fg() {
          return theme().markdown.text;
        },
        get bg() {
          return theme().background.base;
        }
      })
    ]
  );

  const sessionsSection = section(
    () => {
      const count = pull()?.sessions.length ?? 0;
      return count === 1 ? 'Session' : `Sessions ${count}`;
    },
    () => (pull()?.sessions.length ?? 0) > 0,
    [
      createComponent(For, {
        get each() {
          return pull()?.sessions ?? [];
        },
        children: (session: SessionInfo, index: () => number) => {
          const selected = () => props.selectedSession() === index();
          const age = () => formatAge(props.now() - session.time.updated);
          const fg = (fallback: string | RGBA) =>
            selected() ? theme().text.action.primary.focused : fallback;
          return jsx('box', {
            flexDirection: 'row',
            height: 1,
            flexShrink: 0,
            get backgroundColor() {
              return selected() ? theme().background.action.primary.focused : undefined;
            },
            onMouseUp: (event: MouseEvent) => {
              if (event.button !== MouseButton.LEFT) return;
              event.stopPropagation();
              props.open(session.id);
            },
            children: [
              jsx('text', {
                flexGrow: 1,
                flexShrink: 1,
                minWidth: 0,
                wrapMode: 'none',
                get fg() {
                  return fg(theme().text.base);
                },
                get attributes() {
                  return selected() ? TextAttributes.BOLD : TextAttributes.NONE;
                },
                get children() {
                  return fitText(session.title || 'Untitled session', width() - cells(age()) - 2);
                }
              }),
              jsx('text', {
                flexShrink: 0,
                wrapMode: 'none',
                get fg() {
                  return fg(muted());
                },
                get children() {
                  return `  ${age()}`;
                }
              })
            ]
          });
        }
      })
    ]
  );

  let scroll: ScrollBoxRenderable | undefined;
  // The sessions come last; when the keyboard moves into them, the pane scrolls down to them.
  createEffect(
    on(
      () => props.selectedSession(),
      (index) => {
        if (index !== undefined) scroll?.scrollTo(Number.POSITIVE_INFINITY);
      },
      { defer: true }
    )
  );
  createEffect(
    on(
      () => state.pull?.key,
      () => scroll?.scrollTo(0),
      { defer: true }
    )
  );

  return jsx('box', {
    flexDirection: 'column',
    flexGrow: 1,
    minWidth: 0,
    paddingLeft: 1,
    paddingRight: 1,
    get visible() {
      return pull() !== undefined;
    },
    children: jsx('scrollbox', {
      flexGrow: 1,
      horizontalScrollbarOptions: { visible: false },
      // The host's session transcript bar (routes/session/index.tsx), under the same setting.
      get viewportOptions() {
        return { paddingRight: cli.session.scrollbar ? 1 : 0 };
      },
      get verticalScrollbarOptions() {
        return {
          paddingLeft: 1,
          visible: cli.session.scrollbar,
          trackOptions: {
            backgroundColor: theme().decrease(theme().background.raised.base),
            foregroundColor: theme().border.base
          }
        };
      },
      ref: (value: ScrollBoxRenderable) => {
        scroll = value;
      },
      children: [header, checksSection, issuesSection, description, sessionsSection]
    })
  });
}
