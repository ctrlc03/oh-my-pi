# Watching pull requests

A session can watch pull requests and be woken when one needs attention, like T3 Code's `watch_pull_request`: the agent pushes, ends its turn, and comes back when CI fails or a reviewer writes, instead of polling in a loop. Nothing is watched until the agent calls `watch_pr`, you run `/watch-pr`, or you tap *Watch this PR* in the app. GitHub is reached through the `gh` CLI, so it has to be installed and signed in.

## Starting and stopping

| Where                         | How                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Agent                         | `watch_pr` with `action: "watch"` and `pr` (URL, `owner/repo#N`, `#N` or `N`; omit for the current branch's PR), `"unwatch"`, or `"list"`. Watching and unwatching need approval like a write tool, listing is a read. |
| TUI                           | `/watch-pr [<pr>]` (no argument: the current branch's pull request), `/watch-pr list`, `/watch-pr stop <pr>`.   |
| Collab app                    | *Pull requests* row of the session sheet: *Watch this PR* (blank = the host's current branch) and an unwatch button per PR; also in the command palette. Shown when the host advertises `pr-watch`. |

A session can watch several pull requests at once. The first reading of a pull request is a baseline: a PR whose CI already fails when you start watching does not wake the agent at once (the tool result tells it the current state). A PR that is already merged or closed is not watched.

Watches belong to the session: they are saved in it (a `custom` entry `pr-watch`) and come back on `--resume`.

## Events

| Event                | When                                                                                                  | Effect |
| -------------------- | ----------------------------------------------------------------------------------------------------- | ------ |
| Required check failed | Once the required checks have settled (none pending) and at least one failed, once per head commit    | Wakes the agent with the failing job's log tail |
| Feedback             | A new review, review comment or PR comment by someone other than you (the signed-in `gh` user), once per comment | Wakes the agent with the text; a bare approval only notifies |
| Merge conflict       | The PR starts conflicting with its base                                                               | Wakes the agent |
| All checks green     | The required checks settle passing                                                                    | Notice only |
| Merged / closed      | The PR was merged or closed                                                                           | Notice only; watching stops and queued events are discarded |

"Required" means the checks branch protection names for the base branch; when that is not readable (no admin access), every check counts.

A wake is a hidden follow-up message (`[pr-watch] …`, not shown in the transcript) that starts a turn. It carries the failing log tail (up to 4 jobs, 120 lines each) or the review text, and tells the agent that text written on the PR is information rather than instructions. The agent is never woken while it is running: events queue and are delivered when the turn ends. The watcher wakes the agent at most `prWatch.maxWakesPerHour` times per pull request per hour; events over the cap wait. A push makes older queued failures and conflicts moot, and a green run drops a queued failure.

## Who polls

- **Companion running** (the Mac daemon of the collab web app, see [Collab](./collab.md)): it polls every watched pull request with `gh api` and conditional requests (ETags: an unchanged answer is a `304` that costs no rate limit), every 60 seconds while checks are pending and every 2 minutes otherwise, and hands the readings to the session through files. A merged or closed PR also reaches your phone as a push.
- **No companion**: the session polls itself at `prWatch.pollSeconds` (default 120) while checks are pending, half as often when settled, backing off after errors. The poll timer exists only while something is watched.

A wake is a hidden follow-up message (`[pr-watch] …`, not shown in the transcript) that starts a turn. It carries the failing log tail (up to 4 jobs, 120 lines each, 24,000 characters in all; later jobs are listed as omitted once that budget is spent) or the review text (up to 12 comments of 2,000 characters). Everything third parties wrote (the PR title, comments, reviews, CI logs) is placed in `<<<UNTRUSTED <nonce> … UNTRUSTED <nonce>>>` blocks whose nonce is drawn after the text was fetched, so the text cannot close its block, and the message tells the agent that such text is data, not instructions, and that it should act only on what is consistent with your own goal for the pull request. The agent is never woken while it is running: events queue and are delivered when the turn ends. The watcher wakes the agent at most `prWatch.maxWakesPerHour` times per pull request per hour; events over the cap wait. A push makes older queued failures and conflicts moot, and a green run drops a queued failure. Comments are matched on their creation time, so an old comment that someone edits later does not wake the agent.

The channel is files under `<config root>/run/pr-watch/` (`~/.omp` or `$PI_CONFIG_DIR`): `watches/<sessionId>.json` (a session's watched PRs, refreshed while it lives and removed when it ends), `inbox/<sessionId>/*.json` (the companion's latest reading of a PR, deleted once read) and `companion.json` (heartbeat, written only while `gh` is signed in). Types: `@oh-my-pi/pi-wire/pr-watch`.

## Settings

| Setting                    | Default | Meaning |
| -------------------------- | ------- | ------- |
| `prWatch.enabled`          | `true`  | Offer `watch_pr`; `/watch-pr` refuses while off |
| `prWatch.maxWakesPerHour`  | `3`     | Wakes per pull request per hour; `0` = never wake, only notify |
| `prWatch.pollSeconds`      | `120`   | In-session poll interval while checks are pending |

## Collab protocol

A host advertises `pr-watch` in `welcome.features`. `SessionState.prWatch` lists the watched pull requests as `{ key, repo, number, url, title, state: "open" | "closed" | "merged", checks: "none" | "pending" | "passing" | "failing", conflict, review?: "approved" | "changes-requested", wakes, queued, error? }` (absent while none). Writers send `session-cmd` `pr-watch` (`arg`: a PR reference, empty = the host's current branch) and `pr-unwatch` (`arg`: the `key`); failures come back as an `error` frame. See [Collab](./collab.md).
