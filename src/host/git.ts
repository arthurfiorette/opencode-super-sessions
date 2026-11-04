import type { Runner, RunResult } from '../process.js';

// git is not OpenCode, but the plugin runs it inside the daemon next to the agent's own git
// commands, and its exit codes and porcelain formats are what branch lookup and cleanup decide on.

// No credential prompts, and no index refresh that could fight the agent's own git commands for
// `index.lock`.
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };

/** Runs git against one directory with the plugin's environment and a timeout. */
export function gitIn(
  runner: Runner,
  directory: string,
  timeoutMs: number
): (...args: string[]) => Promise<RunResult> {
  return (...args) => runner('git', ['-C', directory, ...args], { timeoutMs, env: GIT_ENV });
}
