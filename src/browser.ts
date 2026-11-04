import { spawn } from 'node:child_process';
import type { Ref, RefState } from './refs/ref.js';

/**
 * Web page of a ref. The snapshot's URL wins; before the first snapshot arrives the URL is built
 * from the ref with GitHub's path layout.
 */
export function refUrl(ref: Ref, state: RefState | undefined): string {
  return (
    state?.url ??
    `https://${ref.host}/${ref.repo}/${ref.kind === 'pr' ? 'pull' : 'issues'}/${ref.number}`
  );
}

/**
 * Opens a web URL with the OS opener. No shell is involved, and only http(s) URLs are passed,
 * so a crafted ref URL cannot run a command.
 */
export function openUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  // `start` is a cmd.exe builtin and would need a shell; explorer.exe opens URLs directly.
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'explorer.exe'
        : 'xdg-open';
  try {
    const child = spawn(command, [parsed.href], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
