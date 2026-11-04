import type { OpenCodeEvent, SessionMessageInfo } from '@opencode/client';

// Where the server finds text and commands in host events and stored messages. The fields are
// typed, so a rename fails the typecheck; what the types cannot say is which event carries what,
// and that live events and stored messages key the same text the same way. test/contract checks
// both against a real host. Line numbers refer to the OpenCode repository at v2.2.5.

type Event<Type extends OpenCodeEvent['type']> = Extract<OpenCodeEvent, { type: Type }>;

/** One piece of searchable text and the key the message index stores it under. */
export interface IndexedText {
  sessionID: string;
  key: string;
  text: string;
  created: number;
}

/**
 * The user's prompt in `session.inbox.enqueued` (packages/schema/src/session-event.ts:220). The
 * inbox also queues synthetic and control items, which are not the user's words. Keyed by the
 * inbox id, which becomes the id of the stored user message when the prompt is delivered.
 */
export function userPrompt(event: Event<'session.inbox.enqueued'>): IndexedText | undefined {
  const item = event.data.item;
  if (item.type !== 'user') return undefined;
  return {
    sessionID: event.data.sessionID,
    key: event.data.inboxID,
    text: item.payload.text,
    created: event.created
  };
}

/**
 * Finished assistant text in `session.text.ended` (packages/schema/src/session-event.ts:420).
 * `ordinal` counts only the text parts of the assistant message, which is how
 * {@link storedTexts} counts them too.
 */
export function assistantText(event: Event<'session.text.ended'>): IndexedText {
  const data = event.data;
  return {
    sessionID: data.sessionID,
    key: textKey(data.assistantMessageID, data.ordinal),
    text: data.text,
    created: event.created
  };
}

/**
 * The command and output of a user `!` command in `session.shell.ended`
 * (packages/schema/src/session-event.ts:321). Core publishes `session.shell.*` only from
 * `Session.shell`, never from the agent's shell tool, so a command reaches the plugin through
 * this event or through the tool hook, never both. Core keeps the first MiB of combined stdout
 * and stderr here, and the plugin context has no API to page the rest.
 */
export function shellRun(event: Event<'session.shell.ended'>): {
  sessionID: string;
  command: string;
  output: string;
} {
  const data = event.data;
  return { sessionID: data.sessionID, command: data.shell.command, output: data.output.output };
}

/**
 * The user and assistant text of stored messages, from `session.context` on the server, with
 * the keys live indexing gives the same text through {@link userPrompt} and {@link assistantText}.
 */
export function storedTexts(sessionID: string, messages: readonly SessionMessageInfo[]) {
  const texts: IndexedText[] = [];
  for (const message of messages) {
    if (message.type === 'user') {
      texts.push({ sessionID, key: message.id, text: message.text, created: message.time.created });
    }
    if (message.type !== 'assistant') continue;
    let ordinal = 0;
    for (const part of message.content) {
      if (part.type !== 'text') continue;
      texts.push({
        sessionID,
        key: textKey(message.id, ordinal++),
        text: part.text,
        created: message.time.created
      });
    }
  }
  return texts;
}

/**
 * Time of the user's last message in `session.context`, the only message read a server plugin
 * has. The context starts at the latest compaction (packages/core/src/session/history.ts:184), so
 * a compaction with no user message after it says nothing about when the user last wrote: null
 * then, which is unknown. Undefined when the user never wrote.
 */
export function lastUserMessageAt(
  messages: readonly SessionMessageInfo[]
): number | null | undefined {
  let last: number | undefined;
  for (const message of messages) {
    if (message.type !== 'user') continue;
    if (last === undefined || message.time.created > last) last = message.time.created;
  }
  if (last === undefined && messages.some((message) => message.type === 'compaction')) return null;
  return last;
}

/** Index key of the `ordinal`-th text part of an assistant message. */
function textKey(messageID: string, ordinal: number): string {
  return `${messageID}:${ordinal}`;
}
