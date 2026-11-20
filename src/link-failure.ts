import { rpcError, serverPluginMissing } from './host/rpc.js';
import type { ProviderId } from './refs/ref.js';

// Why a `link` RPC failed, read once for the TUI browser (`src/page/view.ts`) and the Desktop Work
// list (`src/gui/status/actions.ts`), which word it in their own copy. No UI or Node.js import, so
// the GUI bundle can load it.

/** A forge's name in messages. */
export const FORGE_NAMES: Record<ProviderId, string> = { github: 'GitHub', gitlab: 'GitLab' };

/**
 * Why a link failed:
 * - `invalid`: not a URL or a pull request or issue reference.
 * - `not-found`: the forge has no such pull request or issue.
 * - `disabled`: the ref's forge is turned off; `forge` names it when the server said which.
 * - `unavailable`: the forge's CLI cannot answer, such as when it is not signed in.
 * - `missing`: the server runs no server half of this plugin.
 * - `failed`: anything else, such as a network error.
 */
export type LinkFailure =
  | { readonly reason: 'invalid' | 'not-found' | 'missing' | 'failed' }
  | { readonly reason: 'disabled' | 'unavailable'; readonly forge: string | undefined };

/** Reads a `link` rejection. */
export function linkFailure(error: unknown): LinkFailure {
  if (serverPluginMissing(error)) return { reason: 'missing' };
  const { type, data } = rpcError(error);
  if (type === 'invalid_reference') return { reason: 'invalid' };
  if (type === 'not_found') return { reason: 'not-found' };
  if (type !== 'unavailable') return { reason: 'failed' };
  const record = typeof data === 'object' && data !== null ? data : {};
  const provider = 'provider' in record ? record.provider : undefined;
  const forge = provider === 'github' || provider === 'gitlab' ? FORGE_NAMES[provider] : undefined;
  const disabled = 'reason' in record && record.reason === 'disabled';
  return { reason: disabled ? 'disabled' : 'unavailable', forge };
}
