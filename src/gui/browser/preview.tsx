import type { SessionInfo, SessionMessageInfo } from '@opencode/client';
import { createLatest, type ServerRef, usePlugin } from '@opencode/plugin/gui';
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
  untrack
} from 'solid-js';
import { activityTime } from '../../host/session-info.js';
import { formatAge } from '../../page/age.js';
import { chatLines, contextUsage } from '../../page/preview-model.js';
import type { RefsStore } from '../refs-store.js';
import { WorkList } from '../status/work-list.js';

// The browser's preview of the selected session, laid out like the TUI's (src/page/preview.ts and
// src/page/preview-header.ts): the bold title and age, Context (usage, cost, run state), Work, and
// the latest messages filling the rest of the column.

/** The selection settles this long before the preview loads its messages, as in the TUI. */
const FOLLOW_DELAY = 150;
/**
 * Messages loaded per session. `message.list` cannot leave out tool output, and a long session's
 * newest 30 messages measured up to 1.45 MB; the newest 12 at most 184 KB on the same sessions,
 * which still covers the last turn or two the column has room for.
 */
const PAGE_SIZE = 12;
/** A burst of the session's events settles this long before the messages load again. */
const RELOAD_DELAY = 300;

// The host sidebar's Context section formats cost this way, as the TUI's header does.
const MONEY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const COUNT = new Intl.NumberFormat('en-US');

/** Props of {@link Preview}. */
export interface PreviewProps {
  readonly server: ServerRef;
  /** The selected session, as the server last synced it. */
  readonly session: SessionInfo;
  readonly running: boolean;
  readonly now: number;
  readonly refs: RefsStore;
}

/** The latest messages of one session, newest last. */
interface Page {
  readonly sessionID: string;
  readonly messages: readonly SessionMessageInfo[];
}

/** The preview column's content for the selected session. */
export function Preview(props: PreviewProps) {
  const ctx = usePlugin();
  // Moving through the list quickly would otherwise load the messages and the Work list's refs of
  // every row passed, and the Work list's forge refresh would hold a request slot for each.
  const [shown, setShown] = createSignal(untrack(() => props.session.id));
  createEffect(
    on(
      () => props.session.id,
      (id) => {
        const timer = setTimeout(() => setShown(id), FOLLOW_DELAY);
        onCleanup(() => clearTimeout(timer));
      },
      { defer: true }
    )
  );
  /** The Work list's session once the selection settled on it; undefined until then. */
  const workTarget = createMemo(() => {
    const session = props.session;
    if (session.id !== shown()) return undefined;
    return {
      server: props.server,
      sessionID: session.id,
      directory: session.location.directory
    };
  });
  // The shown session's own events load its messages again, like the TUI's preview.
  const [version, setVersion] = createSignal(0);
  let reload: ReturnType<typeof setTimeout> | undefined;
  const changed = (event: { data: { sessionID: string } }) => {
    if (event.data.sessionID !== untrack(shown)) return;
    clearTimeout(reload);
    reload = setTimeout(() => setVersion((value) => value + 1), RELOAD_DELAY);
  };
  const data = untrack(() => props.server.data);
  const offs = [
    data.on('session.text.ended', changed),
    data.on('session.execution.succeeded', changed),
    data.on('session.execution.failed', changed),
    data.on('session.execution.interrupted', changed),
    data.on('session.inbox.delivered', changed)
  ];
  onCleanup(() => {
    clearTimeout(reload);
    for (const off of offs) off();
  });

  const request = createMemo(() => ({ sessionID: shown(), version: version() }));
  // A newer request aborts the one before and drops its answer, so a slow answer for a row the
  // selection passed never lands over the current one.
  const page = createLatest(request, async ({ sessionID }, signal): Promise<Page> => {
    const answer = await untrack(() => props.server.client).message.list(
      { sessionID, order: 'desc', limit: PAGE_SIZE },
      { signal }
    );
    return { sessionID, messages: [...answer.data].reverse() };
  });
  /** The selected session's messages; undefined while they load, never another session's. */
  const messages = () => {
    const latest = page.latest;
    return latest?.sessionID === props.session.id ? latest.messages : undefined;
  };

  const usage = createMemo(() => {
    const loaded = messages();
    if (loaded === undefined) return undefined;
    const session = props.session;
    return contextUsage(
      loaded,
      props.server.data.location.model.list(session.location),
      session.revert?.messageID
    );
  });
  const cost = () => props.server.data.session.cost(props.session.id) || (props.session.cost ?? 0);
  const status = (): 'running' | 'failed' | 'interrupted' | 'idle' => {
    if (props.running) return 'running';
    const outcome = props.session.outcome;
    return outcome === 'failed' || outcome === 'interrupted' ? outcome : 'idle';
  };
  const lines = createMemo(() => {
    const loaded = messages();
    return loaded === undefined ? undefined : chatLines(loaded, props.session.location.directory);
  });

  return (
    <div class="ss-preview-body">
      <div class="ss-preview-head">
        <h3 class="ss-preview-title">{props.session.title || ctx.t('browser.untitled')}</h3>
        <span class="ss-row-age">{formatAge(props.now - activityTime(props.session))}</span>
      </div>
      <section class="ss-section">
        <h4 class="ss-section-title">{ctx.t('browser.preview.context')}</h4>
        <div class="ss-context">
          <Show when={usage()}>
            {(current) => (
              <>
                <span class="ss-context-item">
                  {ctx.t('browser.preview.tokens', { count: COUNT.format(current().tokens) })}
                </span>
                <Show when={current().percent}>
                  {(percent) => (
                    <span class="ss-context-item">
                      {ctx.t('browser.preview.used', { percent: percent() })}
                    </span>
                  )}
                </Show>
              </>
            )}
          </Show>
          <Show when={cost() > 0}>
            <span class="ss-context-item">
              {ctx.t('browser.preview.spent', { cost: MONEY.format(cost()) })}
            </span>
          </Show>
          <span class="ss-context-item ss-context-status" data-status={status()}>
            {ctx.t(`browser.preview.status.${status()}`)}
          </span>
        </div>
      </section>
      <section class="ss-section ss-section-work">
        <h4 class="ss-section-title">{ctx.t('browser.preview.work')}</h4>
        <Show when={workTarget()} fallback={<ctx.ui.Loader />}>
          {(current) => <WorkList refs={props.refs} target={current()} actions />}
        </Show>
      </section>
      <section class="ss-section ss-section-chat" aria-label={ctx.t('browser.preview.messages')}>
        <Switch>
          <Match when={lines() === undefined && page.error !== undefined}>
            <p class="ss-note ss-tone-error">{ctx.t('browser.preview.messagesFailed')}</p>
          </Match>
          <Match when={lines() === undefined}>
            <p class="ss-note">{ctx.t('browser.preview.loading')}</p>
          </Match>
          <Match when={lines()?.length === 0}>
            <p class="ss-note">{ctx.t('browser.preview.noMessages')}</p>
          </Match>
          <Match when={lines()}>
            {(shownLines) => (
              // `column-reverse` keeps the scroll at the newest message, also while the Markdown
              // blocks fill in after they mount, and lets the user scroll up from there.
              <div class="ss-chat">
                <ol class="ss-chat-lines">
                  <For each={shownLines()}>
                    {(line) => (
                      <Switch>
                        <Match when={line.kind === 'user'}>
                          <li class="ss-chat-user" data-chat="user">
                            {line.text}
                          </li>
                        </Match>
                        <Match when={line.kind === 'text'}>
                          <li class="ss-chat-text" data-chat="text">
                            <ctx.ui.Markdown text={line.text} />
                          </li>
                        </Match>
                        <Match when={line.kind === 'tool' ? line : undefined}>
                          {(tool) => (
                            <li
                              class="ss-chat-tool"
                              classList={{
                                'ss-tone-error': tool().failed,
                                'ss-chat-running': tool().running
                              }}
                              data-chat="tool"
                            >
                              {tool().text}
                            </li>
                          )}
                        </Match>
                      </Switch>
                    )}
                  </For>
                </ol>
              </div>
            )}
          </Match>
        </Switch>
      </section>
    </div>
  );
}
