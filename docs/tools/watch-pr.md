# watch_pr

> Watch pull requests and wake the session when one needs the agent. Whole feature: [Watching pull requests](../pr-watch.md).

## Source
- Entry: `packages/coding-agent/src/tools/watch-pr.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/watch-pr.md`
- Watcher: `packages/coding-agent/src/pr-watch/manager.ts` (`AgentSession.prWatch`)
- Event logic shared with the companion: `packages/wire/src/pr-watch.ts`

## Input and availability
`{ action: "watch" | "unwatch" | "list", pr?: string }`. `pr` is a pull request URL, `owner/repo#N`, `#N` or `N` (resolved in the session's repository); omitted on `watch` it is the current branch's pull request. `unwatch` needs `pr`.

The tool is discoverable (not in the default tool list), exists only in the top-level agent (not subagents) while `prWatch.enabled` is on and `gh` is available, and is approved like a write tool for `watch` and `unwatch` and like a read for `list`. See [approval mode](../approval-mode.md).

## Behavior
- `watch` baselines the pull request and returns its state (checks, conflict, review); a pull request that is already merged or closed is not watched. The agent should end its turn after pushing: it is woken when a required check fails, someone else reviews or comments, or a conflict appears.
- `unwatch` stops one; merging or closing stops it on its own.
- `list` prints each watched pull request's state.
- Wakes arrive as a hidden `[pr-watch]` follow-up message, never while the agent is running, at most `prWatch.maxWakesPerHour` times per pull request per hour.
