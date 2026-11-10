import type { OpenCodeEvent } from '@opencode/client';

// Questions (forms) waiting on the user, seen from the server plugin. The TUI reads them from
// `context.data.session.form`, but the server plugin context has no form domain, so the server
// follows the form events instead (packages/schema/src/form.ts:173 at v2.2.7). They are ephemeral:
// a form lives in the daemon's memory, so none outlives the daemon, and the events seen since the
// plugin subscribed cover every form there is.

/** The form events, in the order a form goes through them. */
export const FORM_EVENT_TYPES = ['form.created', 'form.replied', 'form.cancelled'] as const;

export type FormEvent = Extract<OpenCodeEvent, { type: (typeof FORM_EVENT_TYPES)[number] }>;

const formTypes: ReadonlySet<string> = new Set(FORM_EVENT_TYPES);

/** Whether an event is one of the {@link FORM_EVENT_TYPES}. */
export function isFormEvent(event: { type: string }): event is FormEvent {
  return formTypes.has(event.type);
}

/** Open forms by session, kept up to date from the form events. */
export interface PendingForms {
  apply(event: FormEvent): void;
  /** Whether a question waits on the session. */
  has(sessionID: string): boolean;
}

/** Creates an empty {@link PendingForms}. */
export function createPendingForms(): PendingForms {
  // Form id to session id. An answer or a cancel names the form, so it closes exactly that one.
  const open = new Map<string, string>();
  return {
    apply(event) {
      if (event.type === 'form.created') open.set(event.data.form.id, event.data.form.sessionID);
      else open.delete(event.data.id);
    },
    has(sessionID) {
      for (const owner of open.values()) if (owner === sessionID) return true;
      return false;
    }
  };
}
