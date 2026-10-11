# Collab: Live Session Sharing

`/collab` shares your running session with other omp instances in real time. Guests render the **same session natively in their own TUI** — streaming assistant text, tool-call cards, footer state (cwd, model, context %, cost), ctrl+o expansion, `/dump` — no terminal mirroring. Guests can prompt and interrupt the agent; the host machine runs the agent and all tools.

## Quick start

Host:

```
/collab
```

prints

```
Collab session started!
 • Join from another terminal: omp join "mgAYTZwEnpRQtca0CTgn-Q.gdJUbTovD94ofDaa8YvhY0-ty16w4fn8PgB6PLnoA30"
 • or any web browser: my.omp.sh/#mgAYTZwEnpRQtca0CTgn-Q.gdJUbTovD94ofDaa8YvhY0-ty16w4fn8PgB6PLnoA30
```

The browser line is click-to-join (an OSC 8 hyperlink to the full `https://` deep link): the relay serves the web guest client at `/`, and the room id + key ride in the URL fragment. From another omp (any directory, any machine), either form works:

Running `/collab` or `/collab view` starts or displays the active hosting session, rendering terminal/browser join links and a QR code for the browser URL. `/collab` requests control access: if the active room was started view-only, it replaces that room. `/collab view` reuses either access level and prints only the read-only link.

```
/join my.omp.sh/#mgAYTZwEnpRQtca0CTgn-Q.gdJU…
```

The guest's previous session is restored on `/leave` (or when the host stops).

### Commands

| Command           | Effect                                                                              |
| ----------------- | ----------------------------------------------------------------------------------- |
| `/collab`         | Start full-control sharing; reuse a control room or replace a view-only room        |
| `/collab <relay>` | Start sharing through a specific relay (`relay.example.com`, `ws://localhost:7475`) |
| `/collab view [relay]` | Start read-only sharing, or print the existing room's read-only link/QR        |
| `/collab status`  | Show link + participants                                                            |
| `/collab stop`    | Stop sharing                                                                        |
| `/collab list`    | List every active local Collab host (no links)                                      |
| `/join <link>`    | Join a shared session as a guest                                                    |
| `/leave`          | Leave (guest) or stop sharing (host)                                                |

`/collab start [relay]` is also accepted. Passing a relay while a reusable room is active does not move that room to another relay; stop it first to change the relay.


### Sharing every session automatically

Explicit `/collab stop` and `/leave` also cancel any replacement already queued by a session transition. A later, distinct session change still follows the saved auto-start policy. Guests can answer startup dialogs, but cannot prompt, interrupt, or control agents until the outer startup—including setup UI and transcript replay—has completed successfully.

Dedicated joins retain session-change observation: a failed join returns to the saved auto-start policy immediately, and `/leave` or host disconnection restores automatic hosting for the local session and its later replacements. Remote replica resynchronization never starts a local host.

An explicit `omp join <link>` launch takes precedence over auto-start: it initializes as a guest without publishing a temporary local host, and leaves the saved auto-start setting unchanged. If interactive startup fails after a host has been installed, that room is shut down and withdrawn before terminal teardown and the startup error is rethrown.

Set `collab.autoStart` to `view` or `control` and every interactive session hosts itself as it starts, through `collab.relayUrl`, without running `/collab`. The room is created before extension `session_start` hooks run — a question an extension asks at startup is retained and delivered to the first writer that joins — and the relay connection proceeds in the background, so a slow or unreachable relay never delays the prompt (a failure is shown as a dim status line). Guests can join an auto-started room and answer a startup question straight away, but — like the local composer, whose Enter is gated for the same reason — they cannot prompt, interrupt, or drive subagents until startup has finished; such a frame is refused with `… is unavailable until the host finishes starting up`. Each auto-started session publishes itself to the local host registry below; the setting's value is the highest access the registry will hand out for it (`view`: read-only links only; `control`: links that can prompt and interrupt). `/collab` still works as before: it re-prints the current room, or replaces a view-only room with a full-control one when you ask for control.

Rooms follow the session, not the process. `/new`, `/resume`, `/fork`, and branching (whoever ran them) stop the current room — guests are told goodbye and its registry entry is withdrawn — before starting a replacement under the live auto-start policy. A guest holding the old link never sees a different session; one that asked for the switch with `/new`, `/resume` or `/fork` ends up in the new session only by rejoining the replacement room (the app does this by itself through a paired computer, and drops what it had sent but the old room had not shown). During an uncommitted `/resume`, the old room instead suspends while the target session is provisionally active; rollback restores access to the original room without needing a callback. Shutdown makes the room unavailable immediately and finishes its cleanup before disposing the session. After a failed session change, `/collab` and `/join` use current-session hosting state and retire any stale owned room before proceeding; joining still refuses to replace a live host.

Explicit stop also cancels pending automatic launches without changing the saved policy. Application frames still queued or being encrypted are discarded; only the final goodbye drains. Bytes already handed to the transport cannot be recalled. A later distinct session change or manual start can host again.

A room can also end on its own: the relay closes it for good, or the host's send backlog exceeds its limit (`Collab ended: …`). Its guests must rejoin to resync, but the session keeps following the live auto-start policy: once the ended room has withdrawn, a replacement room (next generation) is hosted for the same session. An auto-started room the relay never opens — the relay is unreachable, or the connection times out — is retried the same way; no guest or registry reader ever saw it, so the retry reuses its generation and a session that recovers still publishes generation 1 first. The first replacement is immediate; if rooms keep ending, or the relay stays unavailable, within five minutes of each other, each further replacement waits twice as long (1 s, 2 s, 4 s, … up to 60 s). `/collab`, a session switch, `/collab stop`, and shutdown are not held behind that wait. With auto-start `off`, a manually started room that ends this way stays down until `/collab` is run again.

Guest ownership begins before replica activation and lasts through restoration of the previous local session. Neither joining, resynchronizing, nor a failed join may publish the replica as a local host. Leaving waits for restoration; a restoration failure is reported and keeps hosting blocked. An explicit stop during restoration suppresses its pending automatic restart without cancelling the restoration itself.

### Listing active local hosts

Suspension suppresses session data, joins, and guest actions; it does not suppress termination of an existing room-local dialog. An ended dialog carries only its request ID, so guests can dismiss it even if `/resume` later rolls back. The first authenticated answer to an existing dialog is retained while the target session is provisional and applied only if the original room resumes with the writer still authorized. Commit, stop, and local cancellation cannot apply that answer to another session. Joins during that provisional window must be retried once it settles. `/collab status` prints the room's published access level, so a view-only room never exposes its internal control link through status.

Already-admitted work is not generally undone by closing a room. In particular, subagent revival is shared with local callers and remains bound to the original agent reference and transcript; it may finish after closure, but the old guest's follow-up prompt is discarded. Closing a room does not cancel a local caller's coalesced revival.

Replacement rooms wait for the session operation to finish its hooks, transcript replacement, and any rollback before connecting. During an in-place transcript reset or tree navigation, existing guests continue receiving replication, but prompts and agent-control commands are refused until the operation settles; new joins and registry discovery are unavailable during that interval. If a previously admitted prompt is discarded before execution, its guest receives an error in a retained room. A retiring room instead sends a goodbye explaining that prompts absent from the conversation must be resubmitted after rejoining. A provisional switch must settle before deciding which notification applies.

`omp collab list` (and `/collab list` inside a TUI) enumerates every live Collab host on the local machine under the same omp configuration root — across terminals, projects, and profiles. Listing is metadata only; it never prints or transmits a link:

```
omp collab list                          # one row per host, then idle sessions; no links
omp collab list --json                   # {"version": 1, "hosts": [...], "idle": [...]}
omp collab link <instanceId|pid>         # print that host's full-control browser URL
omp collab link <instanceId|pid> --view  # print its view-only browser URL
omp collab link <instanceId> --json      # {"version": 1, "instanceId", "generation", "access", "url"}
omp collab start <instanceId|pid>        # make an idle session host (control access) and print its URL
omp collab start <instanceId|pid> --view # host with view access instead
```

Each host row carries a stable `instanceId` (random per process, kept across the rooms that process hosts), the room `generation` (increments every time the process starts a new room, e.g. on `/resume`), PID, session ID and name, working directory, model, start time, participant count, whether the relay connection is currently open, whether a host-side question is waiting for a writable guest (`inputRequired`), whether the session is running a turn (`busy`, rendered `working` or `idle`), and the highest `access` the registry will hand out (`view` or `control`). Hosts are sorted by start time, then PID, then instance ID. An empty result ("No active Collab hosts.") is a successful outcome, not an error.

`busy` is true for the whole turn — response streaming and tool execution alike — and false once the agent ends, so polling it is how a dashboard notices that a still-published session stopped working; a host that vanishes from the listing has died or become unreachable, which is a different thing. It is `null` from a host running an omp older than the field, and unknown must not be read as idle. `busy` reports a turn in flight, not scheduled work: it reads false during scheduling pauses (queued follow-ups, async-job waits, compaction) even when the session resumes on its own, so a `true`→`false` edge means the turn ended, not that the work finished.

A link is a deliberate per-host act. `omp collab link` asks the selected host for one URL, bound to the generation observed while listing: if the host has since started a new room (a session switch), the request fails with `stale_generation` instead of handing out the successor room, and you list again. A host published with `view` access refuses `control`. A PID that matches more than one live host (or none) is rejected with the candidate instance IDs; use the instance ID. The printed URL grants whatever its access says — treat a control URL like the `/collab` link itself.

Interactive sessions that are not hosting are listed too, under `idle` (`instanceId`, PID, session ID and name, cwd, model, start time, `busy`). Each interactive omp publishes an idle registry entry once startup completes and withdraws it on exit; while the process hosts, only its host row is listed, and both rows share the process's `instanceId`. `omp collab start` asks an idle session to start hosting through the same path as `/collab` and prints the link once the room is open and published. It never replaces a room: a session already hosting returns its existing link, or refuses `control` when its room is view-only. Idle entries use registry version 2, which older omp versions skip, so mixed versions keep listing hosts correctly.

How it works: each room publishes its own private IPC endpoint (a Unix domain socket on macOS/Linux, a named pipe on Windows — never a TCP port) once its relay connection succeeds; a rotation publishes under fresh artifact names, so withdrawing the old room can never disturb its successor. Full-control and view-only URLs, the room key, and the write token stay in the host process's memory; disk holds only discovery metadata (protocol version, instance ID, PID, endpoint, creation time, and a random bearer token) under `~/.omp/run/collab-hosts`. On macOS/Linux, permissions are tightened to owner-only on every publication. Windows inherits the configuration root's ACL, so that root must remain private to the user. Two authenticated operations exist over the endpoint: `snapshot` (host state, with free-form strings bounded so an unusual session title cannot make a host unlistable) and `link` (`access` + `generation` → one URL). Listing queries every live host concurrently with short independent deadlines, skips unresponsive or foreign-version entries, and prunes metadata left behind by crashed hosts; a transient socket error (`EMFILE`, `EACCES`, …) never prunes a live host. Stopped rooms disappear immediately — the registry keeps no history, lists no guests or remote hosts, and requires no relay change. Third-party dashboards and bridges can build on `omp collab list --json` plus `omp collab link` — or speak the newline-delimited JSON endpoint directly — without omp shipping a remote product of its own.

A missing registry directory means no active hosts. An unreadable or symlinked registry directory is a listing error, not a successful empty result; POSIX also rejects foreign-owned directories. Individual unreachable or malformed host entries are still omitted independently. The CLI exits nonzero for a directory error; `/collab list` displays a sanitized, bounded error and leaves the TUI usable.

## Link format

Accepted by `/join <link>` and `omp join "<link>"`:

```
<roomId>.<key>                                                    → default relay (wss://my.omp.sh)
<roomId>#<key>                                                    → legacy bare form
host[:port]/r/<roomId>.<key>                                     → custom relay, wss:// inferred
host[:port]/r/<roomId>#<key>                                     → legacy direct relay form
https://host[:port]/r/<roomId>.<key>                             → direct relay URL, normalized to wss://
wss://host[:port]/r/<roomId>.<key>                               → direct websocket relay URL
ws://localhost:7475/r/<roomId>.<key>                             → direct plain ws, localhost only
my.omp.sh/r/<roomId>.<key>?local=127.0.0.1:<port>                 → relay link plus the host computer's own loopback relay (see below)
https://host[:port]/#<link>                                      → browser deep link when web UI and relay share a host
https://web-host[:port][/<path>]/#<relay-link>                   → browser UI wrapper with relay link in the fragment
https://web.example/collab/#relay.example.com/r/<roomId>.<key>   → web UI and relay on different hosts
```

`<link>` / `<relay-link>` are parsed recursively as any accepted link above. For `http(s)` browser wrappers with a parseable fragment, the fragment wins before the HTTP host/path are treated as a relay. This lets `https://web.example/collab/#relay.example.com/r/<roomId>.<key>` open the web UI at `web.example` while joining `wss://relay.example.com/r/<roomId>`. If the fragment is not a complete collab link, parsing falls back to the legacy direct relay form, so `https://relay.example.com/r/<roomId>#<key>` still means relay `relay.example.com`.

The trailing `.<key>` or `#<key>` part is the room secret, base64url-encoded, in one of two strengths:

- **Full link** — 48 bytes: the 32-byte AES-256-GCM room key followed by a 16-byte write token. Grants prompting, interrupting, subagent control, and session controls (model, thinking level, compaction, rename).
- **View-only link** — the bare 32-byte key, no write token. Grants live read access only. Pre-token links parse as view-only.

The room secret is dot-joined in newly generated links because RFC 3986 forbids a raw `#` inside a URL fragment; parsers still accept legacy `#` forms and `%23`-mangled legacy deep links.

## End-to-end encryption

Every session payload (entries, events, state, prompts) is sealed with AES-256-GCM before it touches the socket. The relay sees only:

- room ids and connection counts,
- opaque ciphertext frames and their sizes,
- a 4-byte routing prefix (which guest a frame targets).

Possession of the link is the trust boundary: a full link reads and steers the session, a view-only link reads it. Share both like secrets.

## Guest permission model

Two trust levels, enforced by the link itself — the host verifies the 16-byte write token at join and rejects writes from peers without it (they appear as read-only in the participants list, and the join notice says so).

Guests with a full link can:

- read the entire session (including the back-transcript at join time),
- prompt the agent (rendered with their name badge on every participant's transcript; the LLM sees the prompt text verbatim — names are display-only). While a turn runs, a prompt steers it by default; `deliver: "follow-up"` instead queues it to run as its own turn once the current one ends. Writers see the queued follow-ups in `state.followUps` and can take one back with `session-cmd unqueue`. A prompt may also carry `model` (`provider/id`, one of `welcome.models`) and `thinking` (one of that model's `welcome.models[].thinkingLevels`) to run on another model for that prompt only, advertised as the `prompt-model` feature: the host refuses an unknown model or a level the model rejects with an `error` (`prompt not sent: …`), runs the run the prompt starts on the choice (a queued follow-up on its own, a steer on the running turn), and puts the session's model and thinking level back when the session settles, without a transcript entry or settings change. A `thinking` without a `model` is refused. Hosts without the feature ignore both fields.
- interrupt the agent (Esc),
- use [Agent Hub](./agent-hub.md) against the host's subagents: live table and progress, chat (steers the host's subagent), kill, revive, and transcript viewing (fetched from the host on demand).
- answer host interactive `select` and `editor` requests. The host broadcasts each pending request only to writable guests; the first submitted or cancelled response settles it and dismisses the other presentations.
- run session controls (`session-cmd`): switch the model for this session only (not saved as the default; refused while a turn runs or when the conversation exceeds the target model's context window), set the thinking level among those the current model accepts, compact with optional instructions, as the host's `/compact` does, rename the session, as the host's `/rename` does (a user-set name the automatic titler keeps), and `rewind` to just before one of the active branch's prompts, as the host's Esc Esc rewind does (refused while the agent works; the later turns stay in the session file as a branch; with `restoreFiles` it also restores the files, see [Rewinding files](#rewinding-files)). Writers receive the selectable models in `welcome.models`; hosts that predate the frame send no list, and guests hide the controls. Hosts list the newer capabilities (`follow-up`, `rewind`) in `welcome.features`; guests offer them only when listed.

Guests with a view-only link can read everything live — back-transcript, streaming text, tool cards, subagent transcripts — but the host rejects prompting, interrupting, agent control, and session controls from them.

Advisor records are not guest-visible subagents: they are excluded from roster snapshots and transcript fetches, and advisor chat/kill/revive commands are rejected.


Other session/machine commands remain host-only: `/resume`, `/branch`, bash (`!`), python (`$`), skills, etc. Typed `/model` and `/compact` stay host-only in a TUI guest; the web client's session controls are the guest route. Guests keep a small local allowlist (`/dump`, `/export`, `/copy`, `/open`, `/help`, `/hotkeys`, `/theme`, `/settings`, `/leave`, `/collab`, `/exit`, `/quit`).

When a guest joins during an assistant turn, that in-flight turn appears on the first subsequent `message_update`: the guest synthesizes the missing `message_start` from the update's full accumulating message before forwarding the delta. If the host emits no further update for that turn after the guest joins, there is no update from which to synthesize the live component. The durable entry still reaches the replica's message state, but entry frames are intentionally not rendered, so that edge case can remain absent from the live TUI.

### Rewinding files

A rewind can also put the files back. Before each prompt (the host's own, a guest's, or a queued follow-up when it starts) omp snapshots the git working tree of the session's folder into a private store under the agent dir (`<agent dir>/snapshots/<hash of the repository root>`), driven through its own git directory and index files. Your repository's `.git` is only read (`git ls-files`): HEAD, the index, refs and the stash never change. Snapshots are bound to the prompt's session entry through refs in that store, so they survive a resume; ones older than 30 days are pruned, per-session index files idle for a day are deleted, and stores of repositories that no longer exist (or unused for 30 days) are removed when another store is opened. The store keeps its own copy of the file contents rather than borrowing the repository's object database: borrowed objects could disappear if you later run `git gc --prune` or rewrite history, and a restore must not depend on that. The `rewind.snapshotFiles` setting turns it off.

A restore first snapshots the current files, then makes tracked and untracked non-ignored files match the snapshot taken before the chosen prompt: changed files are reverted, files created since are removed (only files whose creation time is after the snapshot began; one that already existed but was ignored or over the size cap then, say because a `.gitignore` rule was dropped, is left alone and counted in `skipped`; on filesystems without a creation time the change time stands in) and directories that emptied, deleted files come back, the executable bit and symlinks included. The state it replaced is kept as one undo slot: `redo-files` restores it, and refuses with a readable error if files changed since the restore (a later turn, an edit), so redo never overwrites newer work.

Guest side, for writers (read-only links get the usual `error`), on hosts whose `welcome.features` has `rewind-files` (advertised only while the session can snapshot: setting on, folder inside a git repository):

- `session-cmd` `rewind` with `restoreFiles: true` restores the files first, then moves the conversation. If the files cannot be restored (no snapshot for that prompt, a refusal) nothing moves and the guest gets an `error`; if the conversation then fails to move, the files are put back. On success the requester gets `{ t: "files-restored", kind: "restore", plan, skipped, canRedo }` and the room hears `<guest> rewound the conversation and restored N files (...)`. Without `restoreFiles` a rewind touches no files.
- `session-cmd` `rewind-preview` with the prompt's entry id answers `{ t: "rewind-preview", entryId, files }`: `files` is `{ revert, remove, recreate }` (files that would be reverted, removed, recreated) or `null` when no snapshot was recorded for that prompt. It changes nothing.
- `session-cmd` `redo-files` undoes the last restore and answers `{ t: "files-restored", kind: "redo", plan, skipped, canRedo: false }`.

Both restoring and redoing are refused while the agent, a compaction or a command is running. In the host's TUI, Esc Esc rewind of a prompt asks `Restore files too?` when files would change, and `/redo-files` undoes the last restore. The web client shows *Also restore the files* in *Edit & resend* and an *Undo restore* bar.

A prompt never waits more than 2 seconds for its snapshot (and Esc ends the wait): past that it runs without one (the restore then answers that no snapshot was recorded for it), and the snapshot finishes in the background without being bound to it. While one is still running, later prompts skip snapshotting instead of queueing another pass, and a repository that makes three prompts in a row give up is skipped for five minutes. In the TUI, the Esc Esc rewind waits at most 1.5 seconds to learn which files would change, then rewinds the conversation only. The index is kept per session and a new session starts from the newest other one, so after the first snapshot of a repository (seconds to tens of seconds for tens of thousands of files, on a large repository longer than the budget, so the first prompts may have none) a snapshot takes a fraction of a second.

Limits: git repositories only (other folders advertise nothing and snapshot nothing). A repository with more than 50,000 files (tracked, or untracked and not ignored: an untracked `node_modules` counts) or more than 512 MiB of covered files is not snapshotted, and is not tried again for five minutes. Files over 2 MiB, ignored files, files outside the repository, and non-regular files are not snapshotted and not touched. A path the snapshot does not cover that blocks a restore (for example an oversized file where a directory must come back) is skipped and counted in `skipped`. Shell side effects outside the repository (packages installed, services started, files elsewhere) are not undone, and neither is anything a command did to ignored files. Snapshots are taken at prompt boundaries, so a restore to before a prompt also reverts edits made by hand after that prompt was sent (they cannot be told apart from the agent's), while edits made before it are part of the snapshot and stay.

### Undoing the last turn

`/undo` takes back the last turn in one step: it rewinds the conversation to just before the last user (or guest) prompt, restores the files from that prompt's snapshot when one exists (the same snapshots as [Rewinding files](#rewinding-files); without one only the conversation moves), and puts the prompt text back in the editor to edit and resend. The rewind is the same branch move as `/branch`, so the undone turns stay in the session file as a branch reachable from `/tree`. Repeating `/undo` walks one prompt further back each time. `/redo` returns to the conversation tip and the file state the last `/undo` left; several undos redo in reverse order. Redo stays valid only until something new is sent (a prompt, a compaction, any move off that tip), and its files part is refused, leaving everything as it is, when the files changed since the undo. Both are refused while the agent, a compaction or a command is running.

Guest side, for writers, on hosts whose `welcome.features` has `undo` (always advertised: the conversation half works without file snapshots):

- `session-cmd` `undo` and `redo`, or the slash commands `/undo` and `/redo` (listed in `welcome.commands`, no arguments). A refusal (nothing to undo, nothing to redo, busy, files changed since the undo) answers with an `error` and changes nothing.
- The requester gets `{ t: "turn-undone", kind: "undo" | "redo", text?, images?, staleText?, files?, skipped?, filesUnavailable? }`: for an undo `text` and `images` are the removed prompt to put back in the message box; for a redo `staleText` is that draft, to clear if it is still untouched. `files` is the restore plan `{ revert, remove, recreate }` when files changed, and `filesUnavailable: true` means the host snapshots files but recorded none before that prompt. The room hears the usual `branch` frame and a notice naming the guest (`<guest> undid the last turn and restored N files (...)`, `<guest> redid the turn`).
- `state.redoTurns` is how many undone turns `redo` can bring back (absent or `0`: none), so the web client offers *Redo* only when it is positive.

The web client shows *Undo* and *Redo* in the session sheet and a *Redo* bar after an undo; both appear only when the host advertises `undo`.

### What fills the context

A writer on a host that advertises `context-items` in `welcome.features` can see what fills the host's context window and prune items (the same ranking and pruning as the host's `/context` and `/context prune`, see [Compaction](./compaction.md#pruning-chosen-items-context)):

- `session-cmd` `context-items` answers a targeted `{ t: "context-items", items, usedTokens, contextWindow }`: `items` are up to 30 rows `{ id, kind, label, tokens, share, prunable }` ranked by size (`kind` is `toolResult`, `file`, `attachment`, `systemPrompt` or `toolSchema`; `share` is a fraction of `usedTokens`, the host status line's anchored count). System prompt parts and tool schemas are listed with `prunable: false`.
- `session-cmd` `context-prune` with a row's `id` as `arg` prunes it on the host and answers the same frame, refreshed, plus `pruned: { entries, tokensFreed }`; the room hears `<guest> pruned … from the context`. A stale or fixed row, or a response, compaction, or command still running on the host, answers with an `error` and changes nothing. Guests' replicas keep the original transcript text; only the host's model context shrinks.

The web client shows a *Fills context* row in the session sheet that opens the list with a prune button per prunable row.

## Web client

`packages/collab-web` is a standalone browser client for the same links — no omp install needed on the guest side. The relay serves it at `/`, which is what makes the `/collab` deep link click-to-join: `https://<relay>/#<link>` loads the client and auto-connects from the fragment. It renders the live transcript (streaming text, thinking, tool cards), a subagent panel with on-demand transcripts, and a composer with the same guest powers (prompt, interrupt, hub actions). Run `bun run dev` in the package for a local instance, `bun run mock-host` for an offline scripted host to develop against, and `bun run build` to emit a static `dist/` deployable anywhere (HTTPS required for WebCrypto). The client never talks to anything but the relay, and the key stays in the URL fragment.

The client is also an installable app (home-screen PWA). Because a home-screen launch carries no fragment, it remembers recent rooms and the last open room in browser storage, and offers *Paste link* and *Scan QR* (the `/collab` QR code) to join without typing. Inside a session it offers a chat view (prompts and replies with tool runs folded), find in session, a per-device *keep the latest turns* trim, *after this turn* follow-ups, *edit & resend* (rewind to before a prompt), the agent's task progress, selectable prompt, reply and tool-run blocks with copy, quote-to-composer and share actions, keyboard shortcuts and touch gestures, copy/share of replies and Markdown export, text and file attachments, a list of files the agent changed, session controls and usage, a *new since you left* marker, and an offline prompt queue. The optional companion (`bun run companion` in `packages/collab-web`, installable as a macOS LaunchAgent) pairs the app with a computer once and then lists every session hosting `/collab` there, built on `omp collab list` / `omp collab link`. It also drives the in-session sessions sidebar, needs-input banners, Web Push notifications sent with its own VAPID key, keeping the Mac awake while it runs (with battery warnings and power notifications), per-device pairing and removal, an inbox across sessions, spend alerts, a diagnostics screen, a read-only terminal view, a gallery of the session's screenshots, a live preview of the session's dev server, voice input transcribed on the computer, a working-tree view, an editor (file tree, tabs, and saves refused when the file changed on disk; read-only for view-only links and sandboxed sessions), and code map (folder, file, and symbol dependencies from the codemap index) for the session's repository, starting sessions in tmux (optionally sandboxed on macOS: file tools only, writes confined to the folder by `sandbox-exec`), and sharing idle sessions through `omp collab start`. See the [collab-web README](../packages/collab-web/README.md#installed-app-pwa) for details.

The companion also drives a git flow from the app, so it can change repositories, not only read them. *Start session* can run omp in a new git worktree (`git worktree add -b <branch> ~/.omp/worktrees/<repo>/<branch> HEAD`); the *Branch* tab of *Changes* reviews the session's branch against its base (origin's default branch, else `main`/`master`) from the merge-base; and *Commit*, *Push*, *Create PR*, and *Commit, push & open PR* run `git add -A && git commit`, `git push -u origin HEAD`, and `gh pr create` on the computer after an explicit confirm that lists the exact commands. The companion refuses these while the session's agent is working, on the base branch, and on a detached HEAD, and they use only the computer's own git and `gh` credentials. Anyone holding the companion pairing link can therefore commit and push in any session's repository: treat the link like an SSH key.

With the same signed-in `gh`, *GitHub* (in the session sheet) lists the open issues and pull requests of the session's repository, filtered to open, mine, or review requested, and opens one with its description, checks, and latest comments. It only reads (`gh issue list/view`, `gh pr list/view`, `gh repo view`); *Send to agent* puts a prompt about the item into the message box and sends nothing.

*GitHub alerts* (under *Usage*) use the same `gh` to watch your open pull requests in the repositories of the companion's sessions (`gh pr list --author @me`, every 5 minutes, every 2 while checks are pending) and push to devices with notifications on when checks finish or someone else reviews or comments. Tapping the notification opens the pull request.

The same `gh` also powers pull request review from the app: a *Files* tab with per-file diffs and line comments that become an agent prompt or a GitHub review, a confirm-first merge, and *Fix it*, which collects the end of each failing check's log (`gh run view --log-failed`) into a prompt for a session on that repository. A *Checks failed* notification opens *Fix it* directly.

Beyond reading, the companion can act on the computer for you. *Run* lists the repository's package scripts, Makefile targets, `just` recipes, and `cargo test`/`cargo build`, and runs only those (no free-form commands) after a confirm that shows the script body, with live output and Stop. *Download* saves a repository file to the device. *Schedules* starts a prompt once or daily on chosen weekdays in a new or resumed session, skipping runs while the daily spend limit is crossed. *All sessions* → *Messages* searches prompts and replies across every session and opens one at the matching message. Reviewing and merging are refused for sandboxed sessions, and running in any repository a sandboxed session works in. A merge applies only to the head commit the device showed.

Guests with a full link to a host that advertises the `commands` feature can run some slash commands, listed in `welcome.commands`: skills, prompt templates and markdown commands, `/plan`, `/retry`, and the session controls `/model <provider/id>` (the session-only switch, as `/switch`), `/effort <level>`, `/compact [instructions]` and `/rename <title>`, which run the same code as the matching `session-cmd` frames, so they share its checks and refusals and name the guest in one `<guest> ran /x` notice, only when they succeeded. The bare forms that open a selector on the host (`/model`, `/effort`, `/rename`, `/resume`) are refused with a hint to give an argument. A host that runs with `collab.autoStart: control` also lists `/new`, `/resume <session>` and `/fork` (`CollabCommand.switchesSession`): the host replaces its session as the TUI does, the room ends with a `bye` (see above), and a guest follows to the successor room only if it can ask for the new link, as the web app does through a paired companion; so the web app lists them only with a companion, and a host without `control` auto-start refuses them. They are also refused while the host is answering, compacting, switching, or in plan, goal or vibe mode, `/resume` reaches only sessions of the host's folder (`CollabCommand.choices` lists the recent ones for the app's suggestions), and `/fork` is the plain whole-session fork, never the pane or window variants. `/clear`, `/shake`, `/handoff`, `/fresh`, `/branch`, `/tree`, `/delete` and every other command are refused with an error, and text that only starts with a slash stays an ordinary prompt.

A host that advertises the `profiles` feature lets writers switch the session's [agent profile](./profiles.md): `welcome.profiles` lists `{ name, description? }` (writers only), `state.profile` names the active one, and `session-cmd` `profile` with the name as `arg` switches it (queued until the turn ends while the host is busy; refused for view-only guests, for unknown names, and while the host is in plan, goal or vibe mode). A guest can only move to a profile at least as strict as the active one: a switch that loosens the approval mode, enables more tools, or widens approval, path or LSP permissions is refused with an `error` explaining why, while the host can still switch to any profile from its own TUI. The web app shows the profile as a pill next to the model pills.

The companion also reads omp's stats database (`~/.omp/stats.db`, as `omp stats` does) for two screens. *Usage* shows cost, tokens, requests, and cache hit rate across all your sessions for 24 hours to all time, as a bar chart plus the top models and projects by spend. *All sessions* lists every past and live session grouped by project, with *Open*, *Share*, or *Resume* on each. Before answering, the companion ingests new session files into the database, at most once a minute; the first request after a long gap can take a while.

Set `collab.webUrl` when the browser UI is hosted separately from the websocket relay. When empty, `/collab` derives `http(s)://host[:port]` from `collab.relayUrl`; explicit web UI URLs must use `https://` except for localhost/loopback `http://` development origins, and cannot contain a query string or fragment. The generated browser URL still carries the relay-specific collab link in the fragment.

### Local relay for the web app on the host's computer

Set `collab.localRelayUrl` to `ws://127.0.0.1:<port>` and omp serves each `/collab` room on that relay as well as on `collab.relayUrl`. The web app opened on the same computer then connects over loopback and skips the public relay's round trip; guests anywhere else keep using the public relay, and both see the same live session and can both prompt (a control link works on either). The two connections are independent: the host sends to the local relay only while a guest is on it, and a local relay that is down or killed never ends, delays, or degrades the public session. A local relay that comes up later is picked up automatically.

The local relay is carried by the link that tools on the host's computer receive — the registry entry behind `omp collab` and the companion's session list — as `?local=<host>:<port>` after the relay-explicit link (`my.omp.sh/r/<roomId>.<key>?local=127.0.0.1:7467`). Links printed by `/collab` stay public-only, so a link or QR code you share never names a loopback address. Older apps ignore the parameter; only `localhost`, `127.0.0.1`, and `[::1]` with an explicit port are honored, and anything else is dropped.

The companion starts such a relay for you at `ws://127.0.0.1:7467` (the next free port, then any free port, when that one is taken; `--no-local-relay` turns it off) and sets `collab.localRelayUrl` for the sessions it launches. For a session you start by hand, set the setting to `ws://127.0.0.1:7467` while the companion is running, or run `bun run relay --port 7467` yourself. `packages/collab-web/scripts/mock-host.ts --local-relay` exercises the whole path offline (`local off` / `local on` on its stdin stop and restart the local relay).

The app tries the local relay first only on a computer that can be the host's: touch devices (phones, tablets) always use the public relay. A local attempt that has not opened after 1.2 seconds, or that the room is not on, falls back to the public relay with no backoff, and a failed local relay is not tried again for 60 seconds, so a computer that is not the host's pays one short failed attempt a minute. The companion's relay refuses a guest for a room it does not hold before the WebSocket opens, only accepts a browser from the web app's own origin, and never lets a browser host a room. Payloads stay AES-GCM sealed end to end exactly as on the public relay.

Browser limit: the web app is served over `https://`, so the browser must allow an `https` page to open `ws://127.0.0.1`, and today that is the weak point. Measured: Chrome 150 gates the connection behind its Local Network Access check and, with no permission, fails it at once (`net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`); headless Chrome cannot show the permission prompt, and granting the permission over the DevTools protocol did not lift the block, so whether a headed Chrome that the user allows connects is untested. Firefox treats loopback as potentially trustworthy for mixed content (from vendor documentation; untested here). Safari blocks a plain `ws://` connection from an `https` page even for loopback (WebKit bug 171934; untested here). In every blocked case the local attempt fails immediately and the app uses the public relay, so nothing is lost but the shortcut. A page served from `http://127.0.0.1` (not `https`) does connect to it in Chrome 150, as tested against the mock host.

## Settings

| Setting               | Default               | Meaning                                                                                                        |
| --------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `collab.relayUrl`     | `wss://my.omp.sh`     | Relay used by `/collab` when no relay is passed inline                                                         |
| `collab.localRelayUrl` | empty                | `ws://127.0.0.1:<port>`: also serve each room on a relay on this computer, for the web app here (see above)       |
| `collab.webUrl`       | empty                 | Browser UI URL for `/collab` links; empty derives from relay; explicit `http://` is allowed only for localhost |
| `collab.displayName`  | OS username           | Name shown to other participants                                                                               |
| `collab.autoStart`    | `off`                 | `view` / `control`: host every interactive session as it starts and publish it to the local registry            |
| `share.serverUrl`     | `https://my.omp.sh/s` | Share viewer/upload base used by `/share` (links are `<base>/<id>#<key>`)                                      |
| `share.store`         | `blob`                | `/share` uploads to the blob server; `gist` uses an authenticated secret gist with blob fallback             |
| `share.redactSecrets` | `true`                | Run the secret obfuscator over `/share` snapshots before upload                                                |

## Self-hosting the relay

The production relay is not currently distributed for self-hosting: its Go source and standalone binaries are not published. The endpoint list below documents the hosted service's network contract, not an installable release.

For local protocol development, this repository includes a source-available, WebSocket-only stand-in at [`packages/collab-web/scripts/local-relay.ts`](../packages/collab-web/scripts/local-relay.ts). Run `bun run relay` from `packages/collab-web` to listen on `ws://127.0.0.1:7466`. It implements `/r/<roomId>` but does not serve the browser client, `/share` blobs, or `/healthz`, so it is not a replacement for the production service. It binds loopback only and answers only requests addressed to a loopback host name.

The relay is a small content-blind Go service. It keeps no state beyond live connections and exposes:

- `GET /` — the static collab-web guest client (target of the `/collab` deep link),
- `GET /r/<roomId>?role=host|guest` — WebSocket upgrade,
- `POST /s` / `GET /s/<id>` / `GET /s/<id>/raw` — `/share` blob upload, viewer page, and blob fetch,
- `GET /healthz` — liveness.

## Implementation files

- [`src/slash-commands/builtin-collaboration.ts`](../packages/coding-agent/src/slash-commands/builtin-collaboration.ts) — TUI commands and join-link presentation
- [`src/collab/controller.ts`](../packages/coding-agent/src/collab/controller.ts) — auto-start and room rotation
- [`src/collab/host.ts`](../packages/coding-agent/src/collab/host.ts), [`guest.ts`](../packages/coding-agent/src/collab/guest.ts) — authoritative host and local replica
- [`src/collab/protocol.ts`](../packages/coding-agent/src/collab/protocol.ts), [`crypto.ts`](../packages/coding-agent/src/collab/crypto.ts), [`relay-client.ts`](../packages/coding-agent/src/collab/relay-client.ts) — frames, links, encryption, and transport
- [`src/collab/registry.ts`](../packages/coding-agent/src/collab/registry.ts) — private local host discovery
- [`src/collab/settings.ts`](../packages/coding-agent/src/collab/settings.ts) — `collab.*` defaults
- [`packages/collab-web`](../packages/collab-web/) — browser guest and local development relay

## Architecture notes

Hub topology — the host is authoritative, guests never peer:

1. `welcome` + `snapshot-chunk` frames — initial state and transcript: the session's active branch (root to leaf), not entries on abandoned branches. The transcript is byte-bounded into chunks so each arrival resets the guest's progress timeout; oversized replicated entries are shrunk before transmission.
2. `entry` frames — durable session entries, broadcast pre-blob-externalization so images stay inline (guests cannot resolve host blob refs). Guests append them with ids preserved to a replica session file under `~/.omp/collab/<roomId>.jsonl` and into the agent's message array, which is why `/dump` and context estimates work.
3. `event` frames — live agent events, fed straight into the guest's normal event controller; rendering is events-only to prevent double-render.
4. `state` frames — debounced footer snapshots: streaming flag, the host's full model object and thinking level (applied to the guest's replica agent state, so model display and context-window math are native), host context numbers, and participants.
   While a session spend cap is set (`session.maxCostUsd` / `session.maxTokens`, `--max-cost`, `/budget`), the host advertises `welcome.features` `spend-cap` and `state.spend` carries `{costUsd, tokens, maxCostUsd?, maxTokens?, capped}`; the web client shows a banner while `capped` and refuses nothing itself (the host refuses prompts). Scheduled companion runs pass `--max-cost` when the schedule has a per-run spend limit.
5. `bus` frames — mirrored task-subagent lifecycle/progress EventBus traffic, republished on the guest's local bus so the subagent HUD and status-line count work natively.
6. `agents` frames — agent-registry snapshots feeding a guest-local registry, so the Agent Hub table renders host subagents.
7. `ui-request` / `ui-request-end` frames — host select/editor prompts presented to full-control guests and dismissed everywhere once settled. Guests answer with `ui-response`.
8. `branch` frames — the active branch changed other than by appending (a guest's `rewind`, or the host's own rewind or `/tree` navigation): guests keep their entries up to `keep`, drop the rest, and append `entries`, the remainder of the new branch.
9. `rewind-preview`, `files-restored` and `turn-undone` frames — targeted replies to the `rewind-files` commands (see [Rewinding files](#rewinding-files)) and to `undo`/`redo` (see [Undoing the last turn](#undoing-the-last-turn)).

Guest→host: `hello`, `prompt`, `abort`, `agent-cmd` (hub chat/kill/revive), `fetch-transcript` (incremental subagent-transcript reads answered by targeted `transcript` frames), `ui-response`, and `session-cmd` (model, thinking level, compaction, rename, rewind, rewind-preview, redo-files, undo, redo, unqueue). The replica loads through the regular `/resume` machinery, so theming, ctrl+o, and transcript behavior are native by construction; the guest process never chdirs to host paths.

Transcript fetches are capped at 4 MiB per reply and end on complete JSONL lines. Guests continue from `newSize`; a single entry exceeding the cap produces a terminal transcript error instead of an endless empty-read retry.
