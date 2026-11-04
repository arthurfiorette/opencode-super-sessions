import type { Ref } from '../refs/ref.js';
import { github } from './github/definition.js';
import type { ForgeDefinition, RepoRef } from './provider.js';

/** Every supported forge, in the order they are tried. */
export const definitions: ForgeDefinition[] = [github];

/** Recognizes a git remote URL with the first forge that claims it. */
export function recognizeRemote(url: string): RepoRef | undefined {
  for (const definition of definitions) {
    const repo = definition.recognizeRemote(url);
    if (repo !== undefined) return repo;
  }
  return undefined;
}

/** Parses a pull request or issue web URL with the first forge that claims it. */
export function parseUrl(url: string): Ref | undefined {
  for (const definition of definitions) {
    const ref = definition.parseUrl(url);
    if (ref !== undefined) return ref;
  }
  return undefined;
}
