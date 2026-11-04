import type { Options } from '../config.js';
import { definitions } from '../providers/registry.js';
import type { RepoRef } from '../providers/provider.js';
import type { ProviderId } from '../refs/ref.js';

/**
 * The hosts the server asks a forge about. A ref URL in a prompt, in assistant text or in a
 * command's output can name any host with a `github` or `gitlab` label, and the forge CLI would
 * send the user's login there. Only the forge's public host, the configured `gitlab.hosts` and the
 * hosts of git remotes in session directories are asked; refs on other hosts are stored unchecked.
 */
export interface ForgeHosts {
  allows(provider: ProviderId, host: string): boolean;
  /** Adds the host of a git remote a session's checkout uses. */
  learn(repo: RepoRef): void;
}

/** Creates the host list for `options`, starting with the public and configured hosts. */
export function createForgeHosts(options: Pick<Options, 'gitlab'>): ForgeHosts {
  const known = new Set([
    ...definitions.map((definition) => key(definition.id, definition.defaultHost)),
    ...options.gitlab.hosts.map((host) => key('gitlab', host))
  ]);
  return {
    allows: (provider, host) => known.has(key(provider, host)),
    learn: (repo) => {
      known.add(key(repo.provider, repo.host));
    }
  };
}

/** Hosts compare case-insensitively, per forge. */
function key(provider: ProviderId, host: string): string {
  return `${provider}:${host.toLowerCase()}`;
}
