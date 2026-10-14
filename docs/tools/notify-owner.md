# notify_owner

> Tell the owner of a Personal agent something on their own devices: an inbox item and, unless it is quiet, a push notification. The Personal agent's only way to reach the owner unprompted. Whole feature: [Personal agent](../personal-agent.md).

## Source
- Entry: `packages/coding-agent/src/tools/notify-owner.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/notify-owner.md`
- Key collaborators:
  - `packages/coding-agent/src/personal/ipc-client.ts` — `personalCompanion(agentDir)`: the local authenticated client (`notify`, `hello`, `receipt`), `PersonalCompanionUnavailableError`, `PersonalCompanionRefusedError`
  - `packages/coding-agent/src/personal/notify-book.ts` — the per-hour and open-question limits (session-local)
  - `packages/coding-agent/src/personal/runtime.ts` — `AgentSession.personal`, which supplies the limits and the origin of the turn
  - `packages/wire/src/personal-ipc.ts` — `NotifyOwnerInput`, the request and reply shapes and the length limits

## Availability
- Exposed only when `personal.enabled` is set (the Personal profile's `config.yml` sets it; default off) and only to top-level sessions, never to subagents. It is a built-in, not discoverable: a Personal agent always sees it.
- Needs the companion running on the same computer with the same profile. Without it the call fails with a message saying so.
- Approval tier: read (it never asks). It acts on the owner's own inbox, not on the machine.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `title` | `string` | Yes | One line, the notification title. |
| `body` | `string` | Yes | The message, plainly. |
| `kind` | `"info" \| "question" \| "proposal" \| "digest"` | Yes | What the item is. |
| `options` | `string[]` | No | `question` only: quick replies the owner can tap (free text is always allowed). |
| `proposal` | `{ op, section?, target?, text?, rationale, evidence? }` | `proposal` | The single About-you change proposed. `add` needs `section` and `text`, `replace` needs `target` and `text`, `remove` needs `target`; `text` and `target` are one line; `rationale` is required. |
| `digest` | `{ day, learned? }` | `digest` | The nightly review's digest: `day` is `YYYY-MM-DD`. |
| `push` | `boolean` | No | Send a push notification. Default yes, except for a digest. |

Length limits come from `@oh-my-pi/pi-wire/personal-ipc` (`MAX_NOTIFY_TITLE_CHARS`, `MAX_NOTIFY_BODY_CHARS`, `MAX_NOTIFY_OPTIONS`, `MAX_NOTIFY_OPTION_CHARS`, `MAX_PROPOSAL_TEXT_CHARS`, `MAX_DIGEST_BODY_CHARS`) and are listed in the model-facing prompt.

## Behavior
- A `digest` is refused unless the run is the nightly review (`personal.runKind: review`); `options`, `proposal` and `digest` are refused on a kind they do not belong to.
- `info` and `question` calls are limited to `personal.notifyOwner.maxPerHour` per rolling hour, and a `question` is refused while `personal.notifyOwner.maxOpenQuestions` are unanswered. Both limits are the session's own: a restarted session starts with an empty count, and the companion's inbox is the record across sessions. An owner answer (an `answer` event carrying the item id) closes its question. Proposals and digests are not counted here.
- The call carries the origin of the turn it was made in (`owner`, `external` or `guest`, or `agent` for a wake no one started) so the companion can mark an item that came out of a turn started by outside content. The agent cannot set it.
- The companion refuses what the owner already rejected (a proposal repeated) and anything it cannot store; its message is the tool's error, and nothing is recorded against the limits.
- A `question` does not wait: the answer comes back later as an owner `personal-event` and starts a turn.
- The tool is available in every turn, including ones started by outside content; it only writes to the owner's own inbox.

## Outputs
Text that names the item id and says whether it was pushed. `details`: `{ kind, itemId?, pushed? }`.

## Channel
The companion publishes `{ port, token, pid }` in `collab-companion-personal-ipc.json` in the profile's agent directory (mode `0600`, written only once the Personal profile exists) and listens on `127.0.0.1:<port>`; the tool sends `POST /personal` with `Authorization: Bearer <token>` and `{ op: "notify", sessionId, runKind, origin, item }`. A dead pid, a missing file, a refused connection or a changed token is reported as "the companion is not running". The channel is separate from the schedule channel (its own token).
