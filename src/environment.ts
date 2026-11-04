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
  'GITHUB_ENTERPRISE_TOKEN',
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
      // `GLAB_*` carries glab's config directory, CA and client certificates, and proxy.
      return allowed.has(name) || name.startsWith('GH_') || name.startsWith('GLAB_');
    })
  );
}
