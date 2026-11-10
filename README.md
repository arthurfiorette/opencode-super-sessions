<p align="center">
   <b>Using this package?</b> Please consider <a href="https://github.com/sponsors/arthurfiorette" target="_blank">donating</a> to support my open source work ❤️
  <br />
  <sup>
   Help opencode-super-sessions grow! Star and share this amazing repository with your friends and co-workers!
  </sup>
</p>

<br />

# OpenCode Super Sessions

A session browser for the OpenCode V2 TUI that also tracks the pull requests and issues each session works on.

<p align="center">
  <img src="https://raw.githubusercontent.com/arthurfiorette/opencode-super-sessions/main/assets/trailer.gif" alt="The session browser opening over OpenCode: sessions grouped by day, with their pull requests, checks and issues" width="960" />
</p>

It replaces OpenCode's session list with a larger overlay where you can:

- search sessions by title, pull request or issue, and message text
- archive, restore, pin, rename, fork and delete sessions
- peek into a session and come back to the list with `esc`
- see each session's pull requests and issues with their state, review, CI and failed checks, from GitHub or GitLab
- link any other work to a session, such as a Linear, Jira or Azure Boards item, a Sentry issue or a Slack thread
- find finished work in a Done view, filled as pull requests merge and issues close
- auto-archive Done sessions and remove worktrees you no longer need, if you turn it on

## Requirements

- OpenCode 2.2.5 or a later 2.2 patch release.
- A [Nerd Font](https://www.nerdfonts.com/) in your terminal. A Mono variant keeps the columns aligned. The Notion and Sentry icons need Nerd Fonts 3.3 or later.
- `gh` for GitHub or `glab` for GitLab, logged in (see [Forge support](#forge-support)). Without them the browser still works, without pull requests and issues.

## Install

```sh
opencode plugin add opencode-super-sessions
```

Restart OpenCode, or run `opencode service restart` if it runs as a service. Then press `<leader>l` (`ctrl+x l` by default) or run `/sessions`.

## Usage

`<leader>l`, `/sessions`, `/resume`, `/continue` and `/super-sessions` open the browser. `/sessions-classic` opens OpenCode's built-in list. Opened from a session, the browser selects that session and switches to the view that lists it, such as Done or Archived.

`tab` and `shift+tab` switch between the views:

| View          | Shows                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------- |
| Active        | Sessions that are not archived or Done, as Pinned, Running, then one group per day of the last activity             |
| Done          | Sessions whose pull requests are all merged or closed, or whose issues are all closed, and sessions you marked Done |
| Archived      | Archived sessions                                                                                                   |
| Pull requests | Every pull request tracked by a session in scope                                                                    |

On terminals at least 120 columns wide, a preview on the right shows the selected session's context usage, its pull requests and issues with their failed checks, and its transcript.

### Keys

The footer shows the common keys, and `ctrl+/` (or `?` while the search is empty) lists them all.

| Key                 | Action                                                                          |
| ------------------- | ------------------------------------------------------------------------------- |
| `enter`             | Open the session                                                                |
| `space`             | Peek at the session. `up` and `down` switch sessions, `esc` returns to the list |
| `tab` / `shift+tab` | Next or previous view                                                           |
| `ctrl+a`            | Switch between this project and all projects                                    |
| `ctrl+s`            | Archive, or restore in the Archived view                                        |
| `ctrl+q`            | Mark Done, or not Done                                                          |
| `ctrl+f`            | Pin or unpin. `<leader>1` to `<leader>9` open the first nine pins               |
| `ctrl+r`            | Rename                                                                          |
| `ctrl+t`            | Generate a new title                                                            |
| `ctrl+d`            | Delete, press twice                                                             |
| `ctrl+b`            | Fork the whole session, or from before one of your prompts                      |
| `ctrl+l`            | Link a pull request, issue or any web page by URL, `owner/repo#N` or `#N`       |
| `ctrl+g`            | Open the session's pull request, issue or link in the web browser               |
| `right`             | Move to the preview's Work rows. `enter` opens, `c` copies, `d` unlinks         |
| `f5`                | Reload the selected row from GitHub or GitLab, skipping the cache               |
| `ctrl+y`            | Archive every Done session, in the Done view                                    |
| `ctrl+o`            | Settings                                                                        |
| `esc`               | Close the browser                                                               |

Rename, pin and delete follow your own keybinds for `session.rename`, `session.pin.toggle` and `session.delete`.

With the mouse, a click selects a row and a double click opens it. A click on a pull request, issue or check opens it in the web browser, and a ctrl+click copies its link. Copying needs a terminal that passes ctrl+click to apps and accepts OSC 52 clipboard writes, such as Ghostty, kitty or WezTerm.

### Search

Typing filters the list by session title and by pull request or issue number and title. `123`, `#123`, `pr 123` and `!12` find sessions tracking that number in any repository. `owner/repo#123` and full URLs find that exact ref. Work links match by id, such as `COR-1466`, by title, and by their full URL. A link to a page outside the trackers also matches any part of its URL.

Sessions that match only in their message text appear a moment later, in an `In messages` group at the bottom.

## Pull request and issue tracking

A session tracks a pull request or issue when:

- you link it in a prompt, as a URL, `owner/repo#N` or `#N`
- the agent creates it with `gh pr create`, `gh issue create`, `glab mr create` or `glab issue create`
- it is the pull request of a branch the session pushed, or one opened on the session's branch after the session started
- the agent links it with the `link_work` tool, which it is told to use for work found any other way
- you link it with `ctrl+l` in the browser
- a tracked pull request closes it, such as with `Fixes #123`

Links in the assistant's replies are mentions. They show in the preview and match in search, but never make a session Done.

Sessions from before you installed the plugin are read for refs the first time you select, peek at or open them. "Scan all sessions now" in the settings reads every session in scope at once.

A session is Done when it is idle and every tracked pull request is merged or closed after your last message. With no pull requests, its issues decide. `ctrl+q` overrides this either way.

`d` on a pull request, issue or link in the preview unlinks it, and asking the agent works too. An unlinked ref is never added back automatically.

### Work links

Work outside GitHub and GitLab can be linked by URL. Links to these services are read from the URL alone, with no login or network call, and show the id or title the URL carries:

| Service      | URL                                                                          |
| ------------ | ---------------------------------------------------------------------------- |
| Linear       | `linear.app/<workspace>/issue/<ID>`                                          |
| Jira         | `<site>.atlassian.net/browse/<KEY>` or a board with `?selectedIssue=`        |
| Azure Boards | `dev.azure.com/<org>/<project>/_workitems/edit/<ID>` or `?workitem=`         |
| Sentry       | `<org>.sentry.io/issues/<ID>` or `sentry.io/organizations/<org>/issues/<ID>` |
| Notion       | A page URL ending in its id                                                  |
| Slack        | `<team>.slack.com/archives/<channel>/p<message>`                             |
| Trello       | `trello.com/c/<card>`                                                        |
| ClickUp      | `app.clickup.com/t/<ID>`                                                     |
| Shortcut     | `app.shortcut.com/<org>/story/<ID>`                                          |
| Asana        | `app.asana.com/0/<project>/<task>` and `.../task/<task>`                     |

Links to these in your prompts are tracked like pull requests. Any other web page is tracked only when you link it with `ctrl+l` or the agent links it with `link_work`, which also takes the title the agent knows. Work links have no state, so they never make a session Done. Rows list them after the issues, in the same five lines.

Forge state is kept in memory only: open pull requests for 2 minutes, closed ones for 15 minutes, merged ones for good.

## Configuration

Options go in the plugin entry's `options`, as in the [GitLab example](#gitlab). Restart OpenCode after changing them. Unknown or invalid options turn the plugin off with a warning.

| Option                    | Default         | Description                                                                           |
| ------------------------- | --------------- | ------------------------------------------------------------------------------------- |
| `providers`               | `["github"]`    | Forges to ask: `"github"`, `"gitlab"` or both                                         |
| `ghPath`                  | `"gh"`          | GitHub CLI command or absolute path                                                   |
| `glabPath`                | `"glab"`        | GitLab CLI command or absolute path                                                   |
| `gitlab.hosts`            | `[]`            | Self-managed GitLab hosts without `gitlab` in the name, such as `code.example.com`    |
| `scope`                   | `"project"`     | Sessions the browser lists at first: `"project"` or `"all"`                           |
| `preview`                 | `true`          | Show the preview pane                                                                 |
| `previewWidth`            | `0.4`           | Preview share of the browser width, from `0.2` to `0.7`                               |
| `rows.refs`               | `true`          | Show pull request, issue and link lines under each session                            |
| `rows.groupIssues`        | `false`         | Join a session's issues and links on one line instead of one line each                |
| `titleScroll`             | `"auto"`        | Scroll cut titles on hover: `"auto"` follows OpenCode's `animations`, `"on"`, `"off"` |
| `detect.prompts`          | `true`          | Track refs and tracker links from your prompts                                        |
| `detect.mentions`         | `true`          | Record refs mentioned in the assistant's replies                                      |
| `search.body`             | `true`          | Index message text for search                                                         |
| `closeTabOnArchive`       | `true`          | Close a session's tab when archiving it                                               |
| `archiveSuffix`           | unset           | Archive a session renamed to end with this text, such as `" !"`                       |
| `autoArchiveDays`         | unset           | Archive Done sessions after this many days. `0` archives them right away              |
| `cleanup.deletedSessions` | `false`         | Remove worktrees whose sessions were all deleted                                      |
| `cleanup.merged`          | `false`         | Remove worktrees whose pull request merged and that hold nothing the merge left out   |
| `cleanup.inactiveDays`    | unset           | Remove worktrees whose sessions had no activity for this many days                    |
| `cleanup.doneDays`        | unset           | Remove worktrees this many days after their sessions became Done                      |
| `cleanup.unchanged`       | `false`         | Remove worktrees of finished sessions with no commits beyond the default branch       |
| `untestedHosts`           | `false`         | Take over the session list on OpenCode versions newer than 2.2                        |
| `colors.<state>`          | GitHub's colors | `"#rrggbb"`, or `{ "dark": "#rrggbb", "light": "#rrggbb" }`                           |

The `colors` states are `open`, `draft`, `merged` and `closed` for pull requests, and `open`, `completed` and `not_planned` for issues.

Most options can also be changed at runtime in the settings dialog (`ctrl+o` in the browser or `/super-sessions settings`). A value set there overrides the option.

### Auto-archive and cleanup

Both are off by default. Auto-archive never takes pinned, running or waiting sessions, or sessions you restored. `/super-sessions undo` restores the last batch for 10 minutes. It needs an open terminal to run.

Cleanup removes only worktrees OpenCode lists for the project, never your main checkout, and never with force. Removing a worktree deletes its directory, ignored files such as `.env` included. A worktree is always kept when:

- a session in it is running, waiting for you, open in a terminal or pinned
- it has modified, staged or untracked files
- it has commits no branch or tag contains

The first removal asks for confirmation. "Run cleanup now" in the settings shows what each rule would remove before it removes anything.

## Commands

| Command                    | Action                                                        |
| -------------------------- | ------------------------------------------------------------- |
| `/sessions`                | Open or close the browser                                     |
| `/super-sessions`          | Open or close the browser, also on untested OpenCode versions |
| `/super-sessions settings` | Open the settings                                             |
| `/super-sessions status`   | Check that `gh` and `glab` are installed and logged in        |
| `/super-sessions undo`     | Restore the last auto-archived sessions                       |
| `/sessions-classic`        | Open OpenCode's built-in session list                         |
| `/archive`, `/unarchive`   | Archive or restore the session on screen                      |
| `/archive-marked`          | Archive every session whose title ends with `archiveSuffix`   |

## Compatibility

The plugin is tested with OpenCode 2.2. On a newer minor or major release, `/sessions` and `<leader>l` keep the built-in list and the browser opens only with `/super-sessions`, until you set `untestedHosts`. If the browser crashes, the built-in list opens instead.

## Limitations

- The browser loads the 200 most recently updated sessions of each list. Search by message text reaches older ones.
- Message search needs `node:sqlite` with FTS5 in the daemon. Without it, search covers titles and refs only.
- Pushes made outside OpenCode, from your own terminal or editor, are not seen.
- GitLab instances served under a URL path, such as `https://example.com/gitlab`, are not supported.

## Forge support

`/super-sessions status` checks that the CLI of each configured forge is installed and logged in.

### GitHub

GitHub works without configuration. Log in with `gh auth login`.

github.com, `*.ghe.com` and hosts with a `github` label, such as `github.example.com`, are recognized. Log in to a GitHub Enterprise Server host with `gh auth login --hostname <host>`.

### GitLab

Log in with `glab auth login`, then add `gitlab` to `providers` in `~/.config/opencode/opencode.json`. The entry `opencode plugin add` wrote becomes an object:

```json
{
  "plugins": [
    {
      "package": "opencode-super-sessions",
      "options": {
        "providers": ["github", "gitlab"]
      }
    }
  ]
}
```

gitlab.com and hosts with a `gitlab` label, such as `gitlab.example.com`, are recognized. List other self-managed hosts in `gitlab.hosts`, and log in to each with `glab auth login --hostname <host>`.

### Other forges

Bitbucket, Gitea, Forgejo and other forges are not supported yet. Pull requests adding one are welcome, and [CONTRIBUTING.md](CONTRIBUTING.md#providers) lists the steps.

## Uninstall

Run `opencode plugin remove opencode-super-sessions` and restart OpenCode. To delete the search index too, remove `$XDG_DATA_HOME/opencode/plugins/opencode-super-sessions` (`~/.local/share/opencode/plugins/opencode-super-sessions` by default).

[Contributing, development and architecture](CONTRIBUTING.md)

## License

[MIT](LICENSE) © [Arthur Fiorette](https://github.com/arthurfiorette)
