import { readFileSync } from 'node:fs';

/**
 * Highest OpenCode release CI verified. CI runs every suite against the pinned `@opencode/*`
 * packages and the CLI of the same version (.github/workflows/ci.yml), so the pin is the tested
 * version by definition. Reading it from package.json, which every install ships, means a
 * Dependabot bump that passes CI raises this too, with no second number to forget.
 */
export const TESTED_UP_TO: string = pinnedVersion();

/**
 * Whether a host version is newer than {@link TESTED_UP_TO} by minor or major. Patch releases
 * count as tested. A version that is not `major.minor.patch` also counts as tested: builds from
 * source report `local` (packages/cli/src/version.ts:8 in the OpenCode repository), and the
 * people running them are developing against the host anyway.
 */
export function isUntested(version: string): boolean {
  const host = parse(version);
  const known = parse(TESTED_UP_TO);
  if (host === undefined || known === undefined) return false;
  if (host.major !== known.major) return host.major > known.major;
  return host.minor > known.minor;
}

/** Major and minor of a `major.minor.patch` version, with an optional `v` and prerelease. */
function parse(version: string): { major: number; minor: number } | undefined {
  const match = /^v?(\d+)\.(\d+)\.\d+(?:[-+].*)?$/.exec(version.trim());
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/** The exact `@opencode/plugin` version in this package's package.json. */
function pinnedVersion(): string {
  // dist/host/compat.js and src/host/compat.ts both sit two levels below the package root.
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  return manifest.dependencies['@opencode/plugin'];
}
