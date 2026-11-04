import { readFileSync } from 'node:fs';
import type { RunResult } from '../../src/process.js';

/** One `gh api --include` or `glab api --include` run, kept in parts so fixtures stay readable. */
export interface CapturedOutput {
  code: number;
  status?: string;
  headers?: Record<string, string>;
  /** JSON bodies are stored parsed; a string is printed as is. */
  body?: unknown;
  stdout?: string;
  stderr: string;
}

/** Loads a JSON fixture from `test/fixtures/<forge>/<name>`. */
export function fixture<T>(forge: string, name: string): T {
  return JSON.parse(readFileSync(new URL(`./${forge}/${name}`, import.meta.url), 'utf8'));
}

/**
 * Rebuilds what the CLI printed with `--include`: status line ending in LF, CRLF headers, a blank
 * CRLF line, then the body. Both gh and glab frame responses this way.
 */
export function asRun(output: CapturedOutput): RunResult {
  if (output.stdout !== undefined) {
    return { code: output.code, stdout: output.stdout, stderr: output.stderr };
  }
  const headers = Object.entries({
    'Content-Type': 'application/json; charset=utf-8',
    ...output.headers
  }).map(([name, value]) => `${name}: ${value}\r\n`);
  const body = typeof output.body === 'string' ? output.body : JSON.stringify(output.body);
  return {
    code: output.code,
    stdout: `${output.status}\n${headers.join('')}\r\n${body}`,
    stderr: output.stderr
  };
}
