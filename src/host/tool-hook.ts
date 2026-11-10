import type { Plugin } from '@opencode/plugin';

// The agent's shell tool as the `execute.after` hook reports it. Its input and output are
// `unknown` in the plugin types, so a change there would pass the typecheck and only stop ref
// detection. test/contract runs a real agent shell call through this reader.

/** Name of the host's shell tool (packages/core/src/tool/plugin/shell.ts:21 in OpenCode v2.2.7). */
export const SHELL_TOOL = 'shell';

// `hook` is generic over every tool hook; `execute.after` is the payload with a status.
type AfterEvent = Extract<
  Parameters<Parameters<Plugin.Context['tool']['hook']>[1]>[0],
  { readonly status: unknown }
>;

/**
 * The command and output of a finished agent shell call, or undefined for other tools, failed
 * calls and background commands. The input is `{ command }` and the output
 * `{ output, status?, exit? }` (`Input` and `Output` in packages/core/src/tool/plugin/shell.ts).
 * Background commands report `status: 'running'` with partial output, whose URLs are not final.
 */
export function shellCall(
  event: AfterEvent
): { sessionID: string; command: string; output: string } | undefined {
  if (event.tool !== SHELL_TOOL || event.status !== 'completed') return undefined;
  const command = isRecord(event.input) ? event.input.command : undefined;
  const result = event.result.output;
  if (typeof command !== 'string' || !isRecord(result) || result.status === 'running') {
    return undefined;
  }
  const output = typeof result.output === 'string' ? result.output : '';
  return { sessionID: event.sessionID, command, output };
}

/** Narrows an unknown value to a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
