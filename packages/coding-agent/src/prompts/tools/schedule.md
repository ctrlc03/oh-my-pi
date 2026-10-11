Schedule prompts to run later through the omp collab companion on this computer: one-off, every N minutes, or on a cron expression. Each run starts an omp session in the folder with your prompt and nobody watching.

<instruction>
- `create` needs `prompt` and exactly one of `cron`, `every_minutes`, or `at`:
  - `cron`: five fields, `minute hour day-of-month month day-of-week` (names like `mon-fri` work), or `@hourly`/`@daily`/`@weekly`/`@monthly`. `timezone` is an IANA name (`Europe/Berlin`); without it the computer's clock is used. "Every weekday at 09:00" is `0 9 * * 1-5`. Runs closer than 5 minutes apart are refused.
  - `every_minutes`: at least 5, counted from creation.
  - `at`: ISO 8601 date-time in the future; local time unless it carries an offset.
- `catch_up`: what to do when the computer or companion was down at the time. `skip` (default) still starts a run that is under an hour late and records anything later as missed; `run-once` starts one run when the companion is back, however late and however many runs were missed.
- `cwd` defaults to this session's folder. `max_cost_usd` stops each run once it has spent that much. `resume_current` continues this session instead of a new one, which only works after it has ended.
- Write `prompt` so it stands alone: the run has none of this conversation. Say what to do and what to report.
- Creating a schedule always asks the user first and shows the cron in words and the next three run times. A refusal means the user does not want it; do not retry with another wording.
- `list` shows every schedule, including ones made in the app. `delete` removes only schedules an agent made.
- If the companion is not running the tool says so; tell the user rather than working around it.
</instruction>

<examples>
```
schedule(action: "create", title: "Weekday tests", cron: "0 9 * * 1-5", prompt: "Run the test suite and report failures with likely causes. Do not change code.")
schedule(action: "create", every_minutes: 30, catch_up: "run-once", prompt: "Check CI on the current branch and summarize new failures.")
schedule(action: "create", at: "2026-10-12T08:00:00+02:00", prompt: "Resume the migration and finish the remaining tables.")
schedule(action: "list")
schedule(action: "delete", id: "…")
```
</examples>

<critical>
- A schedule spends money and acts with no one reviewing: create only what the user asked for, with the narrowest prompt that does the job.
</critical>
