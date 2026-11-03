# OpenCode Super Sessions

Standalone OpenCode V2 plugin. User docs live in `README.md`. The implementation plan is `/Users/hzk/.plannotator/plans/opencode-super-sessions-implem-2026-11-03-approved.md`; its invariants move here as the code lands.

## Boundaries

- Do not modify OpenCode or import its private Core/Server modules. Use public V2 APIs only, and check the installed types before relying on one.
- Do not publish npm releases or change user configuration without explicit authorization.
- Never commit credentials or local OpenCode state.
- Keep all `@opencode/*` dependencies pinned to the same exact version.
- `./rpc` must stay importable by clients without loading OpenTUI.

## Verification

- Run `pnpm check` before committing.
- TUI changes need a native render test that mounts the page through OpenTUI under Bun, including cold lazy-loading. Never insert raw text nodes into box renderables.
- Package tests must exercise the packed build.
- No skipped placeholder tests or tests that duplicate implementation logic.

## Documentation

- English and concise. Keep the sponsor block and sentence-case headings. Do not invent badges, assets, or releases.
- The root README is user-facing only. Development and architecture belong in `docs/README.md`. Mark planned functionality as planned.
