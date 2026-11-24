import type { Plugin } from '@opencode/plugin';

// The agent's shell tool as the `execute.after` hook reports it. Its input and output are
// `unknown` in the plugin types, so a change there would pass the typecheck and only stop ref
// detection. test/contract runs a real agent shell call through this reader. Line numbers refer
// to the OpenCode repository at v2.4.0.

/** Name of the host's shell tool (packages/core/src/tool/plugin/shell.ts:28). */
export const SHELL_TOOL = 'shell';

// `hook` is generic over every tool hook; `execute.after` is the payload with a status.
type AfterEvent = Extract<
  Parameters<Parameters<Plugin.Context['tool']['hook']>[1]>[0],
  { readonly status: unknown }
>;

/**
 * The command and output of a finished agent shell call, or undefined for other tools, failed
 * calls and background commands. The input is `{ command }` (`Input` and `CodeModeInput` in
 * packages/core/src/tool/plugin/shell.ts:63) and the output `{ output, exitCode, shellID? }`
 * (`toolResult`, shell.ts:121). A command still running in the background reports
 * `metadata.status: 'running'` (shell.ts:132) and a notice as its output, whose URLs are not
 * final. The same reader serves Code Mode calls, which fire the hook under the tool's own name.
 */
export function shellCall(
  event: AfterEvent
): { sessionID: string; command: string; output: string } | undefined {
  if (event.tool !== SHELL_TOOL || event.status !== 'completed') return undefined;
  const command = isRecord(event.input) ? event.input.command : undefined;
  const result = event.result.output;
  if (typeof command !== 'string' || !isRecord(result)) return undefined;
  if (event.result.metadata?.status === 'running') return undefined;
  const output = typeof result.output === 'string' ? result.output : '';
  return { sessionID: event.sessionID, command, output };
}

/**
 * Runs the Location's tool transforms again, so a tool added or left out by a setting follows a
 * change without a restart. `tool.reload` is the public API for it (`ToolDomain` in
 * @opencode/plugin/promise/tool); test/contract checks that a reload reruns a transform and that
 * the tool list follows.
 */
export function reloadTools(context: Pick<Plugin.Context, 'tool'>): Promise<void> {
  return context.tool.reload();
}

/** Narrows an unknown value to a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
