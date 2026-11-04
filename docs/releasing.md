# Publish a release

This guide covers stable releases through GitHub Actions and npm trusted publishing. Run the complete platform matrix before publishing.

## Configure trusted publishing

1. Enable GitHub Actions for this repository and create the `NPM Registry` environment. Add required reviewers if releases need manual approval.
2. On npm, configure a GitHub Actions trusted publisher for the package: owner `arthurfiorette`, repository `opencode-super-sessions`, workflow `publish.yml`, environment `NPM Registry`. Enable direct `npm publish` for this publisher; stage-only permission does not authorize the current workflow.
3. A new package may need a manual first publish before its trusted publisher can be configured. Complete that bootstrap using your npm account and required authentication, then use the workflow for subsequent releases. Do not store a long-lived npm token in the repository.

### Manual first publish

From a clean checkout of the commit CI passed on:

```sh
git status --short             # must print nothing
pnpm install --frozen-lockfile
OPENCODE_BIN=$(which opencode) pnpm check
npm pack --dry-run             # dist/*.js, *.js.map, *.d.ts, the three entry files, README, LICENSE
npm login
npm publish --access public    # runs prepack, which rebuilds dist
git tag v0.1.0 && git push origin v0.1.0
```

Then add the trusted publisher (step 2 above), and from then on publish only through GitHub releases. A manual publish carries no provenance; releases from `publish.yml` do.

The same setup from the command line. `npm trust` needs npm 11.15 or newer, two-factor authentication on the account and an interactive login (not a token), and the package must already exist on the registry:

```sh
gh api -X PUT 'repos/arthurfiorette/opencode-super-sessions/environments/NPM%20Registry'
npm trust github opencode-super-sessions --repo arthurfiorette/opencode-super-sessions \
  --file publish.yml --env 'NPM Registry' --allow-publish --dry-run
npm trust github opencode-super-sessions --repo arthurfiorette/opencode-super-sessions \
  --file publish.yml --env 'NPM Registry' --allow-publish
npm trust list opencode-super-sessions
```

Complete a successful publish within two days of creating the trusted publisher, or npm expires the unvalidated configuration. Create it when the release is ready. See [npm's trusted publishing guide](https://docs.npmjs.com/trusted-publishers/).

## Prepare and publish

1. Open the session browser in a real OpenCode TUI and check archiving and pull request tracking with `gh` logged in to GitHub, and with `glab` logged in to GitLab when GitLab code changed. Record this separately from the stubbed `gh` and `glab` tests.
2. Update the package version and lockfile. Document the release's behavior and any migration requirements. Bumping the `@opencode/*` pins also raises `TESTED_UP_TO`, the newest OpenCode version the browser takes over by default; close any open "Compatibility with OpenCode <version>" issue the bump resolves. Dependabot leaves `@opentui/*` alone: set `@opentui/core` and `@opentui/solid` to the exact version the new `@opencode/theme` depends on (`npm view @opencode/theme@<version> dependencies`) in the same change.
3. Run `pnpm install --frozen-lockfile` and `pnpm check` with the declared Node and pnpm versions, with the `opencode` binary of the pinned `@opencode/sdk` version on `PATH` or in `OPENCODE_BIN`.
4. Commit and push. Wait for all CI jobs to pass.
5. Create a GitHub release with tag `v<package.json version>`. The publishing workflow ignores prereleases and rejects a tag that does not match the package version.
6. Approve the environment deployment if required. Inspect the publish run and verify the published version on npm.

To rerun a failed publish, dispatch `publish.yml` with the existing stable release tag. npm versions are immutable; use a new version for changed package contents.
