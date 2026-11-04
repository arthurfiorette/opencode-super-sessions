# OpenCode Super Sessions

Standalone OpenCode V2 plugin. User docs live in `README.md`; architecture and rationale in `docs/README.md`. The original plan is `/Users/hzk/.plannotator/plans/opencode-super-sessions-implem-2026-11-03-approved.md`, with follow-ups in `opencode-super-sessions-*.md` next to it. Where a plan and the code disagree, the code wins.

## Boundaries

- Do not modify OpenCode or import its private Core/Server modules. Use public V2 APIs only, and check the installed types before relying on one.
- Do not publish npm releases or change user configuration without explicit authorization.
- Never commit credentials or local OpenCode state.
- Keep all `@opencode/*` dependencies pinned to the same exact version.
- `./rpc` must stay importable by clients without loading OpenTUI.
- New host assumptions (command ids, priorities, event fields, payload shapes, API semantics, host file paths) go in `src/host/*` with a link to the host source line, and get a contract test in `test/contract` that reads the host through that accessor. See the Compatibility section of `docs/README.md`.

## Invariants

Changes must preserve these. `docs/README.md` explains the reasoning.

- Never write OpenCode's database, `cli.json` or the host's `session.json`. The plugin writes only its own key in session metadata (`super-sessions`), its plugin storage and its data directory.
- Every session metadata write goes through the write queue in `src/server/queue.ts`. `session.update({ metadata })` replaces the whole object, and other metadata keys must survive.
- State shared across Locations lives on `globalThis[Symbol.for('opencode-super-sessions')]`. Exactly one process-wide event subscriber runs.
- Only the server plugin runs `gh`, `glab` and `git`, through `src/process.ts`: no shell, the environment from `src/environment.ts`, a timeout, an output cap, and the home directory as working directory. The TUI only starts the OS URL opener in `src/browser.ts`, for http(s) URLs.
- Detection never tracks refs from assistant text; those are mentions only. A bare `#N` is accepted only from user prompts, against the session's repository, after the forge confirms it.
- A dismissed ref is never added back automatically. Only explicit `agent` and `manual` links lift a dismissal.
- Snapshot refreshes never write session metadata; only link changes do.
- A keymap `run` that may fall through stays synchronous and returns a literal `false`.
- Archiving happens only through the TUI's HTTP client (`setArchived`), on a user action, the user's title suffix, or auto-archive the user turned on. Auto-archive never takes pinned, running or waiting sessions, or sessions the user restored from it.
- Cleanup only removes worktrees `context.worktree.list` reports, never the main checkout, always with `force: false`, and never before the user confirmed once. Unknown facts keep a worktree, keep reasons beat every rule, and `git status` is read again right before each removal.
- On a host newer than `TESTED_UP_TO` by minor or major, the takeover and the peek keys stay off unless the user enables them. A browser crash falls back to the built-in list; a sidebar crash hides the section.
- The TUI degrades without the server plugin, `gh` or `glab`: titles and archiving still work.

## Verification

- Run `pnpm check` before committing.
- TUI changes need a native render test that mounts the page through OpenTUI under Bun, including cold lazy-loading. Never insert raw text nodes into box renderables.
- Package tests must exercise the packed build.
- Cleanup changes need a decision test for every rule and keep mode they touch; removal has no undo.
- No skipped placeholder tests or tests that duplicate implementation logic.

## Documentation

- English and concise. Keep the sponsor block and sentence-case headings. Do not invent badges, assets, or releases.
- The root README is user-facing only. Development and architecture belong in `docs/README.md`. Mark planned functionality as planned.
- Keep the README's keys, settings and options tables in step with `src/page/view.ts`, `src/settings/definitions.ts` and `src/config.ts`.
