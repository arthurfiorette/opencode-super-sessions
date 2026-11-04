import { homedir } from 'node:os';

// Compared upper-cased because Windows environment names are case-insensitive (`Path`, `PATH`).
const allowed = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  // gh reads its config, state and token cache through the XDG directories.
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  // Linux keyrings (Secret Service) are reached over the session D-Bus; without these gh cannot
  // read a token stored by `gh auth login`.
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'GITHUB_TOKEN',
  // glab reads a token from these before its config and keyring. `OAUTH_TOKEN` is left out: the
  // name is too generic to be sure it belongs to GitLab.
  'GITLAB_TOKEN',
  'GITLAB_ACCESS_TOKEN',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SYSTEMROOT',
  'WINDIR',
  'PATHEXT'
]);

// gh sends these to any host other than github.com, so only {@link enterpriseTokens} passes them,
// and only for a call to such a host.
const ENTERPRISE_TOKENS = ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];

/**
 * Working directory for child processes. Windows resolves bare command names in the working
 * directory before PATH, so a child must never inherit a project directory the agent can write to.
 */
export function childDirectory(): string {
  return homedir();
}

/**
 * Environment for `gh`, `glab` and `git` children: only what they need to find their config, credentials
 * and network, so daemon secrets and `GIT_*` overrides from the host process never leak into them.
 */
export function childEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => {
      if (value === undefined) return false;
      const name = key.toUpperCase();
      if (ENTERPRISE_TOKENS.includes(name)) return false;
      // `GLAB_*` carries glab's config directory, CA and client certificates, and proxy.
      return allowed.has(name) || name.startsWith('GH_') || name.startsWith('GLAB_');
    })
  );
}

/**
 * The GitHub Enterprise tokens of the daemon's environment, for a gh call to `host`. Empty for
 * github.com, which never reads them. The server only calls hosts the user works with (see
 * `src/server/hosts.ts`), so a ref URL naming another host cannot receive them.
 */
export function enterpriseTokens(host: string): Record<string, string> {
  if (host.toLowerCase() === 'github.com') return {};
  const tokens: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && ENTERPRISE_TOKENS.includes(key.toUpperCase())) tokens[key] = value;
  }
  return tokens;
}
