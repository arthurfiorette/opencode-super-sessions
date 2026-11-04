<p align="center">
   <b>Using this package?</b> Please consider <a href="https://github.com/sponsors/arthurfiorette" target="_blank">donating</a> to support my open source work ❤️
  <br />
  <sup>
   Help opencode-super-sessions grow! Star and share this amazing repository with your friends and co-workers!
  </sup>
</p>

<br />

# OpenCode Super Sessions

A session browser for the OpenCode V2 TUI. It replaces the built-in session list with a larger overlay where you can search sessions by title, pull request, issue or message text, archive and restore them, peek into one and come back, and review finished work in a Done view.

The plugin also follows the pull requests and issues each session works on. It picks them up from your prompts, from the commands the agent runs and from the session's branch, and shows their state, review and CI status from GitHub or GitLab next to the session. Optional rules archive finished sessions and remove worktrees you no longer need.

**Requirements:** OpenCode V2 2.2.5 (see [Compatibility](#compatibility)), a [Nerd Font](https://www.nerdfonts.com/) in the terminal (a Mono variant keeps the columns aligned), `gh` logged in with `gh auth login` for GitHub, and `glab` logged in with `glab auth login` for GitLab. The plugin runs inside OpenCode, so you do not need Node.js. Without `gh` or `glab` the browser still works, without pull requests and issues.

## Get started

1. Add the plugin to `~/.config/opencode/opencode.json` (or `$XDG_CONFIG_HOME/opencode/opencode.json`; `.jsonc` also works):

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": [
       {
         "package": "opencode-super-sessions@latest",
         "options": {
           "providers": ["github", "gitlab"]
         }
       }
     ]
   }
   ```

   Every option is optional; see the [configuration reference](#configuration-reference). The same entry loads the server plugin in the daemon and the TUI plugin in every terminal.

2. Restart OpenCode. If it runs as a managed service, run `opencode service restart`.

3. Press `<leader>l` (`ctrl+x l` unless you changed it) or run `/sessions`.

4. Run `/super-sessions status` to check that `gh` or `glab` is found and logged in.

## Session browser

The browser draws over the screen like OpenCode's own dialogs, only larger. The session underneath stays open, so closing the browser is instant.

These open and close it:

- `<leader>l`, your keybind for OpenCode's `session.list` command.
- `/sessions` and its aliases `/resume` and `/continue`, or "Switch session" in the command palette.
- `/super-sessions` or "Open Super Sessions" in the palette. These keep working on OpenCode versions the plugin was not tested with.

`/sessions-classic` and "Classic session list" in the palette open the built-in list instead.

The browser remembers the search, view, selection and scroll position until you quit OpenCode, so it reopens where you left it.

### Views

`tab` and `shift+tab` cycle through the views, and a left click on a view name switches to it. Each name shows how many sessions, or pull requests, it holds.

| View          | Holds                                                                                         | Grouped by                                                                  |
| ------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Active        | Sessions that are not archived and not [Done](#done)                                          | Pinned, then Running, then the day of the last update                       |
| Done          | Sessions whose pull requests or issues are all merged or closed, and sessions you marked Done | The day of the last merge or close, or of your mark                         |
| Archived      | Archived sessions                                                                             | The day they were archived, newest update first in a day                    |
| Pull requests | Every pull request a session in scope tracks, archived sessions included                      | The day of its last update on the forge, open and draft ones first in a day |

Pinned sessions stay in the Pinned group of Active even when they are Done. `ctrl+a` switches between this project and all projects. The choice is kept across restarts until you change the "Default scope" setting.

### Rows

A row is its title line and, when they apply, the lines under it:

- The title line: a marker, the title and the age of the last update. In the Archived view the age reads `archived 3d · updated 5d`.
- The PR line, when the session has a [main pull request](#main-pull-request): its icon and number in the state color, its [review and CI icons](#review-and-ci-icons) while it is open or a draft, then its title. A trailing `+N` counts the session's other pull requests and mentioned refs.
- One line per tracked issue: its icon and number in the state color, then its title, cut with `…`. The issues the main pull request closes come first, then the others newest first. After five issues the rest are counted on a `+N more` line. Without a PR line, the first issue line carries the `+N` for the other refs.
- With the "Group issues" setting on, one issues line instead: every issue number in its state color, joined as `#1230, #19083 and #8923`, with `+N` for the ones that do not fit. A session that tracks one issue shows its title after the number.

The marker column shows one of these, highest first:

| Marker     | Meaning                                                              |
| ---------- | -------------------------------------------------------------------- |
| `1` to `9` | The session's pin slot, used by the quick switch keys                |
| `!`        | A permission request waits for you                                   |
| `?`        | A question waits for you                                             |
| spinner    | The session is running, in the warning color like the Running header |
| `●`        | Unread: the session finished after you last viewed it                |
| `-`        | None of the above; muted, so each session's start stands out         |

With animations off in OpenCode, the spinner is a still `⋯`. Titles wrap onto as many lines as they need, so a row keeps its height when the selection or the mouse moves; the PR and issues lines are cut with `…`. The "PR and issue line" setting hides those lines.

### Review and CI icons

An open or draft pull request shows these Nerd Font icons in this order. On list rows and in the Pull requests view they follow its icon and number on the same line. In the preview's Work rows and in the sidebar they get their own line under the pull request, so the title keeps its room. A part without data is left out, so the icon and number always start in the same column.

| Part      | Icons                                                                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review    | Changes requested (red), approved (green) or review required (muted)                                                                                  |
| CI        | Passing (green check), failing (red x), pending (yellow dot) or cancelled (muted stop), then `passed/total` such as `91/93` unless every check passed |
| Conflicts | An alert icon in red when the branch conflicts with its base. Nothing while the forge has not checked yet                                             |
| Threads   | A comment icon and the number of unresolved review threads, in yellow                                                                                 |

The CI icon is the muted stop when the only checks that did not pass were cancelled: nothing failed and nothing still runs. GitHub's own rollup calls that a failure. Work rows and the sidebar leave `passed/total` out, since the checks that need a look are listed by name. When one is, the first takes the CI icon's place on the icons' line and its own icon stands for the CI result.

On GitHub, successful, neutral and skipped check runs and successful statuses count as passed. github.com's own list leaves out a check run that a re-run replaced, so the totals here can be higher than there. On GitLab, the counts are the head pipeline's jobs: successful and skipped ones pass, and manual and retried jobs are not counted.

### Pull requests view

Each row is a pull request: a muted `-` in the marker column, its icon and number in the state color, its [review and CI icons](#review-and-ci-icons), its title, and how many sessions track it. The search filters these rows by number (`12`, `#12` or `!12`) and title.

`enter` or a double click opens the newest session that tracks the selected pull request, `space` peeks it, `ctrl+g` opens the pull request in your web browser, and `f5` reloads it with its checks. The keys that change one session (archive, Done, rename, pin, delete, fork, link) are off in this view. The footer reads `enter open  space peek  ctrl+g open PR  ctrl+/ keys`.

The preview shows the title and state, `head -> base`, the author, the review verdict, merge conflicts and unresolved threads, the checks, the issues the pull request closes and the ones its sessions track, the description, and the sessions that worked on it. The checks take one summary line of icons and counts, leaving out zeros: passed (green check), skipped (muted skip), cancelled (muted stop), pending (yellow dot) and failed (red x); when every check passed, only the green check and the count. Under it each check that failed or waits for an action is listed by name, failures first, at most ten and then `+N more`, which opens the pull request's checks page. Cancelled checks are counted, never listed. A listed check is a link to its page, such as the job's log: hovering makes its name bold, a click opens it and a ctrl+click copies it. `right` moves the arrow keys to the sessions, `enter` opens one, and `left` or `esc` goes back. Author, branches, checks and description are fetched for the selected pull request only, and cached as long as its state.

### Pins

`ctrl+f`, your keybind for OpenCode's `session.pin.toggle`, pins or unpins the selected session. Pins belong to the plugin: the first time it starts, it copies the pins you had in the built-in list, and from then on it keeps its own list. The quick switch keys (`<leader>1` to `<leader>9`) open the first nine pins. OpenCode turns those keys off while session tabs are on, and the plugin does the same.

### Search

Typing filters the loaded sessions at once. 150 ms after the last keystroke, the server plugin adds what it finds beyond them.

| Query                                             | Finds                                                    |
| ------------------------------------------------- | -------------------------------------------------------- |
| Any text                                          | Titles, pull request and issue titles, message text      |
| `123`, `#123`, `pr 123`, `pull #123`, `issue 123` | Sessions that track or mention ref 123 in any repository |
| `mr !12`, `!12`                                   | The same, for GitLab merge requests                      |
| `owner/repo#123`, or a pull request or issue URL  | Sessions with exactly that ref                           |

A number never matches as the start of a longer one, so `12` does not find `#123`. URLs and `owner/repo#123` need the server plugin. Message search covers your prompts and the assistant's replies, in subagent sessions too, and needs at least one word of three or more characters.

Title and ref matches are grouped like the Active view: Running first, then `Today` and one group per earlier day of the last update. Inside a group, title matches come first, then ref number matches and ref title matches, newest first. Sessions found only by their message text go last, newest first, under a muted `In messages` header, so the server's answer adds them below the rows you are looking at. A muted label on the right says why a session matched a pull request or issue, such as `PR #12`, `issue title` or `MR !3`. The pull request or issue that matched is drawn on the row even when the row would not show it otherwise.

The Archived view searches archived sessions; Active and Done search the others.

### Preview

When the browser is at least 120 columns wide, the selected session shows on the right. The "Preview pane" setting turns it off, and "Preview width" sets its share of the width.

The header holds the title and these sections:

- Context: tokens in the context window and their share of the model's limit, the cost so far, and whether the session is running, idle, interrupted or failed.
- Session: the project (only when it differs from the browser's), the worktree directory (only when it is not the project root) and the branch (only when it is not the default branch).
- Work: every tracked pull request and issue, the main pull request first. A pull request's line holds its state icon, number and title. Under an open one, a line shows its [review and CI icons](#review-and-ci-icons) when it has any. Each check that failed (red x) or waits for an action (yellow alert) is listed by name, failures first, at most five and then `+N more`; pending and cancelled checks are not listed. The first listed check goes on the icons' line in place of the CI icon, after a two-cell gap, and the others line up under it. A click on a listed check opens its log and on `+N more` the pull request's checks page, and a ctrl+click copies the link. The icons are not a link. The issues a pull request closes sit right under it, and mentioned refs follow under `mentioned`.

The transcript below draws messages the way OpenCode's session view does and follows your `cli.json` session settings (scrollbar, thinking, markdown, verbosity, grouping). It starts at the latest message; scrolling up loads older ones.

### Peek

`space`, while the search is empty, shows the selected session in place of the browser. A banner above the prompt reads `Peeking 3 of 12   ↑↓ switch   esc back to list`.

- `up` and `down` move to the previous or next session of the browser's list while the prompt is empty. With text in the prompt, the arrows edit the prompt as usual.
- `esc` reopens the browser on the session you peeked last.
- Sending a message in the session, or going to another screen, ends the peek. `enter` in the browser opens a session without peeking.

While you peek at a running session, `esc` returns to the list instead of interrupting it. Send a message or open the session with `enter` to get the usual `esc` back.

### Work links

`right` moves the arrow keys from the list to the preview's Work rows. It does so only while the search cursor is at the end of the query and the preview shows Work rows; otherwise it moves the cursor. In the Work rows, `up` and `down` select a row, `enter` opens it in your web browser, and `left` or `esc` returns to the list. Selecting another session or typing also returns to the list. A left click on a Work row opens it too, and `c` copies the selected row's URL.

### Copying links

A ctrl+click on any link the plugin draws copies its URL instead of opening it: Work rows and failed check lines in the preview and the sidebar, rows of the Pull requests view, and checks in its preview. The copy goes through the terminal (OSC 52) and a toast confirms it, or says the terminal refused.

Some terminals keep ctrl+click for themselves:

| Terminal     | ctrl+click                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| Ghostty      | Passed to the plugin                                                                                     |
| kitty        | Passed to the plugin                                                                                     |
| WezTerm      | Passed to the plugin, unless you bound it with `mouse_reporting = true`                                  |
| iTerm2       | Opens iTerm2's menu, unless Settings > Pointer > "Ctrl-click reported to apps, does not open menu" is on |
| Terminal.app | Opens the context menu; use `c` in the Work rows instead                                                 |

### Keys

The footer always shows the same hints: `space peek`, `ctrl+s archive`, `ctrl+q done` and `ctrl+/ keys` on the left, `ctrl+a all projects` on the right. While the Work rows have the arrow keys it reads `enter open`, `c copy` and `left back`. Every other action is in the keys dialog: `ctrl+/`, or `?` while the search is empty, lists each browser action with its key, like OpenCode's command palette. Type to filter it, and `enter` runs the action on the selected session.

Keys are written the way OpenCode writes them. Keys marked "yours" belong to an OpenCode command the browser reuses, so the browser, its footer and the keys dialog follow your own keybinds for that command.

| Key                           | Action                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `up` / `down`                 | Select the previous or next session                                                                                            |
| `pageup` / `pagedown`         | Move by the rows on screen                                                                                                     |
| `home` / `end`                | Select the first or last session                                                                                               |
| `enter`                       | Open the session; in the Pull requests view, its newest session                                                                |
| `space`                       | [Peek](#peek), while the search is empty                                                                                       |
| `right`                       | Move to the [Work links](#work-links), or to the sessions of a pull request                                                    |
| `c`                           | Copy the selected Work link's URL, while the Work links have the arrow keys                                                    |
| `esc`                         | Close the browser                                                                                                              |
| `ctrl+/`, `?`                 | The keys dialog. `?` types into a search that is not empty                                                                     |
| `tab` / `shift+tab`           | Next or previous view                                                                                                          |
| `ctrl+a`                      | Switch between this project and all projects                                                                                   |
| `ctrl+s`                      | Archive, or restore in the Archived view                                                                                       |
| `ctrl+q`                      | Mark Done, or not Done when the session is Done (see [Done](#done))                                                            |
| `ctrl+r` (yours)              | Rename (`session.rename`)                                                                                                      |
| `ctrl+t`                      | Ask OpenCode's title agent for a new title                                                                                     |
| `ctrl+f` (yours)              | Pin or unpin (`session.pin.toggle`)                                                                                            |
| `ctrl+d` (yours)              | Delete; press twice (`session.delete`)                                                                                         |
| `ctrl+b`                      | Fork the session, whole or before one of your prompts, and open the fork (see below)                                           |
| `ctrl+y`                      | Archive every Done session after confirmation. Done view, not while searching                                                  |
| `ctrl+l`                      | Link a pull request or issue: a URL, `owner/repo#N` or `#N`                                                                    |
| `ctrl+g`                      | Open the main pull request, or else the first issue, in your web browser. In the Pull requests view, the selected pull request |
| `f5`                          | Reload the selected row from GitHub or GitLab, past the caches (see below)                                                     |
| `ctrl+p`                      | OpenCode's command palette; `esc` returns to the browser                                                                       |
| `ctrl+o`                      | [Settings](#settings)                                                                                                          |
| `ctrl+c`, `<leader>q` (yours) | Clear the search, then close the browser (`app.exit`)                                                                          |

Most terminals send `ctrl+/` as `ctrl+_`; the browser takes both.

The quit keys never exit OpenCode from the browser. With the default keys `ctrl+d` deletes there, because `session.delete` wins over `app.exit` inside the browser.

`f5` asks GitHub or GitLab again for the selected row, past the caches: the session's pull requests and issues, its branch's pull request and its git checkout, or in the Pull requests view the pull request and its checks. A toast says `Reloading…` when the answer takes longer than 300 ms, and names the forge when it fails. While the forge's rate limit is spent, the plugin still waits for the reset.

`ctrl+b` forks the selected session like OpenCode's `/fork`. A dialog lists "Full session", then your prompts in the session, newest first, with the time each was sent. Picking a prompt copies the conversation up to just before it, and the browser opens the new session. Unlike `/fork`, the prompt you picked is not put back in the composer, because plugins cannot fill it. In the browser `ctrl+b` no longer moves the search cursor left; `left` still does.

### Mouse

| Action                       | In the list                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| Hover                        | Tints the row; the selection and the preview stay where they are                               |
| Left click                   | Selects the row, like the arrow keys                                                           |
| Double click (within 400 ms) | Opens the session, like `enter`; in the Pull requests view, its newest session                 |
| ctrl+click                   | In the Pull requests view, copies the pull request's URL (see [Copying links](#copying-links)) |
| Wheel                        | Scrolls the list or the preview under the pointer, without selecting                           |

Work rows, checks and failed check lines are links: a click opens them in your web browser and a ctrl+click copies them. A click on a view name switches to it, and a click on `esc` or outside the panel closes the browser.

## Sidebar

The session sidebar lists the session's pull requests and issues at the top, right under the title: the branch's pull request first, then pull requests the agent linked or created or you linked, then other pull requests, then issues. Each row shows the state icon in the state color, the number and the title. Open pull requests get the same [review and CI icons](#review-and-ci-icons) and failed checks under them as in the preview, the first check on the icons' line, and mentioned refs are counted in a `+N mentioned` line. Hovering a row scrolls a cut title (see "Title scrolling on hover"), a click opens it in your web browser, and a ctrl+click copies its URL (see [Copying links](#copying-links)). A session without pull requests, issues or mentions shows nothing there.

## Pull request and issue tracking

The plugin stores the refs it links in the session's metadata, so they survive restarts. Live state comes from `gh` or `glab` and stays in memory.

### Sources

| Source       | How a ref gets in                                                                                                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your prompts | URLs, `owner/repo#N` and bare `#N` in your messages. A bare number is looked up in the session's repository and kept only once the forge confirms it. On GitLab, `!N` is a merge request. |
| Created      | The agent's shell tool or a `!` command runs `gh pr create`, `gh issue create`, `glab mr create` or `glab issue create` (or `new`), and the new URL is printed alone on a line            |
| Branch       | The pull request whose head is the session's current branch. Not stored: it follows the branch. The default branch, a detached HEAD and a branch that was never pushed get none.          |
| Agent        | The agent calls `link_work`                                                                                                                                                               |
| Browser      | You press `ctrl+l` in the browser                                                                                                                                                         |
| Closes       | Issues a tracked pull request closes, such as `Fixes #123` in its description                                                                                                             |
| Mentioned    | URLs and `owner/repo#N` in the assistant's replies, never a bare `#N`. Mentions count in `+N`, show in the preview and match in search; they never decide Done.                           |

For a branch pushed to a fork, the plugin looks the pull request up in the original repository (the `upstream` remote when it exists, else `origin`) and keeps only pull requests whose head is in that fork. Among several, the newest open one wins, else the newest.

The "Record refs from prompts" and "Record mentioned refs" settings turn off the first and the last source.

### Older sessions

Detection watches sessions as they run, so sessions from before you installed the plugin, or from while it was not running, start without refs. The first time you select such a session in the browser (its preview loads), peek at it or open it, the plugin reads its whole history in the background and links what detection would have linked: refs in your prompts, PRs and issues created with `gh` or `glab`, and mentions. The same pass adds the session's prompts and replies to message search. Each session is read once; the plugin records that in the session's metadata, and later messages are covered as they come.

Nothing is read until you touch a session. One session is read at a time, in pages of 100 messages with a short pause between pages, and closing the browser stops the read of a session you only selected. "Scan all sessions now" in the [settings](#settings) reads every session in the browser's current scope after asking, with progress in a toast.

### Main pull request

The PR line shows one pull request: the branch's pull request, else the newest one the agent linked or created or you linked, else the newest one from your prompts.

### Review and CI status

For open and draft pull requests the plugin reads the review decision, how many review threads are resolved, and the combined CI result of the head commit with its passed and total counts. List rows show them as [icons](#review-and-ci-icons) on the PR line. The preview's Work rows and the sidebar show the icons on a line under the pull request and list the checks that failed or wait for an action by name; those names come from the pull request's check list, which the plugin fetches only for pull requests of the session on screen that have such checks.

States are cached: open and draft pull requests for 2 minutes, closed ones for 15 minutes, merged ones and closed issues for good, and errors for 30 seconds. While the browser is open it refreshes the visible rows every 60 seconds, and the sidebar refreshes its session every 60 seconds. `gh pr merge`, `gh pr close`, `gh issue close`, `glab mr merge`, `glab mr close` and `glab issue close` refresh the session's refs right away. When the forge reports its rate limit is spent, the plugin waits for the reset and keeps showing the last known state.

### Done

A session is Done when all of these hold:

- It is not running, has no permission request or question waiting, and is not archived.
- It tracks at least one pull request, or, without any, at least one issue that is not there only because a pull request closes it.
- Every such pull request is merged or closed, or every such issue is closed.
- The last of those merges or closes happened after your last message in the session.
- The state of every tracked ref is known. A failed fetch keeps the session out of Done.

`ctrl+q` in the browser overrides these rules for the selected session. On a session that is not Done it marks the session Done, whatever its refs, your last message or a waiting question say. On a Done session it marks it not Done, so it stays in Active even when its refs close. A running or archived session is never Done. The mark is stored in the session's metadata with the refs.

### Unlinking

Ask the agent to unlink a ref; it calls `unlink_work`. Detection and the branch lookup never add an unlinked ref back, while linking it again with `link_work` or `ctrl+l` does. Unlinking a pull request also drops the issues that were linked only because it closes them. The browser has no unlink key.

### Agent tools

The plugin adds these tools for the agent:

- `link_work` records up to 10 pull requests or issues the session works on, each as a URL, `owner/repo#N`, or a number with an optional repository and kind. A bare number uses the repository of the session's directory.
- `unlink_work` stops tracking up to 10 refs.

Neither changes anything on GitHub or GitLab. Every request to the model also carries a short instruction: refs in your messages, branch pull requests and refs created with `gh` or `glab` are tracked already, and the agent must call `link_work` for work you did not link, such as an issue it found by searching or a pull request it opened another way. With "Record refs from prompts" off, the instruction asks it to link the refs you name too.

## Settings

Open the settings with `ctrl+o` in the browser, `/super-sessions settings`, or "Super Sessions settings" in the palette. The dialog has a search field. `up` and `down` select a row (your dialog keys), `left` and `right` change the value, and `enter` steps forward, runs an action or asks for a custom value.

| Group         | Setting                              | Values, default first                  | Meaning                                                                                                  |
| ------------- | ------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| List          | Default scope                        | this project, all projects             | Which sessions the browser lists. Changing it also drops an earlier `ctrl+a` choice                      |
|               | PR and issue line                    | on, off                                | Whether rows show the PR and issues lines                                                                |
|               | Group issues                         | off, on                                | Whether rows join their issues on one line instead of one line per issue with its title                  |
|               | Title scrolling on hover             | follow animations, off, on             | Whether a cut title in the sidebar and preview Work rows scrolls while the mouse is over it              |
| Preview       | Preview pane                         | on, off                                | Whether the browser shows the preview                                                                    |
|               | Preview width                        | 40%; 30% to 60% in 5% steps            | The preview's share of the browser width                                                                 |
| Archiving     | Close tab when archiving             | on, off                                | Whether archiving a session also closes its tab                                                          |
|               | Archive on title suffix              | off, `" !"`, custom                    | Archives a session when you rename it to end with this text, and removes the text                        |
|               | Auto-archive Done sessions           | off, immediately, after 1, 3 or 7 days | See [Auto-archive](#auto-archive)                                                                        |
| Tracking      | Record mentioned refs                | on, off                                | Whether links in the assistant's replies are kept for search and the preview                             |
|               | Record refs from prompts             | on, off                                | Whether pull requests and issues in your prompts are tracked                                             |
|               | Providers                            | GitHub, GitLab, both                   | Which forges are asked for state                                                                         |
|               | Scan all sessions now                | action                                 | Reads every session in the current scope for refs and search text. See [Older sessions](#older-sessions) |
| Cleanup       | Delete worktrees of deleted sessions | off, on                                | See [Worktree cleanup](#worktree-cleanup)                                                                |
|               | Delete merged worktrees              | off, on                                |                                                                                                          |
|               | Delete inactive worktrees            | off, after 3, 7, 14 or 30 days         |                                                                                                          |
|               | Delete worktrees of Done sessions    | off, immediately, after 1, 3 or 7 days |                                                                                                          |
|               | Delete unchanged worktrees           | off, on                                |                                                                                                          |
|               | Run cleanup now                      | action                                 | Lists what the rules would remove and asks before removing anything                                      |
| Compatibility | Use on untested OpenCode versions    | off, on                                | See [Compatibility](#compatibility)                                                                      |

The plugin options are the defaults, so the first value above is the default only when you set no option. A value changed in the dialog overrides the option, and changing it back to the option's value removes the override. Every change applies at once, without a restart.

The List, Preview, Compatibility and Archiving settings other than auto-archive belong to the TUI: they are kept in OpenCode's plugin storage and shared by every terminal. Auto-archive, Tracking and Cleanup belong to the server plugin, which keeps them in its own plugin storage in the daemon.

## Auto-archive

With "Auto-archive Done sessions" on, a Done session is archived that many days after its last pull request merged or issue closed, or after you marked it Done. "Immediately" archives it at the next check. Pinned sessions, running sessions and sessions waiting on a permission or question are never archived.

The daemon checks 5 seconds after it starts, every 10 minutes, and shortly after a session finishes, a session is deleted or a tracked pull request merges. OpenCode does not let server plugins archive, so an open TUI does the archiving: nothing is archived while no terminal is open.

A toast reports each batch. For 10 minutes after it, `/super-sessions undo` or "Undo auto-archive" in the palette restores those sessions. A session you restore, with undo, `ctrl+s` in the Archived view or `/unarchive`, is never archived automatically again.

## Worktree cleanup

All cleanup rules are off by default. They only touch worktrees OpenCode itself lists for a project, never the project's main checkout. Removing a worktree deletes its directory, including ignored files such as `.env`. Branches and session history are kept.

| Rule                                 | Removes a worktree when                                                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Delete worktrees of deleted sessions | A session in it was deleted while the plugin was running, and no session uses it any more                                               |
| Delete merged worktrees              | A tracked pull request is merged, none is still open or a draft, and the branch holds nothing the merge left out                        |
| Delete inactive worktrees            | At least one session uses it, and every session in it was last updated more than this many days ago                                     |
| Delete worktrees of Done sessions    | At least one session in it is Done, every session in it is archived or Done, and the Done ones became Done more than this many days ago |
| Delete unchanged worktrees           | At least one session uses it, every session in it is archived or Done, and the branch has no commits beyond the default branch          |

The merged, Done and unchanged rules wait until every session in the worktree is archived or Done. The inactive rule does not.

Squash and rebase merges put new commits on the default branch, so for those the plugin compares the branch with the pull request's head commit as the forge reports it. The worktree is removed when the branch is at that commit or behind it. It is kept when the branch has commits the pull request did not include, or when the head commit is not in your local repository.

Whatever the rules say, a worktree is kept when:

- a session in it is running, waits for a permission or a question, is open in a terminal or is pinned;
- `git status` cannot be read in it, or a fact a rule needs is unknown;
- it has local changes: any modified, staged or untracked file. Ignored files such as `.env` do not count;
- it has commits that no branch, remote branch or tag contains ("has commits no branch or tag contains"). OpenCode creates worktrees on a detached HEAD, so commits made there without creating a branch would be lost with the worktree. Commits already in the default branch or in a merged pull request do not count.

Removal has no undo, and nothing is removed with force. The first time a rule would remove something, a terminal shows the list and asks. After you confirm once, the rules remove on their own and a toast reports each removal. "Run cleanup now" in the settings shows a dry run with each worktree, what would happen to it and why, and asks before removing; until you have confirmed once, it says that confirming also turns on automatic removal. Right before each removal the plugin checks the worktree again: its sessions, including any started there since, whether one runs, waits, is open or is pinned, and its git status and commits. If anything now keeps it, it stays.

## Commands

| Command                    | Palette                          | Action                                                                                                             |
| -------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `/sessions`                | Switch session                   | Open or close the browser                                                                                          |
| `/super-sessions`          | Open Super Sessions              | Open or close the browser, also on untested OpenCode versions                                                      |
| `/super-sessions settings` | Super Sessions settings          | Open the settings                                                                                                  |
| `/super-sessions status`   | Super Sessions status            | Show whether the CLI of each forge in "Providers" is installed and logged in                                       |
| `/super-sessions undo`     | Undo auto-archive                | Restore the last auto-archived sessions                                                                            |
| `/sessions-classic`        | Classic session list             | Open OpenCode's built-in session list                                                                              |
| `/archive`                 | Archive session                  | Archive the session on screen                                                                                      |
| `/unarchive`               | Restore archived session         | Restore the session on screen                                                                                      |
| `/archive-marked`          | Archive sessions ending in "..." | Archive every session whose title ends with the suffix, after confirmation. Only with "Archive on title suffix" on |

`/archive` and `/unarchive` act on the top-level session when a subagent's view is on screen. The status check asks only the forges in "Providers", on github.com and gitlab.com.

## Configuration reference

Options go in the plugin entry's `options`. Unknown options are rejected. With an invalid option the TUI shows a toast and leaves the built-in session list in place, and the server plugin logs a warning and tracks nothing. The daemon keeps the options of the first project that loads the plugin, so use the same options everywhere and restart OpenCode after changing them.

| Option                    | Default         | Description                                                                                |
| ------------------------- | --------------- | ------------------------------------------------------------------------------------------ |
| `ghPath`                  | `gh`            | GitHub CLI command name or absolute path, without arguments                                |
| `glabPath`                | `glab`          | GitLab CLI command name or absolute path, without arguments                                |
| `providers`               | `["github"]`    | Forges to ask: `"github"`, `"gitlab"` or both                                              |
| `gitlab.hosts`            | `[]`            | Self-managed GitLab hosts whose names have no `gitlab` label, such as `code.example.com`   |
| `detect.prompts`          | `true`          | Track refs from your prompts                                                               |
| `detect.mentions`         | `true`          | Record refs mentioned in the assistant's replies                                           |
| `search.body`             | `true`          | Index message text for search                                                              |
| `archiveSuffix`           | Unset           | Archive a session renamed to end with this text (1 to 10 characters), such as `" !"`       |
| `closeTabOnArchive`       | `true`          | Close a session's tab when archiving it                                                    |
| `previewWidth`            | `0.4`           | The preview's share of the browser width, from `0.2` to `0.7`                              |
| `preview`                 | `true`          | Show the preview                                                                           |
| `scope`                   | `"project"`     | Default scope: `"project"` or `"all"`                                                      |
| `rows.refs`               | `true`          | Show the PR and issues lines on rows                                                       |
| `rows.groupIssues`        | `false`         | Join a row's issues on one line instead of one line per issue                              |
| `titleScroll`             | `"auto"`        | Scroll cut titles on hover: `"auto"` follows OpenCode's `animations`, or `"on"` or `"off"` |
| `untestedHosts`           | `false`         | Take over the session list on OpenCode versions newer than the tested one                  |
| `autoArchiveDays`         | Unset (off)     | Auto-archive Done sessions after this many days, from `0` to `365`                         |
| `cleanup.deletedSessions` | `false`         | Delete worktrees of deleted sessions                                                       |
| `cleanup.merged`          | `false`         | Delete merged worktrees                                                                    |
| `cleanup.inactiveDays`    | Unset (off)     | Delete worktrees inactive for this many days, from `1` to `365`                            |
| `cleanup.doneDays`        | Unset (off)     | Delete worktrees this many days after their sessions became Done, from `0` to `365`        |
| `cleanup.unchanged`       | `false`         | Delete worktrees with no commits beyond the default branch                                 |
| `colors.<state>`          | GitHub's colors | State color as `"#rrggbb"`, or `{ "dark": "#rrggbb", "light": "#rrggbb" }` per theme mode  |

The options accept any number of days. The settings dialog steps through its own list, and a value from the options moves to the nearest listed value in the direction you press.

The states for `colors` are `open`, `draft`, `merged` and `closed` for pull requests, and `open`, `completed` and `not_planned` for issues. The defaults are GitHub's colors for the theme mode:

| State         | Dark      | Light     |
| ------------- | --------- | --------- |
| `open`        | `#3fb950` | `#1a7f37` |
| `draft`       | `#9198a1` | `#59636e` |
| `merged`      | `#ab7df8` | `#8250df` |
| `closed`      | `#f85149` | `#d1242f` |
| `completed`   | `#ab7df8` | `#8250df` |
| `not_planned` | `#9198a1` | `#59636e` |

GitHub covers github.com, `*.ghe.com` and hosts with a `github` label, such as `github.example.com`. GitLab covers gitlab.com, hosts with a `gitlab` label and the hosts in `gitlab.hosts`. Log in to a self-managed host with `gh auth login --hostname` or `glab auth login --hostname`.

The plugin asks `gh` and `glab` only about github.com, gitlab.com, the hosts in `gitlab.hosts` and the hosts of the git remotes in your sessions' directories, so a link in a prompt or a reply cannot send your login to a host you do not work with. A pull request or issue on any other host is still linked, but shows no state, which keeps its session out of Done. `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` reach `gh` only for calls to a host other than github.com.

## Data locations

| Data                                                                       | Location                                                                                           |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Linked and unlinked refs, your Done mark, whether the history was read     | Session metadata, under the `super-sessions` key                                                   |
| Message search index                                                       | `$XDG_DATA_HOME/opencode/plugins/opencode-super-sessions/search.db` (default `~/.local/share/...`) |
| TUI settings, pins, the `ctrl+a` choice                                    | OpenCode's plugin storage for the TUI                                                              |
| Server settings, the cleanup confirmation, sessions kept from auto-archive | OpenCode's plugin storage for the server plugin                                                    |
| Pull request and issue state                                               | Daemon memory only                                                                                 |

The plugin reads OpenCode's `cli.json` (for `animations` and the session view settings) and, once, the built-in list's pins in `$XDG_STATE_HOME/opencode/session.json`. It never writes either file.

If a session's `super-sessions` value cannot be read, for example because a newer version of the plugin wrote it, the plugin leaves the value as it is and does not change that session's links. The daemon log names the session.

## Compatibility

The plugin is tested with OpenCode 2.2.5, and any 2.2 patch release counts as tested. It relies on parts of the TUI that are not a documented plugin API, so on a newer minor or major release it stays out of the way: `/sessions`, `<leader>l` and the quick switch keys keep OpenCode's built-in behavior, the peek keys are off, and a toast says once per version that the browser opens with `/super-sessions`. Everything else works as usual. The "Use on untested OpenCode versions" setting turns the takeover back on.

If the browser fails, it closes and opens the built-in list. If the pull request and issue rows in the sidebar fail, they hide themselves and the rest of the sidebar stays.

## Limitations

- The browser loads the 200 most recently updated sessions of each list (not archived, and archived) in the scope. Search reaches older sessions, but ref matches only cover the 200 most recently updated sessions in the scope.
- Message search needs `node:sqlite` with FTS5 in the daemon. Without it the daemon log says so, and search covers titles and refs only.
- The index fills from live messages, from a background pass over older sessions and from the read of a session's whole history (see [Older sessions](#older-sessions)). The background pass only reads what follows a session's latest compaction, so text from before a compaction becomes searchable once the plugin saw it live or read that session's history. Tool output and reasoning are not indexed.
- Reading an older session's history needs a terminal: a session nobody selected, peeked, opened or scanned from the settings keeps no refs from before the plugin.
- For a `!` command, detection reads the first 1 MiB of its output, which is all OpenCode passes to plugins.
- GitLab instances served under a URL path prefix, such as `https://example.com/gitlab`, are not supported.
- GitHub Enterprise Server hosts without a `github` label in their name are not recognized.
- Squash and rebase merges are cleaned up only when the pull request's head commit is in your local repository, for example because the branch was pushed from this clone.
- Auto-archive and the first cleanup confirmation need an open terminal.
- Copying a link needs a terminal that accepts OSC 52 clipboard writes, and ctrl+click reaches the plugin only in terminals that pass it through (see [Copying links](#copying-links)).
- The check list holds the first 100 checks of a pull request; failed checks past those are not listed. The CI counts on the icons cover all of them.

## Uninstall

Remove the plugin entry and restart OpenCode. The built-in session list comes back. The `super-sessions` key stays in session metadata, where OpenCode ignores it, and the message index stays on disk; delete `$XDG_DATA_HOME/opencode/plugins/opencode-super-sessions` to remove it. Pins set in the browser are not copied back to the built-in list.

[Development and architecture](docs/README.md)

## License

[MIT](LICENSE) © [Arthur Fiorette](https://github.com/arthurfiorette)
