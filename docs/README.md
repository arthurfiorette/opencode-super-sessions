# Development

User documentation is in the [root README](../README.md). Releases are described in [releasing.md](releasing.md).

## Checks

`pnpm check` runs lint, build, typecheck, unit, integration, contract, native TUI and package tests. The contract tests start the real `opencode` binary, so it must be on `PATH` or named by `OPENCODE_BIN`; CI installs `@opencode/cli` at the version of the pinned `@opencode/sdk`.

## Compatibility

The `@opencode/*` pins only fix the types and the tests. At runtime the plugin runs inside whatever `opencode` the user installed, so everything it assumes about the host lives in `src/host/*`, one file per area, each linking the host source it mirrors:

- `keymap.ts`: command ids the takeover reuses, layer priorities, keymap modes.
- `events.ts`: where prompt text, assistant text and `!` commands sit in events, and the index keys shared with the backfill.
- `tool-hook.ts`: the shell tool's name and its `execute.after` payload.
- `session-api.ts`: archiving and title regeneration over HTTP, the project scope of the list, the running test.
- `worktree.ts`: worktree listing and removal without force.
- `files.ts`: paths of `cli.json`, the host's `session.json` and the plugin's data directory.
- `theme.ts`: the dialog surface, the session view background and the markdown styles.
- `git.ts`: how the plugin runs git next to the agent.
- `compat.ts`: `TESTED_UP_TO` and the untested-version check.

Each assumption and what checks it:

- The `session.list` takeover through a priority-1 layer, with `false` falling through to the built-in list: the smoke test (`<leader>l` opens the browser) and a unit test (`false` for `classic`).
- The peek keys at priority 2 beat the prompt history layers: the smoke test (the arrows move the peek with an empty prompt).
- The `app` slot overlay sits under host dialogs, which take the keys: the smoke test (ctrl+r renames from inside the browser).
- The `session.composer.top` slot input `{ sessionID }`: the smoke test (the peek banner shows for the peeked session).
- Event payloads, and the keys live indexing shares with the backfill: contract tests.
- The shell tool name and the `execute.after` payload: a contract test with a real agent shell call.
- `session.update({ metadata })` replaces the object, and `session.get` returns metadata and location: a contract test.
- Archive and restore over HTTP, and an empty title regenerating it: contract tests.
- `message.list` shapes, paging and the `type` filter: a contract test.
- `session.list` filters and cursors: a contract test.
- The worktree list marks the main checkout, and removal without force refuses local files: a contract test.
- Every agent request carries the plugin's tracking instruction once: a contract test.
- The `cli.json` and `session.json` locations: not checked against a host. They are host files the plugin only reads, with defaults when missing.
- Markdown styles and theme surfaces: the typecheck and the native TUI tests on the latest packages in `compat.yml`.
- `gh` and `glab` output: fixture unit tests. A real check needs credentials.

The contract tests (`test/contract`) run against an in-process host from `@opencode/sdk` with a scripted OpenAI-compatible model on loopback, so the real agent loop, tool registry and title agent run without a model or network. The smoke test drives the real TUI headless through OpenCode's Drive harness (`OPENCODE_DRIVE` with `OPENCODE_DRIVE_RENDERER=headless`). Drive is the host's own test harness, not a plugin API; when only the smoke test fails on a new release, check whether Drive changed first.

`.github/workflows/compat.yml` runs weekly and on demand against the latest `@opencode/*` release and the OpenTUI version it ships with. A failure opens or updates the issue "Compatibility with OpenCode <version>"; a pass writes the tested versions to the job summary.

At runtime, `TESTED_UP_TO` is the pinned `@opencode/plugin` version, read from package.json. On a host newer by minor or major, the TUI keeps the built-in `/sessions`, `<leader>l` and quick switch keys, turns the peek keys off, and says once per version that the browser opens with `/super-sessions`. The "Use on untested OpenCode versions" setting turns the takeover back on. A crash in the browser closes it and opens the built-in list; a crash in the Work section hides the section.
