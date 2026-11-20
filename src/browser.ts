import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

export { refUrl } from './refs/look.js';

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
  try {
    // The home directory, never the TUI's project directory: Windows looks a command up in the
    // working directory first, where the agent can write.
    const child = spawn(opener(), [parsed.href], {
      cwd: homedir(),
      detached: true,
      stdio: 'ignore'
    });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * The OS URL opener. On Windows, `start` is a cmd.exe builtin and would need a shell, so
 * explorer.exe opens the URL, by absolute path so no other `explorer.exe` on PATH can stand in.
 */
function opener(): string {
  if (process.platform === 'darwin') return 'open';
  if (process.platform !== 'win32') return 'xdg-open';
  return path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe');
}
