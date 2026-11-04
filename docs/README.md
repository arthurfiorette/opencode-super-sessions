# Developer guide

User documentation is in the [root README](../README.md). Releases are described in [releasing.md](releasing.md), and contribution rules in [AGENTS.md](../AGENTS.md).

## Development

Use Node.js 24.16+, pnpm 12 and Bun 1.3.14 for the native TUI tests. The contract tests start the real `opencode` binary, so it must be on `PATH` or named by `OPENCODE_BIN`, at the version of the pinned `@opencode/sdk`. To try a local build, run `pnpm build` and set the plugin entry's `package` to the absolute path of the repository.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
```

| Command                 | Purpose                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `pnpm build`            | Compile ESM and TypeScript declarations into `dist/`                                       |
| `pnpm format`           | Apply the shared Biome configuration                                                       |
| `pnpm lint`             | Check formatting and lint rules                                                            |
| `pnpm lint-fix`         | Apply Biome's fixes, unsafe ones included                                                  |
| `pnpm lint-ci`          | Check formatting and lint rules without writing files                                      |
| `pnpm test-types`       | Typecheck source and tests                                                                 |
| `pnpm test`             | Build, then run the unit tests                                                             |
| `pnpm test:integration` | Build, then load the plugin in an isolated `@opencode/sdk` host                            |
| `pnpm test:contract`    | Build, then check host assumptions against a real host and the real TUI                    |
| `pnpm test:tui`         | Build, then mount the compiled views through OpenTUI under Bun                             |
| `pnpm test:package`     | Pack, install and import the packed build                                                  |
| `pnpm check`            | Lint, build, typecheck, then the unit, integration, contract, native TUI and package tests |

SDK native parser addons may require Python and a C/C++ build toolchain. Their build scripts are approved in `pnpm-workspace.yaml`.

## Tests

| Layer       | Files                       | Runner       | Covers                                                                                                                                                                                                                                           |
| ----------- | --------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit        | `test/unit`                 | `tsx --test` | Detection, ref parsing, Done, caches, `gh` and `glab` output from captured fixtures (`test/fixtures/github`, `test/fixtures/gitlab`), the forge host list, the write queue, cleanup decisions, the URL opener's scheme filter, the version guard |
| Integration | `test/integration`          | `tsx --test` | The built plugin in an `@opencode/sdk` host run from `test/fixtures` in a child process with a throwaway home: RPC per Location, links, detection against `test/fixtures/fake-gh.mjs`, and cleanup on a real temporary git repository            |
| Contract    | `test/contract`             | `tsx --test` | The host assumptions listed under [Compatibility](#compatibility), against a real host and, in `tui.test.ts`, the real TUI                                                                                                                       |
| Native TUI  | `test/tui`                  | `bun test`   | The compiled browser, settings dialog and sidebar mounted with OpenTUI's `testRender`, including the cold lazy load                                                                                                                              |
| Package     | `scripts/check-package.mjs` | Node         | `npm pack`, an install into a temporary directory, the `.`, `./tui` and `./rpc` exports, and `Host.resolve` finding all three                                                                                                                    |

The contract tests in `test/contract/server.test.ts` run against an in-process host from `@opencode/sdk` with a scripted OpenAI-compatible model on loopback (`test/contract/harness.ts`), so the real agent loop, tool registry and title agent run without a model provider or network. The harness replaces the environment before the SDK loads, so nothing touches the developer's OpenCode config, credentials or sessions.

`test/contract/tui.test.ts` is the smoke test. It starts `opencode --standalone` (`OPENCODE_BIN`, else the `opencode` on `PATH`) headless through OpenCode's Drive harness (`OPENCODE_DRIVE` with `OPENCODE_DRIVE_RENDERER=headless`) and drives one launch through `<leader>l`, a peek with `space`, `down`, `up` and `esc`, a rename with `ctrl+r` and the palette with `ctrl+p`. Drive is the host's own test harness, not a plugin API; when only the smoke test fails on a new release, check whether Drive changed first.

CI (`.github/workflows/ci.yml`) runs `pnpm check` on Linux, Windows and macOS. It installs `@opencode/cli` at the version of the pinned `@opencode/sdk` under the runner's temp directory and exports `OPENCODE_BIN`. The publish workflow (`.github/workflows/publish.yml`) installs it the same way before its own `pnpm check`.

## Architecture

### Server runtime

`src/index.ts` is the server plugin. The daemon calls its `setup` once per Location (project directory), and module state is not shared between Locations, so everything shared hangs off `globalThis[Symbol.for('opencode-super-sessions')]` (`getRuntime` in `src/server/runtime.ts`). The runtime holds the forge providers, the snapshot and branch caches, the repository resolver, the write queue, the event hub, the message index, the backfill job and the settings store. The first Location's options win; a Location with different options logs a warning once, and the change applies after a daemon restart.

Each Location registers its own tools, shell hook, `context` hook for the agent instruction and RPC handlers, all backed by the runtime. Invalid options register inert handlers instead, so the TUI degrades to titles only.

### Metadata and the write queue

Links live in session metadata under `super-sessions` (`src/refs/ref.ts`), as `{ v: 1, links, dismissed, done?, doneAt? }`. `done` is the user's Done mark from `done.set`, and `doneAt` is when it was set to `true`, which auto-archive counts days from. The server plugin's `session.update({ metadata })` replaces the whole object, so every write goes through `src/server/queue.ts`: a per-session promise chain that reads the session, applies a pure mutation from `src/refs/store.ts` and writes only when it changed. Tools, the shell hook, events and RPC all share it, across Locations. A stored value that does not parse, such as one a newer plugin version wrote, is never replaced: the write rejects and the daemon log names the session.

`mergeLinks` dedupes by `refKey`, keeps the earliest `linkedAt`, and only moves a link up the source ladder (`agent`, `created` and `manual` above `prompt`, above `closes`, above `mention`). Only `agent` and `manual` links lift a dismissal. `dismissLink` also drops the `closes` links derived from a dismissed pull request.

### Events and detection

`event.subscribe` is not Location-scoped, and every Location gets a copy of every event. `src/server/events.ts` keeps one process-wide subscription on the oldest live Location, dedupes by event id (the last 1024), hands the subscription to the next Location when its owner detaches, and resubscribes after 1 second when a stream ends on its own.

`src/server/detection.ts` reads:

- `session.inbox.enqueued` user items: refs in prompts, bare numbers resolved against the session's repository;
- `session.text.ended`: mentions in assistant text;
- `session.shell.ended`: `!` commands, which never reach the tool hook;
- `execute.after` of the `shell` tool, registered per Location: commands the agent ran.

Create detection (`src/refs/detect.ts`) is ported from t3code's `PullRequestSyncReactor`. It unwraps `sh -c` scripts, ignores heredoc bodies, quoted strings and comments, counts only create commands at a command start, skips scripts that also list refs, skips URLs whose number the rest of the script names, takes only URLs alone on an output line, and takes none when there are more URLs than create commands. Every candidate goes through the forge before it is linked. A bare number from a prompt is linked only when the forge found it; a URL or typed reference of known kind is also linked while the forge cannot answer. A merge or close command forces a refresh of the session's refs.

A URL in a prompt, a reply or command output can name any host with a `github` or `gitlab` label, and the forge CLI would send the user's login there. So forges are asked only about the hosts in `runtime.hosts` (`src/server/hosts.ts`): each forge's `defaultHost`, the `gitlab.hosts` option, and the host of every remote the repository resolver recognized in a session's directory. A candidate on another host resolves without a call as unverified, with the reason `unknown-host`; its link is kept, and its state stays unknown.

`session.deleted` and `session.execution.succeeded`, `failed` and `interrupted` also go to the sweeper (see [Auto-archive and cleanup](#auto-archive-and-cleanup)).

### Caches

| Cache                      | File                          | Lifetime                                                                                    |
| -------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| Ref snapshots              | `src/cache.ts`                | Open and draft 2 min, closed 15 min, merged, completed and not planned forever, errors 30 s |
| Branch pull requests       | `src/server/branches.ts`      | 1 min while a found PR is open, 5 min otherwise, errors 30 s                                |
| Remotes and default branch | `src/repo.ts`                 | 15 min per directory                                                                        |
| Current branch             | `src/repo.ts`                 | 10 s per directory                                                                          |
| Forge availability         | `src/providers/*/provider.ts` | 5 min, 10 s while the CLI is missing                                                        |

Concurrent requests for one key share a fetch. A rate limit sets `retryAt`, which holds even for forced refreshes, and a transient error keeps the last known state; only `not-found` replaces it. Snapshot refreshes never write metadata. The `refs` RPC returns cached data at once and refreshes stale sessions in the background (`runtime.refreshing` keeps those from stacking); `refresh` waits for the forge.

### Child processes

`src/process.ts` runs every child without a shell, from the home directory (Windows resolves bare names in the working directory first), with the environment `src/environment.ts` allows (`GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` only for a `gh` call to a host other than github.com), a timeout, an 8 MiB cap per stream, and SIGKILL 2 seconds after SIGTERM. It always resolves, so callers classify results instead of catching.

| Runner | Timeout                                | Concurrency            | Notes                                                                                                                                   |
| ------ | -------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `gh`   | 20 s                                   | 4 per daemon           | `gh api graphql --include --input -`, the body as JSON on stdin; `GH_PROMPT_DISABLED=1`; at most 25 refs per document                   |
| `glab` | 20 s                                   | 4 per daemon           | `glab api graphql` the same way; `GLAB_NO_PROMPT`, no update check, no telemetry; batches sized by a complexity budget of 180 points    |
| `git`  | 5 s (repository reads), 10 s (cleanup) | 8 for repository reads | `src/host/git.ts`: `GIT_TERMINAL_PROMPT=0` and `GIT_OPTIONAL_LOCKS=0`, so the plugin never prompts or fights the agent for `index.lock` |

A missing alias fails only its own entry. The GraphQL documents ask for `rateLimit` so the provider sees an exhausted quota before a request fails.

### Branch pull requests

`src/repo.ts` reads `git remote -v` and picks `upstream`, then `origin`, then the first remote alphabetically, ignoring local paths and file URLs. The default branch comes from `refs/remotes/<remote>/HEAD`. The current branch's upstream (`@{u}`) maps to the remote with the longest matching name, which gives the fork a branch was pushed to.

`branchTarget` in `src/server/views.ts` skips the default branch, a detached HEAD and a branch without an upstream. GitHub asks `pullRequests(headRefName:, first: 20)` and keeps nodes whose `headRepository.nameWithOwner` is the head repository; GitLab asks `mergeRequests(sourceBranches:, first: 20)` and checks `sourceProject.fullPath`. A head repository on another host gives none. The newest open match wins, else the newest of any state. Branch refs are never stored, and a dismissed key is filtered out.

### Message index

`src/server/body-index.ts` opens `search.db` in the plugin data directory (`pluginDataPath` in `src/host/files.ts`) with `node:sqlite`, in WAL mode with a 2 second busy timeout. It never throws: without SQLite, FTS5 trigram support or a writable file it returns a disabled index and logs once.

Schema version 1 (`PRAGMA user_version`):

- `entry (id, session_id, entry_key, created)`, unique on `(session_id, entry_key)`. Ids are `created * 1000 + n`, so rowid order is creation order.
- `entry_text`, an FTS5 table with the `trigram` tokenizer, `remove_diacritics 1` where SQLite 3.45+ allows it. Text is cut at 32 KiB per entry.
- `backfill (session_id, cursor, done)`.

User prompts are keyed by the inbox id, which becomes the stored user message id, and assistant text by `<messageID>:<ordinal>`, counting text parts only (`src/host/events.ts`). Live indexing and the backfill derive the same keys, so an entry is never stored twice. Search quotes every token of three or more characters as an FTS5 phrase, checks shorter tokens with `instr`, and reads only the newest 5000 hits.

The backfill (`src/server/backfill.ts`) walks every session through `session.list` pages of 50, children and archived ones included, newest first. It reads each with `session.context`, the only message read a server plugin has, and records the session's `time.updated` as its cursor, so a restart skips unchanged sessions. It pauses 200 ms between sessions and 10 ms every 25 entries, and stops when the last Location detaches.

`searchSessions` in `src/server/views.ts` combines the host's title search (50 results), the 200 most recently updated sessions for ref matches, and up to 200 index hits, mapping subagent hits to their root with at most 50 extra `session.get` calls.

### TUI overlay and keymap mode

`src/tui.ts` is the TUI plugin. It creates the pins, the settings and maintenance, the browser and the sidebar. TUI view modules load lazily, so importing `./tui` or `./rpc` from Node never loads OpenTUI; `lazyNode` hides Solid's empty-string placeholder, since OpenTUI boxes cannot hold text nodes.

The browser (`src/page/page.ts`) claims the host's `app` slot, which renders after the route inside the main column, and draws an absolutely positioned overlay only while open, so the route underneath stays mounted. While open it pushes the `super-sessions` keymap mode, which turns off the prompt and every other `base` layer, and its layer sits in that mode at priority 1. Host dialogs push `modal` above it, take the keys and draw above the overlay. The model (`src/page/model.ts`) outlives the overlay: it caches both lists for 30 seconds, reloads 500 ms after session events while open, and keeps query, view, selection and scroll in `storage.memory`.

### Takeover and classic fallthrough

A global layer at priority 1 (`OVER_HOST`) registers commands with the host's own ids: `session.list` (slash `sessions`, aliases `resume` and `continue`) and `session.quick_switch.1` to `9`. Reusing the ids makes the user's keybinds, the slash names and the palette entries reach the plugin first. A keymap `run` falls through to the next layer only when it returns a literal `false`, and a returned Promise counts as handled, so these runs stay synchronous. `/sessions-classic` dispatches `session.list` with the argument `classic`, for which the takeover returns `false` and the built-in list opens.

The layer factory is reactive: on an untested host (see [Compatibility](#compatibility)) the takeover commands are left out unless the setting allows them.

### Peek

The peek keys live in a separate global layer at priority 2 (`OVER_PROMPT`). The prompt's history layer registers at priority 1 on every cursor move, so a priority 1 layer lost `up` to it. `esc` is enabled while the peeked session is on screen and no host dialog is open; `up` and `down` only in the `base` mode, and they return `false` while the focused prompt holds text. The route follows the peek cursor after 150 ms. The banner renders in the `session.composer.top` slot for the peeked session only. A user item in `session.inbox.enqueued` or any route change ends the peek.

A crash in the browser's render or key actions closes it and opens the built-in list (`fail` in `page.ts`). A crash in the sidebar's Work rows hides those rows through their own error boundary (`installSidebar` in `src/sidebar.ts`), so it never reaches the host's slot boundary, which would toast it in the middle of the session.

### Settings stores and RPC

The dialog rows are in `src/settings/definitions.ts`. TUI settings live in `context.storage.store('settings')` (`src/settings/store.ts`), read reactively, so a change applies at once in every TUI. Server settings go over the `settings.get` and `settings.set` RPC methods to `src/server/settings.ts`, which persists them under the `settings` key of the server plugin's storage and notifies the runtime; `runtime.options` applies them, and a provider change rebuilds the forges. In both stores the plugin options are the defaults, overrides equal to a default are dropped, and each stored key is parsed on its own, so a schema change loses only that key.

| RPC method                                           | Purpose                                                   |
| ---------------------------------------------------- | --------------------------------------------------------- |
| `status`                                             | CLI availability of each enabled forge on its public host |
| `refs`, `refresh`                                    | Links, branch refs and states per session                 |
| `search`                                             | Ranked hits for a query, scope and archived flag          |
| `link`, `unlink`                                     | Manual link and dismissal                                 |
| `done.set`                                           | The user's Done mark, or `null` to follow the refs again  |
| `settings.get`, `settings.set`                       | Server settings                                           |
| `presence`                                           | A TUI's pins and open sessions                            |
| `archive.claim`, `archive.report`, `archive.exclude` | Auto-archive hand-off, and sessions the user restored     |
| `cleanup.plan`, `cleanup.run`                        | Dry run and confirmed removal                             |

Events: `archive.due`, `cleanup.confirm` and `cleanup.removed`.

### Auto-archive and cleanup

`src/server/sweep.ts` keeps one sweeper per daemon on the runtime, not in module state: a plugin loaded from a local path is one module per Location, and a sweeper per module would sweep and remove in parallel. It runs one sweep at a time on the first live Location: 5 seconds after start, every 10 minutes, and 5 seconds after `session.deleted`, `session.execution.succeeded`, `failed` or `interrupted`, or a cached ref turning merged. The dry run and "Run cleanup now" queue behind it, so two removals never race.

A sweep lists every session, works out roots and running families, lists each project's worktrees through `context.worktree.list` (projects from sessions, live Locations and the last sweep), and assigns each top-level session to the deepest worktree containing its resolved directory. Sessions a decision needs get a waited ref refresh in batches of 50, and Done candidates a check for a waiting permission or question and, without a Done mark, their last user message from `session.context`; a context that starts at a compaction without a user message after it counts as unknown and keeps the session out of Done.

Auto-archive (`src/server/auto-archive.ts`) decides on the server, where ref states live, but archives in a TUI: the server plugin's `session.update` ignores `archived`, and plugins get no HTTP credentials. TUIs report pins and open sessions through `presence` every 5 minutes and on change, and the server forgets a TUI after 15 minutes. A sweep queues due sessions and emits `archive.due`; a TUI claims up to 50 under a 2 minute lease, checks pins, running state, permissions and questions again, archives over HTTP and reports back (`src/settings/maintenance.ts`). Every restore (undo, `ctrl+s` in the Archived view, `/unarchive`) calls `archive.exclude` through `excludeFromAutoArchive`, which adds the sessions to the `archive-excluded` list (at most 5000) so the next sweep does not archive them again.

Cleanup (`src/server/cleanup.ts`) gathers facts per worktree and calls `decideWorktree`, a pure function. Keep reasons come first: the main checkout, a running, waiting, open or pinned session, unreadable `git status`, any modified, staged or untracked file (`has local changes`; `git worktree remove` without force refuses these anyway, and keeping them stops every sweep from retrying), then commits only the worktree reaches. OpenCode creates worktrees on a detached HEAD, so a commit the agent made without a branch is lost with the worktree: when HEAD has commits beyond the default branch, is not in it and is not at or behind a merged pull request's head, `for-each-ref --contains HEAD` over `refs/heads`, `refs/remotes` and `refs/tags` must find a ref, or the worktree is kept with `has commits no branch or tag contains` (`could not tell whether a branch holds its commits` when git cannot answer). Then the rules, in order: deleted, merged, Done, inactive, unchanged. The deleted rule needs no session left, the Done, inactive and unchanged rules at least one, and the merged, Done and unchanged rules every session archived or Done. Unknown facts always keep. The merged rule needs the tracked pull requests merged and HEAD contained in the default branch, or, for squash and rebase merges, HEAD at or behind a merged head commit (`headSha` from the forge) that exists locally. Until the user confirms once, a sweep emits `cleanup.confirm` and removes nothing; the TUI asks when no dialog or the browser holds the screen. The `cleanup` storage key keeps the confirmation, the worktree each session was last seen in (so a deletion maps to its worktree) and the projects with linked worktrees. Right before each removal `freshFacts` reads the worktree again: `session.list({ directory })` for sessions started there since the sweep, `session.get`, pending permissions and questions and fresh presence for each, and git status, commits and refs. `decideWorktree` runs again on those facts, a session the sweep did not see counts as not Done, and a failed read keeps the worktree. Removal goes through `context.worktree.remove` with `force: false`. The "Run cleanup now" dialog says, while cleanup is unconfirmed, that confirming also turns on automatic removal.

## Providers

`src/providers/provider.ts` defines a forge as a static half and a runtime half:

- `ForgeDefinition`: static and side-effect free, shared by the server, the TUI and tests. It recognizes remotes, parses URLs and typed references, scans text for refs and bare numbers, and holds the create, close and list command patterns.
- `ForgeProvider`: the server-only runtime half, which spawns the CLI. `available(host)`, `branchPullRequests(repo, branch, headRepo?)`, and `snapshot(candidates)`, which resolves kinds and returns states in input order, with `not-found` for one missing number and `retryAt` on rate limits.

A pull request's snapshot carries `updatedAt` and, while it is open or a draft, `review`: the verdict, resolvable threads, the head commit's CI result and `checksPassed`/`checksTotal`. GitHub's counts come from `statusCheckRollup.contexts(first: 0)`, whose `checkRunCountsByState` and `statusContextCountsByState` cost no node. Passed means SUCCESS, NEUTRAL and SKIPPED check runs plus SUCCESS statuses, which matched github.com's `N/M checks passing` on 2026-11-04 except for superseded re-runs: github.com drops a run another run of the same check replaced, and the counts cannot. GitLab counts the head pipeline's jobs with two `jobs(retried: false, statuses:)` connections: SUCCESS and SKIPPED over every status but MANUAL. They raise a merge request's complexity from 34 to 43 points.

GitHub numbers pull requests and issues together, so a bare `#N` has no kind until the forge answers. GitLab numbers merge requests (`!N`) and issues (`#N`) separately, so `refKey` includes the kind.

To add a forge:

1. Add its id to `providerIdSchema` in `src/refs/ref.ts`.
2. Write `src/providers/<id>/definition.ts` and add it to `definitions` in `src/providers/registry.ts`. The order there decides which forge claims an ambiguous `owner/repo#N`.
3. Write the client on `run` and `createLimiter` from `src/process.ts`, and the provider. Keep the concurrency cap in the client and one provider per daemon.
4. Add a factory to `providerFactories` in `src/server/runtime.ts`, an executable option in `src/config.ts` (in the field and in the outer default), and the CLI's environment variables to `src/environment.ts`.
5. Extend the provider choice: `providerChoiceSchema` in `src/rpc.ts`, `providerChoice` and `providerList` in `src/server/settings.ts`, and the Providers row in `src/settings/definitions.ts`. These only know GitHub, GitLab and both today.
6. Check the forge-specific display code: `refNumber` in `src/refs/ref.ts`, `refKind` in `src/page/view.ts`, the URL fallback in `src/browser.ts`, and the status texts in `src/tui.ts`.
7. Capture real CLI output into `test/fixtures/<id>` and add unit tests like `test/unit/github.test.ts` and `test/unit/github-definition.test.ts`.

## Compatibility

The `@opencode/*` pins only fix the types and the tests. At runtime the plugin runs inside whatever `opencode` the user installed, so everything it assumes about the host lives in `src/host/*`, one file per area, each linking the host source it mirrors:

- `keymap.ts`: command ids the takeover reuses, the `dialog.select.*` ids the settings dialog registers, layer priorities, keymap modes.
- `events.ts`: where prompt text, assistant text and `!` commands sit in events, the index keys shared with the backfill, and the last user message in a `session.context` that starts at the latest compaction.
- `tool-hook.ts`: the shell tool's name and its `execute.after` payload.
- `session-api.ts`: archiving and title regeneration over HTTP, the project scope of the list, the running test, the unread rule.
- `worktree.ts`: worktree listing and removal without force.
- `files.ts`: paths of `cli.json`, the host's `session.json` and the plugin's data directory.
- `theme.ts`: the dialog surface and backdrop, the session view background and the markdown styles.
- `tui.ts`: the slot names (`app`, `session.composer.top`, `sidebar.content`) and the focused editor's text on the renderer.
- `rpc.ts`: the `type` and `data` of an RPC error a handler returned.
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
- The RPC error shape: the configured-host integration fixture reads real `link` errors through `rpcError`.
- The `sidebar.content` slot, the `dialog.select.*` ids, the dialog backdrop, the unread rule and the compaction rule: not checked against a host. A unit test covers the compaction rule on hand-written messages.
- The `cli.json` and `session.json` locations: not checked against a host. They are host files the plugin only reads, with defaults when missing.
- Markdown styles and theme surfaces: the typecheck and the native TUI tests on the latest packages in `compat.yml`.
- `gh` and `glab` output: fixture unit tests. A real check needs credentials.

`.github/workflows/compat.yml` runs weekly and on demand against the latest `@opencode/*` release and the OpenTUI version its `@opencode/theme` pins. It installs those versions and the matching `@opencode/cli` in the runner without committing, runs the typecheck, unit, integration, contract and native TUI tests, and keeps going after a failure so the report lists every suite. A failure opens or comments on the issue "Compatibility with OpenCode <version>"; a pass writes the tested versions to the job summary.

At runtime, `TESTED_UP_TO` is the pinned `@opencode/plugin` version, read from package.json, so a Dependabot bump that passes CI raises it. On a host newer by minor or major, the TUI keeps the built-in `/sessions`, `<leader>l` and quick switch keys, turns the peek keys off, and says once per version that the browser opens with `/super-sessions`. Patch releases, and versions that are not `major.minor.patch` such as `local` source builds, count as tested. The "Use on untested OpenCode versions" setting turns the takeover back on. A crash in the browser closes it and opens the built-in list; a crash in the sidebar's Work rows hides them.
