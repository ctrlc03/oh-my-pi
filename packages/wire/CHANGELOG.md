# Changelog

## [Unreleased]

### Added

- The `permission-mode` feature (`session-cmd` `permission` with `supervised` or `full`, reported as `SessionState.permission`) and `welcome.agent` (`AgentRef`, `{ id, name }`), set by hosts that run another vendor's coding agent (protocol version unchanged).
- The `queue-edit` and `mentions` features: `SessionCommand` `queue-edit`, `queue-move` and `queue-steer` (with `session-cmd` `id`, `index`, `mentions`), `SessionState.followUpIds`, and `PromptMention` (`{ kind: "pr", number, title, url }` | `{ kind: "session", id, title }`) on `prompt.mentions`.
- The `pr-watch` feature: `session-cmd` `pr-watch` (arg: a pull request reference, empty = the host's current branch) and `pr-unwatch` (arg: a `key`), `SessionState.prWatch` (`WirePrWatch`: key, repo, number, url, title, state, checks, conflict, review, wakes, queued, error), and `@oh-my-pi/pi-wire/pr-watch`: the pull request event logic shared by omp and the companion (`diffPr`, `PrWakeQueue`, `fetchPrSnapshot` with ETag-conditional requests, `parsePrRef`) and the file channel types (`PrWatchFile`, `PrInboxEntry`, `PrCompanionBeat`) (protocol version unchanged).
- The `turn-diff` and `receipts` features: `session-cmd` `turn-diff` (arg: a prompt entry id), `session-diff` and `receipts`, answered by the targeted `turn-diff` frame (`scope`, `entryId`, `files` as `TurnDiffFile`, `spansTurns`, `omitted`, `reason`) and `receipts` frame (`SessionReceipts`: `ReceiptFile`, `ReceiptCommand`, `ReceiptApproval`, `ReceiptSubagent`) (protocol version unchanged).
- The `approval-grants` feature: a `select` `CollabUiRequestDraft` may carry `approval` (`CollabUiApproval`: `tool`, `rule?`, `guestProject`, `choices` as `{ label, kind: CollabApprovalChoiceKind }[]`) so a client can show Allow once / Always allow (session, project) / Deny / Deny always (protocol version unchanged).
- The `inspect` feature: `session-cmd` `inspect` and `preview-request`, answered by the targeted `inspect` frame (`InspectRow`: seq, entryId, at, model, ttftMs, durationMs, input, output, cacheRead, cacheWrite, cost, stopReason, error, `injected` as `InspectInjected` with `InspectInjectedKind`; `total`) and `request-preview` frame (`RequestPreview`: source `request` | `context`, model, tokens, messages, tools, text, truncated, note) (protocol version unchanged).
- The `usage-limits` feature: `usage-limits`, `resume-at-reset` and `resume-cancel` session commands, the `usage-limits` host frame (`WireLimitWindow[]`, `fetchedAt`), and `SessionState.limited` (`SessionLimited`: `kind`, `provider`, `until`, `resumeAt`) (protocol version unchanged).
- The `cache-stats` feature and `SessionState.cache` (`SessionCacheStats`: the last request's `CacheRequestStat`, session hit %, miss count, and the recent `CacheMiss` list with `CacheMissReason` causes) (protocol version unchanged).
- The `undo` feature: `undo` and `redo` session commands, `SessionState.redoTurns`, and the targeted `turn-undone` host frame (`kind`, the undone prompt's `text`/`images`, `staleText`, `files`, `skipped`, `filesUnavailable`) (protocol version unchanged).
- The `profiles` feature: `session-cmd` `profile` (arg: a profile name), `welcome.profiles` (`WireProfile`: name, description; writers only) and `SessionState.profile` (the active profile) (protocol version unchanged).
- The `context-items` feature: `session-cmd` `context-items` and `context-prune` (arg: a row id), answered by the targeted `context-items` frame (`ContextItemRow`: id, kind, label, tokens, share, prunable; `usedTokens`, `contextWindow`, and `pruned` after a prune) (protocol version unchanged).
- The `spend-cap` feature and `SessionState.spend` (`SessionSpend`: spent, cap, `capped`), present while the host's session has a spend cap (protocol version unchanged).
- `hello.resume` and `hello.zip` guest fields, `welcome.resumed`, and the `ZIP_MARKER` / `ZIP_MIN_BYTES` constants for resuming from a known entry and compressed frames (protocol version unchanged).
- `rename` session command: `session-cmd` with the new session name as `arg`.
- `CollabFeature` and `welcome.features`; `prompt.deliver: "follow-up"`; `rewind` and `unqueue` session commands; `SessionState.followUps`; the `branch` host frame for active-path changes (protocol version unchanged).
- The `commands` feature and `welcome.commands` (`CollabCommand`: name, description, argument hint): slash commands a writer may run by sending `/<name> …` as a prompt (protocol version unchanged).
- `CollabCommand.choices` (`CollabCommandChoice`: value, label, description) and `CollabCommand.switchesSession`: suggested arguments for a slash command, and a marker for the commands that replace the host's session (`/new`, `/resume`, `/fork`), which end the room (protocol version unchanged).
- `LOCAL_RELAY_LINK_PARAM`, `normalizeLocalRelayUrl`, and `ParsedCollabLink.localWsUrl`: a collab link may append `?local=<host>:<port>` naming a loopback relay that serves the same room on the host's computer; only `localhost`, `127.0.0.1`, and `[::1]` with an explicit port are accepted (protocol version unchanged).
- The `rewind-files` feature: `session-cmd` `rewind` takes `restoreFiles` to also restore the files the dropped turns changed, `rewind-preview` asks what that would change, `redo-files` undoes the last restore; the host answers with the targeted `rewind-preview` and `files-restored` frames (`RewindFilesPlan`: files reverted, removed, recreated) (protocol version unchanged).
- `@oh-my-pi/pi-wire/schedule`: the schedule types shared by the companion, the web app and omp (`Schedule`, `ScheduleWhen` with `cron` and `interval` kinds, `CatchUpPolicy`, `createdBy`), the cron parser and next-run maths with daylight-saving rules (`parseCron`, `nextRunAfter`, `nextRuns`, `parseScheduleWhen`), their wording (`describeCron`, `describeWhen`, `formatRunTime`), and the companion's local schedule channel contract (`SCHEDULE_IPC_FILE`, `ScheduleIpcRequest`, `ScheduleIpcReply`).
## [18.10.2] - 2026-10-12

### Added

- Added `TspPickerMark.icon`: an icon a picker mark draws instead of its initials when the terminal has it (`provider:<id>` names a model provider's logo)

## [18.8.8] - 2026-10-10
- The `prompt-model` feature: `prompt.model` (`provider/id`) and `prompt.thinking` run one prompt on another model and thinking level, and `WireModel.thinkingLevels` lists the levels each offered model accepts (protocol version unchanged).

### Added

- Added `TspToolProps.command` (the command line Copy command copies), `TspToolProps.preview: "children"` (the collapsed body stays whole while its children clamp) and `TspCodeProps.preview`

## [18.8.0] - 2026-10-07

### Changed

- Updated `TspEditorProps.placeholder` and `TspInputProps.placeholder` to accept `TspText`, enabling styled placeholder text.

## [18.5.1] - 2026-10-03

### Added

- Added support for submitting explicit prompts to live editable composers without simulating keyboard input.

## [18.4.11] - 2026-10-02

### Added

- Added support for agent completion estimates in the wire protocol.

## [18.4.9] - 2026-10-01

### Added

- Added terminal scrolling support through the TSP scroll operation, allowing keyboard scrolling of the terminal scroller when supported.
- Added a terminal focus event for requesting keyboard focus on editors and inputs, or returning focus to the preferences sheet.

## [18.4.6] - 2026-10-01

### Added

- Added the `TspMeterMark` component for marking a position on a meter track with a custom icon and a total value that defines the full span of the track.

## [18.4.4] - 2026-09-29

### Added

- Added the Tern Surface Protocol wire contract (`@oh-my-pi/pi-wire`): message framing constants, the component vocabulary, document ops, frames, the handshake and terminal events that let omp render natively in terminals that speak it

## [18.2.11] - 2026-09-23

### Added

- Added public API contract and authentication schemas for the Skillshare registry.

## [18.2.5] - 2026-09-17

### Added

- Added the `omp stream` wire contract (`@oh-my-pi/pi-wire/stream`) for pane screen updates, viewer snapshots and chat, channel metadata, and `live.omp.sh` stream routes.
- Added authentication support for stencil.so streams, including user identity in welcome messages, channel ownership metadata, and explicit unauthorized and forbidden close codes.

### Changed

- Restricted channel names to the Stencil-compatible alphanumeric-and-underscore format and derived host channels from authentication tokens rather than URL path segments.

## [16.3.0] - 2026-07-02

### Breaking Changes

- Upgraded the collaboration protocol to version 3. Guests using version 2 will now be rejected during the handshake with a protocol-mismatch error.

### Added

- Added support for interactive UI request and response frames, enabling browser guests to respond to prompts initiated by the host.

## [16.1.8] - 2026-06-20

### Breaking Changes

- Bumped `COLLAB_PROTO` to `2`. The `welcome` host frame now carries metadata only (`header`, `state`, `agents`, `entryCount`, optional `readOnly`) — the transcript moves to a new `snapshot-chunk` host frame (`{ entries: SessionEntry[]; final: boolean }`) sent immediately after the welcome. Hosts split large snapshots into multiple chunks; the last chunk carries `final: true`. Old guests speaking proto v1 are rejected with the existing protocol-mismatch error. ([#3144](https://github.com/can1357/oh-my-pi/issues/3144))

## [15.12.4] - 2026-06-13

### Changed

- Changed `WireModel.contextWindow` and `ContextUsage.contextWindow` to `number | null` to allow representing unavailable context-window values

## [15.12.0] - 2026-06-12

### Added

- Added `readOnly` flags to participant and session payload types to indicate when a guest is connected via a read-only (view) link
- Added `writeToken` to `GuestFrame` hello payloads and parsed collaboration links so full-access links can carry and expose a write-capability token
- Added `ROOM_KEY_BYTES` and `WRITE_TOKEN_BYTES` constants for room key and write-token sizing in the wire protocol
- Added `DEFAULT_SHARE_URL` (`https://my.omp.sh/s`), the default share viewer/upload base for `/share` links

## [15.11.8] - 2026-06-12

### Added

- Added shared collab live-session wire contracts for the host CLI and browser guest client.
