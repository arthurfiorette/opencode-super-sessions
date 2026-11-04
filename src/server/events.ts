import type { OpenCodeEvent } from '@opencode/client';
import type { Plugin } from '@opencode/plugin';
import { FORM_EVENT_TYPES, type FormEvent } from '../host/forms.js';

/**
 * Event types the server reacts to: user prompts and finished assistant text, plus deletions so
 * the message index forgets deleted sessions. `session.shell.ended` carries the commands users
 * type with `!`, which run through `Session.shell` and never reach the agent's shell tool hook.
 */
export const EVENT_TYPES = [
  'session.inbox.enqueued',
  'session.text.ended',
  'session.shell.ended',
  'session.deleted'
] as const;

export type HandledEvent = Extract<OpenCodeEvent, { type: (typeof EVENT_TYPES)[number] }>;

/**
 * Events that start an auto-archive and cleanup sweep: a session finished running (it may be
 * Done now) or was deleted (its worktree may be unused now). Kept apart from {@link EVENT_TYPES}
 * so the detection handler only ever sees the events it parses.
 */
export const LIFECYCLE_TYPES = [
  'session.deleted',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted'
] as const;

export type LifecycleEvent = Extract<OpenCodeEvent, { type: (typeof LIFECYCLE_TYPES)[number] }>;

/** Every event the process-wide subscriber receives. Form events track pending questions. */
export type SubscribedEvent = HandledEvent | LifecycleEvent | FormEvent;

const SUBSCRIBED_TYPES = [...new Set([...EVENT_TYPES, ...LIFECYCLE_TYPES, ...FORM_EVENT_TYPES])];
const handledTypes: ReadonlySet<string> = new Set(EVENT_TYPES);

/** Whether the detection handler parses this event. */
export function isHandledEvent(event: SubscribedEvent): event is HandledEvent {
  return handledTypes.has(event.type);
}

/** The parts of a Location's plugin context the subscriber and its handler use. */
export type EventContext = Pick<Plugin.Context, 'event' | 'session'>;

export interface EventHub {
  /**
   * Adds a live Location context. The first one owns the process-wide subscription. Returns the
   * detach function to call from the plugin's cleanup; detaching the owner hands the subscription
   * to the next live context, or stops it when none is left.
   */
  attach(context: EventContext): () => void;
  /** The oldest live context, for background jobs; undefined once every Location detached. */
  current(): EventContext | undefined;
}

export interface EventHubOptions {
  /** Handles one event with the context that owns the subscription. Failures are reported to `onError`. */
  handle(event: SubscribedEvent, context: EventContext): Promise<void>;
  onError(error: unknown): void;
  /** Event ids remembered for dedupe. */
  memory?: number;
  /** Delay before resubscribing after the stream ends on its own. */
  retryMs?: number;
}

/**
 * Creates the process-wide event subscriber. `event.subscribe` is not Location-scoped: every
 * Location sees every event, so subscribing from each Location would handle each prompt once per
 * open Location and write the same link N times.
 */
export function createEventHub(options: EventHubOptions): EventHub {
  const live: EventContext[] = [];
  const seen = new Set<string>();
  const memory = options.memory ?? 1024;
  let owner: { context: EventContext; abort: AbortController } | undefined;
  let retry: NodeJS.Timeout | undefined;

  /** Records an id and reports whether it was new. Evicts the oldest ids past `memory`. */
  const first = (id: string) => {
    if (seen.has(id)) return false;
    seen.add(id);
    // Sets iterate in insertion order, so the first value is the oldest id.
    for (const old of seen) {
      if (seen.size <= memory) break;
      seen.delete(old);
    }
    return true;
  };

  /** Reads the owner's stream until it ends or ownership moves. */
  const consume = async (context: EventContext, signal: AbortSignal) => {
    for await (const event of context.event.subscribe({ types: SUBSCRIBED_TYPES, signal })) {
      if (signal.aborted) break;
      // A handover resubscribes on another Location's stream, which may deliver an event the old
      // stream already did. Ids are global, so the seen set catches it.
      if (!first(event.id)) continue;
      // Handlers wait on the forge; running them inline would stall every later event.
      options.handle(event, context).catch(options.onError);
    }
  };

  /** Starts the subscription on the oldest live context when nobody owns it. */
  const start = () => {
    if (owner !== undefined) return;
    const context = live[0];
    if (context === undefined) return;
    const abort = new AbortController();
    owner = { context, abort };
    consume(context, abort.signal)
      .catch((error: unknown) => {
        if (!abort.signal.aborted) options.onError(error);
      })
      .finally(() => {
        if (owner?.abort !== abort) return;
        owner = undefined;
        if (abort.signal.aborted) return;
        // The stream ended while its Location was still attached, for example during a host
        // reload. Waiting avoids a tight loop when the context keeps failing until it detaches.
        retry ??= setTimeout(() => {
          retry = undefined;
          start();
        }, options.retryMs ?? 1000);
        retry.unref?.();
      });
  };

  return {
    attach(context) {
      live.push(context);
      start();
      return () => {
        const index = live.indexOf(context);
        if (index !== -1) live.splice(index, 1);
        if (owner?.context !== context) return;
        owner.abort.abort();
        owner = undefined;
        start();
      };
    },
    current: () => live[0]
  };
}
