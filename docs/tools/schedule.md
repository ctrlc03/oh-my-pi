# schedule

> Create, list, and delete scheduled omp runs on the collab companion: once, every N minutes, or on a cron expression in an IANA time zone.

## Source
- Entry: `packages/coding-agent/src/tools/schedule.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/schedule.md`
- Key collaborators:
  - `packages/coding-agent/src/schedule/settings.ts` — the `schedule.enabled` setting
  - `packages/coding-agent/src/schedule/companion-client.ts` — `companionSchedules(agentDir)`: the local authenticated client (`list`, `create`, `remove`), `CompanionUnavailableError`, `CompanionRefusedError`
  - `packages/wire/src/schedule.ts` — shared schedule types, cron parser, next-run maths (DST rules), human wording (`@oh-my-pi/pi-wire/schedule`)
  - `packages/collab-web/scripts/companion-schedule.ts` — the companion's scheduler (storage, tick, catch-up policy)
  - `packages/collab-web/scripts/companion-schedule-ipc.ts` — the loopback channel the tool talks to

## Availability
- Exposed only when `schedule.enabled` (default off) is set, and only to top-level sessions (never to subagents).
- `loadMode: "discoverable"` — mounted as `xd://schedule` when xdev is on.
- Needs the companion (`bun run companion` in `packages/collab-web`, or its LaunchAgent) running on the same computer, with the same agent directory as this omp. Without it every action fails with an explanation that scheduling needs the companion.
- Approval tiers: `list` → read, `delete` → write, `create` → exec with policy `prompt`.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `"create" \| "list" \| "delete"` | Yes | Dispatch key. |
| `prompt` | `string` | create | What each run is asked to do; it runs unattended and has none of this conversation. |
| `cron` | `string` | one of | Five fields `minute hour day-of-month month day-of-week`, names (`mon-fri`, `jan`), steps, ranges, lists, `7` for Sunday, or `@hourly`/`@daily`/`@weekly`/`@monthly`/`@yearly`. |
| `every_minutes` | `number` | one of | Repeat every N minutes, at least 5, counted from creation. |
| `at` | `string` | one of | ISO 8601 date-time in the future; local time unless it carries an offset. |
| `timezone` | `string` | No | IANA zone for `cron` (default: the computer's clock). Rejected without `cron`. |
| `catch_up` | `"skip" \| "run-once"` | No | What to do about runs missed while the computer or companion was down. Default `skip`. |
| `title` | `string` | No | Name shown in the app (default: the start of the prompt). |
| `cwd` | `string` | No | Folder to run in; relative paths resolve against this session's. Default: this session's folder. |
| `max_cost_usd` | `number` | No | Stop each run once it has spent this much (new sessions only). |
| `resume_current` | `boolean` | No | Continue this session instead of starting a new one; only works once this session has ended. |
| `id` | `string` | delete | Schedule id from `list`. |

`create` needs `prompt` and exactly one of `cron`, `every_minutes`, `at`. A cron or interval that could fire more often than every 5 minutes, an expression that never matches (`0 0 31 2 *`), an unknown zone, or an `at` in the past is refused with the reason before the user is asked.

## Approval
Creating a schedule always prompts, in every approval mode including `yolo`, and a user `allow` policy for the tool is ignored (a `deny` still wins). The prompt shows the cron in words, the cron and zone, the next three run times in that zone, the folder, whether it continues this session, the catch-up policy, the per-run spend limit, and the prompt text.

## Catch-up policy
A schedule fires when its next slot is reached. If the companion finds a slot already in the past (computer asleep, companion stopped):

- `skip` — a slot less than an hour late still runs; an older one is recorded as skipped ("missed") and the schedule moves on to its next slot.
- `run-once` — one run starts now however late the slot was, however many slots were missed; the run records when it was due and the app shows "caught up".

## Time zones and DST
Cron is evaluated in the schedule's zone. A time inside the spring-forward gap (`30 2 * * *` on the night the clock jumps 02:00→03:00) runs at the first valid moment after the gap. A time inside the repeated fall-back hour runs once, at its first occurrence, unless the hour field begins with `*` (such as `*/2` or `*`), which runs in both passes.

## Outputs
- `create`: the schedule line (id, title, human form, next run, `made by an agent`), the next three run times, and how to delete it.
- `list`: one line per schedule, including ones made in the app.
- `delete`: `Deleted schedule <id>.` Only schedules an agent made can be deleted; others ("made in the app; delete it there") are refused.
- `details`: `{ action, schedule?, meta? }`.

## Channel
The companion publishes `{ port, token, pid }` in `collab-companion-ipc.json` in its agent directory (mode `0600`) and listens on `127.0.0.1:<port>`; the tool sends `POST /schedule` with `Authorization: Bearer <token>` and a JSON body `{ op: "list" | "create" | "delete", … }`. Requests with an `Origin` header and bodies over 256 KB are refused. A file whose `pid` is gone is treated as "no companion". Agent-created schedules are forced `enabled` and `createdBy: "agent"`, and cannot replace an existing schedule.
