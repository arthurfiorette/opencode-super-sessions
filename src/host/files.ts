import os from 'node:os';
import path from 'node:path';

// Paths of files OpenCode owns or would own. The plugin reads the host's files and never writes
// them; a host that moves one leaves the plugin on its defaults instead of failing. Line numbers
// refer to the OpenCode repository at v2.2.7.

/**
 * `cli.json` in the host's config directory: `OPENCODE_CONFIG_DIR`, else
 * `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode` (packages/util/src/global-roots.ts and
 * the `Global.layerWith` override in packages/cli/src/index.ts). The host reads no `cli.jsonc`.
 */
export function cliConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const directory =
    env.OPENCODE_CONFIG_DIR ||
    path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
  return path.join(directory, 'cli.json');
}

/**
 * The host TUI's `session.json`, which holds its pins, under the XDG state home
 * (packages/tui/src/context/local.tsx:517).
 */
export function hostSessionStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const state = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(state, 'opencode', 'session.json');
}

/**
 * The plugin's own data directory, next to OpenCode's data under the XDG data home but never
 * inside its database. OpenCode gives server plugins no data directory of their own, so this
 * follows the host's `opencode` data root (packages/util/src/global-roots.ts).
 */
export function pluginDataPath(env: NodeJS.ProcessEnv = process.env): string {
  const data = env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(data, 'opencode', 'plugins', 'opencode-super-sessions');
}
