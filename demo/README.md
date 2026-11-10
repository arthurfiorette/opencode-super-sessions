# Demo

A real OpenCode TUI with the plugin loaded, on fake repositories, sessions and GitHub and GitLab data, for screenshots. It never reads or writes your own OpenCode config, sessions or credentials.

```sh
pnpm demo
```

This builds the plugin and runs `node demo/start.mjs`, which:

1. wipes `demo/.state` and seeds it again (about 2.5 s), so every age stays relative to now;
2. creates the git repositories and worktrees under `demo/.state/home/src`;
3. imports the sessions with `opencode session import`;
4. starts `opencode --standalone` in `~/src/storefront`, on the session "Speed up search suggestions", which keeps running for as long as the TUI does.

Press `<leader>l` (`ctrl+x l`) to open the browser.

| Option         | Effect                                                                |
| -------------- | --------------------------------------------------------------------- |
| `--keep`       | Reuse the existing state instead of seeding again                     |
| `--no-running` | Start on the home screen without prompting the running session        |
| Anything else  | Passed to `opencode`                                                  |
| `OPENCODE_BIN` | The `opencode` binary to run, `opencode` on `PATH` by default (2.2.7) |

It needs Node.js 24.16+, git and a terminal with a Nerd Font. The fake `gh` and `glab` are POSIX shell scripts. On Windows the plugin cannot run them, so the TUI starts but shows no pull request or issue state.

For a fixed size, run it in tmux:

```sh
tmux new -d -s demo -x 200 -y 50 'pnpm demo'
tmux attach -t demo
```

## Projects

`ctrl+a` switches between `storefront` and all projects.

| Project    | Forge                            | Shows                                                                                                                                                                                                                         |
| ---------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| storefront | GitHub, `acme/storefront`        | Two pins, a running session, unread sessions, every pull request state and review, a session with six issues, a manual and an automatic Done, two archived sessions, worktrees whose branch pull requests are found by branch |
| api        | GitHub, `acme/api`               | A merged branch pull request in a worktree (Done), a pull request with one failed check, a session without refs                                                                                                               |
| docs       | GitHub, `acme/docs`              | An unread session with a pull request waiting for review, a session with one issue                                                                                                                                            |
| mobile     | GitLab, `gitlab.com/acme/mobile` | A merge request with a failing pipeline, an approval and an open thread, and the issue it closes                                                                                                                              |

Sessions in storefront:

| Session                                         | Shows                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Fix rounding in multi-currency totals           | Pin 1; #476 open, approved, all checks passing, threads resolved; issue #468                                 |
| Clean up legacy promo banner flags              | Pin 2; two issues, one open and one completed                                                                |
| Speed up search suggestions                     | Running; issue #474                                                                                          |
| Redesign the checkout summary step              | Worktree; branch PR #482 with changes requested, merge conflicts, 3 open threads, 7 failed checks; a mention |
| Show gift card balance in the cart              | Worktree, unread; branch PR #491, a draft with checks pending                                                |
| Investigate flaky cart E2E on Safari            | Unread; one issue                                                                                            |
| Triage checkout bugs from the support queue     | Six issues (five shown, `+1 more`): open, completed and not planned                                          |
| Lazy-load product images below the fold         | #479 waiting for review, checks only cancelled (muted stop)                                                  |
| Spike: server-side rendering for category pages | No refs; its messages hold the word `kestrel`, so searching for it shows the In messages group               |
| Make coupon codes case-insensitive              | #484 approved with 2 open threads, and a separate issue                                                      |
| Try container queries for the product grid      | #460 closed, with a prompt after the close, so it stays in Active                                            |
| Audit third-party scripts on the product page   | No refs                                                                                                      |
| Write the Q4 storefront performance report      | Done by the user's mark                                                                                      |
| Send a reminder email for saved carts           | Done because #451 merged; the issue it closes                                                                |
| Prototype one-click reorder                     | Archived; #432 merged                                                                                        |
| Update the holiday banner copy                  | Archived; no refs                                                                                            |

The Pull requests view of storefront lists eight pull requests. #482 has a markdown description with a list, a code block and a quote.

Rows that come on screen through a view switch, `ctrl+a`, a search or scrolling load their states right away; `f5` reloads the selected row past the caches.

## State

Everything lives in `demo/.state`, which git ignores:

| Path                                     | Holds                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| `home`                                   | `HOME` and the XDG directories of every process the demo starts            |
| `home/.config/opencode`                  | `opencode.json` (the scripted model and the plugin) and `cli.json` (theme) |
| `home/.local/share/opencode/opencode.db` | The demo's database                                                        |
| `home/src`                               | The git repositories, with worktrees in `.worktrees`                       |
| `bin`                                    | The `gh` and `glab` shims, also on the TUI's `PATH` for `!` commands       |
| `import`                                 | The session files given to `opencode session import`                       |
| `forge.log`                              | Every `gh` and `glab` call the plugin made                                 |

The sessions are in `demo/sessions.mjs` and the forge data in `demo/forge/data.mjs`. The fake `gh` answers through `test/fixtures/gh-protocol.mjs`, the same code the integration tests use.

The import stamps every session with the time of the import, and no API sets the update time, so the seed writes each session's `time_updated` into the demo's database once the import server has exited. Each session also carries the plugin's history scan marker and the `closes` links the plugin would add, since a metadata write moves a session's update time to now.

Permission and question markers (`!`, `?`) are not part of the demo: they need a second live turn, and `--prompt` drives only one session.
