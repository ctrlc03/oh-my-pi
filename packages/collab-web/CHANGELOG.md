# Changelog

## [Unreleased]

### Added

- Added *Select text* to a block's long-press sheet: it opens the block's text, rendered as Markdown with *Copy all*, in a sheet where the system's own selection handles can pick part of a sentence, which the transcript's long press never allowed.
- Added a getting-started guide for colleagues who have never used omp (`docs/collab-getting-started.md`: requirements, the install line, pairing a computer's browser and a phone, a first session, other vendors' agents, updating, uninstalling, troubleshooting and the trust model), linked from *Install for colleagues* and `docs/collab.md`, and made the installer's closing output say what to do next (open the app, pair a phone, where the logs are, update, uninstall).
- Added *End sessions when they settle* to the auto-settle settings (companions advertising `canEndOnSettle`; default off). With it on, a session the companion started is ended (its `omp-<id>` tmux session is killed) once it has settled and is idle — *Settle* from any device, a bulk settle, the idle rule or the pull-request rule; a session that settles while working or asking is ended when it goes idle, and un-settling first cancels it — so settled sessions no longer keep an omp process running. Sessions started by hand in a terminal are never touched; other vendors' agents end the same way and keep their index row. The row stays under *Settled* marked *ended* (listed from the session history, the 200 most recently active sessions), and opening it or *Move back to active* resumes it like *Resume* in *All sessions*. The companion records waiting sessions in the `ending` list of `collab-companion-sessionorg.json`, so a restart ends nothing twice and turning the option on ends no session that is already settled; the worktree cleanup command runs after the end. `settings.endOnSettle` is an optional boolean, so an app or companion without it keeps the other copy's value when documents merge. The mock companion plays it.
- Added the companion inside the standalone omp binary. `scripts/build-collab-binary.ts --target <darwin-arm64|darwin-x64|linux-x64|linux-arm64>` compiles `scripts/omp-collab.ts`, which runs `omp companion [flags]` (the flags of `bun scripts/companion.ts`, plus `--help`), the internal `omp __collab-foreign-host …` (the foreign agent host, started in tmux by the companion), and regular omp for everything else. Compiled, the companion needs no checkout and no bun: the service definition runs `[<omp>, "companion"]`, `ompBin` defaults to the binary itself, the adapters' `package.json` and `bun.lock` are embedded and written at install time, `bun install` uses the binary with `BUN_BE_BUN=1` (set for that step only), the Claude and Codex adapters run through the internal `omp __collab-adapter <script>` (so neither the adapter, the vendor CLI nor the commands an agent runs inherit `BUN_BE_BUN`), the Codex adapter is pointed at its bundled native `codex` through `CODEX_PATH`, and `scripts/build-identity.ts` tells the modes apart (`bun scripts/companion.ts` and its `bun host-main.ts` hosts work as before). Foreign hosts no longer require `foreign/host-main.ts` to exist next to the companion (`ForeignLaunch` carries `host`, the command before the flags). `OMP_NATIVE_X64_VARIANT=modern|baseline` makes the host natives build produce a chosen x64 variant.
- Added the companion on Linux. `--install` writes a systemd user unit (`~/.config/systemd/user/omp-collab-companion.service`: `Restart=always`, journald logging, `KillMode=process` so tmux sessions survive a restart, `OMP_BIN`/`PATH`/`PI_CONFIG_DIR` as quoted `Environment=` lines), enables and (re)starts it, and prints `loginctl enable-linger $USER` when lingering is off; `--uninstall` removes it. Without `systemctl --user` and a running user manager (WSL without systemd, containers) it writes nothing and prints how to run the companion by hand. The platform dispatch lives in `scripts/companion-service.ts` (launchd and systemd backends in `companion-launchd.ts` and `companion-systemd.ts`); the app's *Restart companion* uses `systemctl --user restart --no-block`, and the diagnostics `managed` field can now be `systemd`. Keep-awake runs `systemd-inhibit` (`sleep:idle`, then `idle` when polkit refuses a sleep inhibitor to a service outside a login session), the power state is read from `/sys/class/power_supply` (no battery: none), and Chrome and tmux are also looked up at their usual Linux paths. The restart-refused text names systemd on Linux, and the awake warning now says why the hold failed. A companion run by launchd or systemd no longer issues or prints a pairing invite at start (the journal and the macOS log are readable beyond the user): it prints `omp companion --pair` as the way to pair, while `--install` and `--pair` in a terminal still print the link. The launchd plist is unchanged.
- Added a one-line installer for colleagues on macOS and Linux: `curl -fsSL https://<owner>.github.io/<repo>/install.sh | sh` (`scripts/install-collab.sh`, published at the Pages root by the `collab-web pages` workflow) downloads the fork's `omp` binary and `SHA256SUMS.txt` from the latest GitHub Release and installs nothing when the checksum is missing or differs, installs `~/.local/bin/omp` (`--prefix`, `PI_INSTALL_DIR`; an `omp` it did not install is replaced only after a yes, one elsewhere on `PATH` is named), offers to install tmux and git, sets `collab.webUrl`, runs `omp login` on the terminal when no provider is usable, installs the companion as a launchd or systemd user service, and opens the pairing link while printing its QR code. Questions are read from `/dev/tty`; `--yes`, `--no-login`, `--no-service`, `--no-open`, `--pair`, `--tag`, `--base-url`, `--service-dry-run` and `--uninstall` cover unattended use, a re-run updates in place, and `scripts/install-collab.test.ts` runs it against a local fake release. The README's "Install for colleagues" section covers what is installed where, uninstalling, that sessions use each colleague's own provider logins, and that a paired device controls the computer.
- Added the `collab release` workflow (`.github/workflows/collab-release.yml`, fork only): a tag `collab-v<version>-<n>` (`<version>` is the coding-agent package version) builds the fork's pi-natives addons and the `omp` binaries for darwin-arm64, darwin-x64, linux-x64 and linux-arm64 on GitHub-hosted runners (macOS 14, macOS 15 Intel, Ubuntu 22.04 x64 and arm64), signs the macOS ones with `scripts/ci-macos-sign.sh` (ad hoc without Apple secrets), smoke-runs each on its own OS, and publishes a GitHub Release with the binaries and `SHA256SUMS.txt`.
- Hardened the colleague installer and its release pipeline: downloads are https-only (`curl --proto '=https' --tlsv1.2`, `wget --https-only`; `--base-url` must be https, and plain http needs `--insecure-base-url`, which exists for tests), the binary's build attestation is verified with `gh attestation verify --signer-workflow` when `gh` is installed and signed in (otherwise the installer says it checked the checksum only), and `collab release` signs provenance in a separate job that alone holds the attestation permission, marks a release `latest` only for the highest `collab-v*` tag, refuses to replace an existing release unless dispatched with `replace`, and pins every action to a commit. `collab-web pages` keeps the Pages token in its deploy job only and installs with the repo's frozen lockfile.
- Added running other vendors' coding agents beside omp sessions on companions advertising `canForeign` (the host entry `scripts/foreign/host-main.ts` ships with the checkout and tmux is installed). The companion answers `agents` (what is installed or needs signing in), `agent-install`, `agent-custom-save` and `agent-custom-delete` (a custom agent is an argument list, never a shell string); `start` takes `agent`, `model` and `permission` and runs the session in a detached host process in tmux, as it does for omp, with the same worktree, scratch folder, prompt hand-off and per-folder start lock; resuming an agent session uses its index row (agent and folder). Hosts, the sessions list, recent folders, message search, the inbox and push carry `agent`, ended agent sessions can be resumed from the sessions list and folders, a model comparison can mix omp models with agents' (`agent:<id>/<model>` selectors), the spend limits become hard `--max-cost` caps on agent sessions (a used-up limit refuses the start), and agent spend counts in the usage report and the spend alerts. `scripts/mock-companion.ts` fakes agents in every state with live and ended sessions, and `scripts/mock-host.ts --agent <id>` presents an agent's session with the permission mode and approvals.
- Changed how the companion treats other vendors' agents for now: they run unsandboxed (in Supervised or Full access), so a `start` with `agent` and `sandboxed`, a resume of one with it, and a model comparison that mixes agents with *Sandboxed* are refused with a clear message (the comparison before any member starts); agents no longer advertise `canSandbox`. A host running an agent whose session index entry is missing or unreadable (a broken file; a file that does not exist yet is fine) is held back like a sandboxed one — file, git and run actions are refused — until its entry can be read.
- Added the foreign agent host (`scripts/foreign/host-main.ts`), a detached process per session that drives Claude Code, Codex, Cursor, Grok, OpenCode or a custom ACP command and hosts a collab room for it, next to omp sessions. It turns the agent's streamed text, tool calls (shell, edits as diffs, reads, searches), plans (as a todo card), forms (as an ask card) and spend into the same transcript and cards an omp room shows, asks the guest to approve each tool call (*Approve once*, *Approve for this session*, *Deny*) or approves everything in full access (`permission-mode`; every decision is recorded), supports follow-ups, abort, model and thinking switches, one-off prompt models, slash commands, a spend cap, rewind (the agent starts a fresh session with a digest of what is left), per-turn diffs and file restore in git repositories, restarts a crashed agent from its stored session, and resumes by session id. It keeps its own transcript (`<config>/agent/collab-foreign/sessions/`), an index the companion reads, and publishes to the local host registry with the agent's name. Cursor's extension methods are handled: `cursor/ask_question` as an ask card with one prompt per question, `cursor/create_plan` as the plan text, a todo card and an approve or reject prompt (full access approves), `cursor/update_todos` as the todo card, and `cursor/task` and `cursor/generate_image` as notices; any other extension request is answered "method not found" with a notice. `--worktree` marks the session's worktree in the index, and `--fanout` records the session's fan-out group there (the companion groups sessions by instance id, as for omp).
- Changed the foreign agent host's approvals to omp's grant rules and closed several ways round them. *Approve for this session* now follows omp: a shell grant never covers a compound or shell-controlled line (`&&`, `;`, `|`, `$(…)`), an edit or write grant names one resolved path inside the working folder, only reads inside the folder are granted whole, and fetch, web search and unknown tools are approved one call at a time. A request to leave the vendor's own sandbox or to reach more than the call needs (Codex `sandbox_permissions` / `with_escalated_permissions`, `additional_permissions`, a network-access approval, Claude Code's `dangerouslyDisableSandbox`) is labelled *Leaves the sandbox* and never covered by a rule. Other vendors' agents run unsandboxed for now (the sandbox applies to omp sessions only; a start for an agent with a sandbox is refused, and the host has no `--sandbox` flag or index `sandboxed` field). *Supervised* is reported only after the vendor confirms its ask-first mode (a refused switch keeps full access and says so; at start-up or after a rewind the agent is not used). The session index lock records its owner (pid and token) and is broken only for a dead owner, a damaged index is moved aside, `readForeignIndexStrict` tells a missing file from a broken one, and a host puts its whole row back when an update finds it gone.
- Changed the mock host to share the room connection code (`scripts/foreign/room-host.ts`: reconnect, the local relay, snapshots and delta resume) with the foreign agent host.
- Added drag-and-drop arranging to the sessions sidebar, like T3 Code's thread list. On desktop drag a row into *Pinned* at the spot you drop it (pin), a pinned row into *Active* (unpin), any row onto the *Settled* heading (settle), a settled row into *Active* (un-settle) or a snoozed row out of *Snoozed* (wake); the dragged row shows the action it will perform (Pin, Unpin, Settle, Un-settle, Wake), the section under the pointer takes the accent colour, the other rows slide aside, the list scrolls at its edges, and Escape cancels. *Active* has a user order of its own (new sessions appear above arranged ones; settling clears the position, pinning and snoozing keep it), also available as *Move up* / *Move down* in the row menu. On touch the row menu's *Arrange sessions* shows a drag handle on each row (drag within and between *Pinned* and *Active*, onto the *Settled* divider, or out of *Snoozed* and an opened *Settled*; each drop saves, *Done* leaves) and *Select…* (also Shift/⌘-click on desktop) picks several sessions to pin, snooze, settle or wake together. On desktop press a row's Settle, Un-settle or Wake button and drag up or down to apply it to every row in between. Every drag and bulk action shows one *Undo* that restores all affected sessions, and ⌘Z / Ctrl+Z triggers it while no text field is focused. A row's menu has *Auto-settle: on/off*: off keeps the session out of the idle and pull-request rules (manual settle and snooze still work). The active order and the opt-out are two optional fields of the synced organisation document (`rank`, `autoSettle`; companions advertising `canOrderSessions` keep them, with an older companion they stay on this device and the two features are hidden for its sessions).
- Added a cleanup command that runs when a worktree session settles (companions whose `git-settings` answer carries `settleCleanup`): *When a worktree session settles, run* in the worktree settings (empty = off), for example `rm -rf node_modules target`, with `OMP_WORKTREE_PATH`, `OMP_WORKTREE_BRANCH` and `OMP_REPO_ROOT` set. It runs once per transition into settled — *Settle* from any device, the idle rule or the pull-request rule; repeated syncs and companion restarts do not run it again, un-settling then settling does — and only in a worktree the companion created, never in the main checkout or a plain or scratch folder, for sessions the companion started or resumed (or that are open now). It runs even while a dev server is still running there, never delays the settle, and stops after 5 minutes. Nothing runs in a worktree a sandboxed session was ever started in or above, or that an open sandboxed session works in (its agent cannot run code, but can write what a cleanup would run): the result shows *Skipped*. A repository's own `.omp/worktree-settle` runs instead once you approve its current content (same *Approve this script* card and content-hash approval as `.omp/worktree-setup`). The latest result per worktree (done, failed with its exit code, timed out or skipped, with the end of the output) shows under *Latest cleanup per worktree*.
- Changed the first message of a started session (a scheduled run or a start with a prompt) to wait for omp in `<omp config dir>/run/collab-companion/` (mode `0700`) instead of the shared temp folder, and every sandbox profile now denies reading and writing that folder, so a sandboxed session cannot replace the prompt of a later start.
- Added *Start and new* to *Start session* (⌘Enter, Ctrl+Enter off macOS; a button on touch; companions advertising `canBackgroundStart`): it starts the session without leaving the sheet, shows what started with an *Open* link, and opens a fresh draft in the same folder, sandbox and worktree choice (a worktree gets its own branch and checkout per start; the first prompt goes to omp at launch, so the session works without being opened). The companion starts sessions in one folder one at a time, so simultaneous starts are told apart.
- Added sessions without a project (companions advertising `canScratch`): *No project* in the folder picker starts omp in a fresh folder, `<omp config dir>/scratch/<YYYY-MM-DD>-<first words of the prompt>-<id>` (`session` without a prompt), that the companion never deletes (only a folder whose start failed and is still empty goes). Sandboxed mode works there (the folder is the sandbox's project folder), the worktree and *Compare models* choices are hidden, and it is refused when the omp config folder lies inside a git checkout. Lists show such a folder as "Scratch · convert pngs" instead of its path.
- Added an app-wide tooltip layer (`components/shell/Tooltip.tsx`, pure helpers in `lib/tooltip.ts`): every control, in Sheets and overlays too, says what it does on mouse hover (after a short delay, instantly while moving between controls), on keyboard focus, and on a touch press-and-hold (the press does not also trigger the action). It shows the element's `data-tip`, else its `title` (taken over so the browser's own tooltip never doubles up), else the `aria-label` of an icon-only control, plus a keycap chip from `data-shortcut` / `aria-keyshortcuts` (the header's sessions and find buttons and the stash button show their remappable shortcuts). Header chips, the context gauge and the avatars use `data-tip`, so they get one on touch too. Icon-button names are now sentence case throughout.
- Added diagrams: ` ```mermaid ` and ` ```excalidraw ` fences in replies are drawn in the transcript (theme-aware, strict Mermaid, falling back to the code on a parse error) and open in a full-screen viewer with pan/zoom, copy source and SVG/PNG download. *Edit* opens an Excalidraw canvas (Mermaid converted to shapes) whose *Send to agent* attaches a PNG and the compacted scene; a Sketch button next to attach (and a palette entry) opens a blank canvas. `.excalidraw` / `.mmd` / `.mermaid` files open in the canvas wherever file paths open (save through the companion for writers, download otherwise), and the code map Focus and Flow graphs have *Open in canvas*. Mermaid and Excalidraw are lazy chunks outside the entry bundle; Excalidraw's fonts ship in `dist/excalidraw-assets/` (`scripts/build-assets.ts`) and the service worker caches the chunks on first use. The mock host's last reply has a Mermaid and an Excalidraw block.
- Added message box improvements (T3 Code composer): queued *After this turn* follow-ups can be edited in place, moved earlier or later and sent into the running turn (hosts advertising `queue-edit`); `#` lists the session's open pull requests and `@` other sessions to mention (hosts advertising `mentions`); ⌘S / Ctrl+S and a *Stash* button set drafts aside and take them back (`stashDraft` shortcut, per-device list of 20); ↑ / ↓ in an empty box recall earlier prompts of the session like a shell; text pasted over 32 KiB becomes a `pasted-text.txt` attachment; *Session* → *Enter* chooses whether Enter steers (default) or queues while the agent works. The mock host supports every one of them and the mock companion lists canned pull requests and sessions for `#` / `@`.
- Added a command palette (⌘K / Ctrl+K, or ⋯ → *Search* on a phone) that fuzzy-finds app actions, slash commands, sessions (live, idle, recent and past) and messages (this session's, and every session's on companions advertising `canSearch`), with recent picks first, `>` `/` `@` `#` scope prefixes and chips, and full keyboard navigation. Features add entries through `usePaletteEntries` in `src/lib/palette.ts`. `scripts/mock-companion.ts` now answers `sessions` and `session-search` with canned data (`scripts/mock-search.ts`).
- Added remappable shortcuts: click a shortcut's keys in the `?` sheet and press the new ones. Overrides live in `localStorage` (`omp.collab.keybindings`), shared keys are flagged, keys the browser keeps are refused, each override has a reset and *Reset all* restores the defaults. Esc stays fixed.
- Changed the sessions sidebar shortcut from ⌘K / Ctrl+K to ⌘\ / Ctrl+\ (`sidebar`), since ⌘K now opens the palette (`palette`); a remap in the new sheet changes either.
- Added *Pull requests* to the session sheet (hosts advertising `pr-watch`): the session's watched pull requests with chips for state, checks, merge conflict, review, queued events and wakes, an unwatch button per pull request, and *Watch this PR* (blank = the current branch), plus a command palette entry. The companion polls watched pull requests with ETag-conditional `gh api` requests and hands the readings to the session (`scripts/companion-prwake.ts`), and pushes when one merges or closes. The mock host plays a pull request whose CI fails, passes, gets a comment and merges.
- Added *Changes* on every turn (prompt row, long-press block sheet and the action row after a finished turn; hosts advertising `turn-diff`, writers only): one sheet with *This turn* (stepping through turns), *Session* and *Receipts* tabs. Files show status and +/− counts and expand to a diff with line comments that go to the message box, a viewed check per file (remembered per session and turn), and a unified/split toggle on wide screens. *Receipts* lists files changed, commands run with exit codes, approvals (granted or denied, by whom) and subagents, each linking to its turn. ⌘K lists the latest turn, the session and the receipts. The mock host serves turn diffs and receipts.
- Added *Compare models* (best-of-N) on companions advertising `canFanout`: tick it in *Start session*, or use the compare pill in the message box, to run one prompt on 2–4 models at once, each in its own git worktree with its own `--model` and an even share of an optional total budget (`--max-cost`). The sessions are grouped in the sessions list, and a compare sheet shows each run's status, spend, files changed (+/−), uncommitted state and test/verify result, with *Keep this one*: the winner opens on its branch review for the pull request, and the other worktrees can be removed (never ones with uncommitted changes unless discarding is ticked too). `bun scripts/mock-companion.ts` fakes a computer to try it.
- Added "Always allow" to the tool-approval ask on hosts advertising `approval-grants`: Allow once, Deny, Always allow (this session), Always allow (this project) and Deny always (this project) as buttons. A guest's project-scoped choices stay disabled while the host does not let guests save project rules (`collab.guestsCanSaveApprovals`). The mock host offers the prompt when a writer sends `approve [command]` (`MOCK_GUESTS_SAVE_APPROVALS=1` honors guest project choices).
- Added session organisation to the sessions sidebar: *Pinned*, *Working*, *Active*, *Snoozed* and a folded *Settled* section, with pin (drag to reorder on desktop), snooze (hours to next week, or until the usage limit resets) and settle from each row's ⋯ menu, right-click or a long press on a phone, an *Undo* toast, and optional auto-settle after 3–30 idle days or when the session's pull request merges or closes (both off by default). It syncs across devices through the paired computer (`session-org` frames, last writer wins per session, companions advertising `sessionOrgRev`) and falls back to the browser's storage without one. `bun run scripts/mock-companion.ts` fakes a computer to try it.
- Added a *Timeline* view (session sheet row and ⌘K entry, writers only, hosts advertising `inspect`): every model request of the session, newest first, with a timing bar split into waiting for the first token and streaming, tokens in and out, cache share, cost and stop reason, each expanding to what entered the context since the request before (system prompt, tool results, todo and verify reminders, hooks, memory, compaction); a header totals requests, cost, tokens, median time to first token and cache share, and *Preview next request* shows the provider request the next turn would send, with a copy button. The mock host fakes both.
- Added subscription limits on hosts advertising `usage-limits`: *Usage* gains a *Limits* section with a bar per provider account window and its reset as a clock time and countdown, and a session that hit its usage limit (or runs on the wrap-up or slow lane) shows a bar above the message box, "Limited on anthropic until 14:30 · in 2h 05m", with *Resume at reset* (the host sends `continue` after the reset; *Cancel resume* once armed), *Snooze until reset* (the session list's snooze) and *Switch model*, which opens the windows and the model list. The mock host fakes the windows and a limited session: `bun run mock-host --limited [seconds]`.
- Added generated commit messages and pull request text to the git flow (companions advertising `canGitFlow`): *Commit*, *Create PR* and *Commit, push & open PR* open their confirm with a message, title and description written by a cheap headless `omp -p` run from the diff, the session title and the repository's recent commit subjects, editable, with *Regenerate* and the draft toggle; when the model call fails the confirm shows a template and why (`git-message`).
- Added worktree settings to *All sessions* (companions advertising `canGitFlow`): branch-name prefix (default `omp/`), worktree folder, a setup script run once in each new worktree, the text model, and an opt-in cleanup of worktrees whose pull request merged or that went unused for N days; never a worktree with uncommitted changes or a running session, and the branch stays (`git-settings`). A repository's own `.omp/worktree-setup` runs only after you approve that exact script in these settings (per repository, bound to its content hash, never for sandboxed sessions); until then new worktrees run only the setup script setting.
- Added a cache strip above the message box on hosts advertising `cache-stats`: the last request's cache hit %, tokens/s, time to first token, in/out tokens and cost, with the cause when it missed the prompt cache (model, system prompt, tools, compaction, thinking level, idle expiry). On a phone it collapses to the hit % and cost; tapping opens the full numbers, the session hit rate, and the recent misses. The mock host simulates it.
- Added a profile pill after the thinking pill in the composer (hosts advertising `profiles`, writers only) that lists the host's profiles and switches the session to the picked one. The mock host supports it.
- Added *Undo* and *Redo* of the last turn (conversation and files) to the session sheet, and a *Redo* bar after an undo, on hosts advertising `undo`: undo puts the removed prompt back in the message box, redo drops it again if untouched. The mock host supports both.
- Added a "Fills context" row to the session sheet (hosts advertising `context-items`, writers only) listing the largest items filling the host's context with their share, and a prune button per prunable row.
- Added a spend-cap banner shown while the host's session sits at its cap (hosts advertising `spend-cap`), and an optional per-run spend limit on new schedules that the companion passes to omp as `--max-cost`
- Made the web client an installable app: a service worker precaches the build for instant and offline launches, and the manifest and every emitted URL are relative, so the build also works under a path prefix such as a GitHub Pages project site
- Added recent sessions to the connect screen: a home-screen launch reopens the last session, or lists rooms joined before for one-tap rejoin. Rooms the relay reports gone are dropped
- Added *Paste link* and *Scan QR* to the connect screen, plus Android share-sheet intake (`share_target`)
- Added image attachments to the composer: photo library, camera, or pasted screenshots, downscaled on the device before sending
- Added editable one-tap quick replies above the empty composer
- Kept unsent composer text per room across reloads and app restarts
- Added the collab companion (`bun run companion`): pair the app with a computer once, then pick any session hosting `/collab` on it from the connect screen, with live working / needs-input state
- Added a chat view, chosen per device from the session sheet (default on phones): prompts and replies only, each run of tool calls folded into one expandable line, and one live status line while the agent works
- Added *Keep* to the session sheet: show only the last 1, 3, or 10 turns of a session on this device, with *Show all* to reveal the rest. The session and its transcript are untouched
- Added *After turn* (Alt+Enter) to the composer while the agent works: the prompt runs as its own turn once the current one ends instead of steering it. Queued follow-ups show as chips that can be taken back (needs the omp hosting the session to include this change)
- Added *Edit & resend* on prompts: rewinds the conversation to just before the prompt and puts it back into the message box; the later turns stay in the session file as a branch (needs the omp hosting the session to include this change)
- Added *Also restore the files* to *Edit & resend* and an *Undo restore* bar: the rewind can put the host's working tree back as it was before the prompt (with a preview of how many files change), and the restore can be undone until the agent changes files again (needs an omp that advertises `rewind-files`, i.e. hosting a session in a git repository)
- Added a task bar above the composer showing the agent's todo progress and current task and how many subagents are working, with the full plan and every subagent of the current run (to do, working, done, failed) on tap
- Added *Copy reply* and *Share* under each finished turn, and ⋯ → *Export* to share, download or copy the session as Markdown
- Added file attachments: text files are pasted into the prompt as fenced blocks; PDFs and other files up to 10 MB are uploaded to the computer through the companion and the prompt names their path
- Added line comments on the working tree and branch diffs, sent to the agent as one review prompt
- Added GitHub alerts through the companion: pushes when checks finish on your open pull requests or someone reviews or comments on them, with per-kind toggles under *Usage*
- Added find in session over prompts and replies, a jump-to-latest button, and copy buttons on code blocks
- Added a *Changes* sheet listing every file the agent changed through its edit tools, with diffs
- Added a sessions sidebar for switching sessions: docked beside the transcript on wide screens (open state remembered), a slide-over drawer on tablets and phones. It lists every session on the paired computer with working / needs-input state, sessions not sharing yet, and recent rooms, with Start session, Usage and All sessions at the bottom. A banner also appears when another session on the paired computer starts waiting for input
- Added Web Push notifications through the companion when a session needs input or finishes a turn, sent with the companion's own VAPID key (no extra server). The text is the pending question or the start of the reply, read from the session file
- Added `--install`, `--uninstall`, and `--pair` to the companion: run it as a macOS LaunchAgent that starts at login and restarts on exit, and pair devices while it runs
- Added a *Working tree* tab to the *Changes* sheet through the companion: branch, ahead/behind, changed files with diffs against HEAD (including shell edits), and recent commits
- Added a read-only file viewer: file paths in tool cards open the file through the companion, confined to the session's repository
- Added *Start session* through the companion: start or resume omp in a recent folder inside a detached tmux session, shared with control access
- Added *Not sharing* sessions to the companion lists, with a *Share* button that makes a running session host `/collab` (needs `omp collab start`)
- Added model, thinking-level, and compaction controls to the session sheet for full links to hosts that accept guest session commands
- Added session cost and token usage to the session sheet
- Added a *New since you left* divider and jump pill when rejoining a room
- Added an offline prompt queue: prompts sent while disconnected are kept per room and sent once the session is live again
- Added desktop keyboard shortcuts: ⌘K / Ctrl+K toggle the sessions sidebar, `/` find, Esc close or stop the running turn
- Added sandboxed sessions to *Start session* (macOS): omp runs under `sandbox-exec` with only file read, search, and edit tools. Writes are confined to the chosen folder (except `.git`, `.omp`, `.claude`, `.vscode`, `.envrc`, `.mcp.json`), credential stores are unreadable, and nothing can run commands. Sandboxed sessions carry a badge in the session lists, header, and session sheet
- Added a git flow to the companion: *New git worktree* in *Start session* (a new branch from HEAD in `~/.omp/worktrees/<repo>/<branch>`), a *Branch* tab in *Changes* that reviews the branch against its base (`origin/HEAD`, else main/master) with commits and per-file diffs from the merge-base, and confirm-first *Commit*, *Push*, *Create PR*, and one-tap *Commit, push & open PR* actions through `git` and `gh`. Writes are refused while the agent is working or on the base branch
- Added a *Usage* screen through the companion: cost, tokens (with cache), requests, and cache hit rate across every omp session on the computer for 24h / 7d / 30d / 90d / all time, a cost-or-tokens bar chart, and the top models and projects by spend. Read from omp's stats database (`@oh-my-pi/omp-stats`), synced at most once a minute
- Added a *Code map* through the companion: navigate the session's repository by folder, file, and symbol, with what uses each and what it uses, cross-language links (Solidity events, Rust decoders, Noir circuits), multi-step flows, search, a force-directed folder map on wider screens, and *View source* at the symbol's line
- Added syntax highlighting to the file viewer (highlight.js, loaded on first open; Solidity, Rust, TypeScript, Go, Python, Noir via the Rust grammar, and common config formats). Files over 256 KB stay plain
- The companion keeps the Mac awake while it runs (`caffeinate -i -s`), so sessions stay reachable when you are away. The app warns on the computer card and in the sessions sidebar while the Mac is on battery, and notifications go out when it is unplugged, runs low (20%), and is plugged in again
- Reconnecting to a session resumes from the last entry the app holds instead of downloading the whole transcript again, and larger frames are compressed toward devices that support it (needs the omp hosting the session to include this change)
- The companion lists sessions in-process from omp's collab registry (about 1 ms of CPU per poll instead of spawning `omp collab list`, about 320 ms), falling back to the CLI
- Per-device pairing: one-time pairing codes (10 minutes), a Devices screen to rename or remove devices and add new ones by QR; a removed device is signed out and its notifications stop. Devices paired earlier must pair again
- Diagnostics screen: versions, uptime, keep-awake and power, session listing method and time, round trip, and recent connection events; restart the companion (LaunchAgent) and update omp from the phone
- Inbox across sessions with the pending question or the last reply, answerable from the list
- Start a session with a first prompt; saved prompts are offered in the start sheet and editable in place
- Spend alerts: daily and per-session limits, pushed once when crossed
- Read-only live terminal view of the tmux pane a session runs in
- Path links in tool cards open the code map on that file, and the code map's file view lists the sessions that changed it
- The code map's code loads on first open instead of with the app
- The installed app now picks up new deploys: launches load the page network-first (cached copy offline or after 3 s), precaching bypasses the HTTP cache, and a foregrounded app compares its bundle with the deployed one and offers a reload. Diagnostics shows the running app build
- Screens gallery: every screenshot and image the session's tools produced, newest first, with a full-screen viewer
- Live preview: phone, tablet, or desktop screenshots (optionally full page) of the session's local dev server, taken by Chrome on the computer and refreshed after the agent edits files
- Voice input: a mic button in the composer; the companion transcribes on the computer with omp's local speech model and the text lands in the draft
- Starting a session in a folder macOS keeps the LaunchAgent out of (`~/Documents` and the like until bun is allowed under Files and Folders) says so instead of "folder does not exist"; start and resume errors show at the top of the sheet instead of below the session list
- Transcripts are saved on the device: reopening the app shows the session at once and fetches only what is new instead of the whole session
- Added *All sessions* through the companion: past and live sessions across projects, grouped by folder with spend, searchable, with *Open*, *Share*, or *Resume* on each row
- Resuming a session that is open in another omp on the computer (for example a Terminal omp that predates collab hosting) now warns first, naming where it runs, instead of starting a second copy that writes to the same session file; *Resume anyway* overrides. A session that already hosts opens that host
- Made the host list and opening a session faster: the companion gathers a `hosts` reply's inputs concurrently (a cold first reply halves, about 600 ms to 300 ms), and opening or sharing a session asks omp's registry in-process instead of spawning `omp collab link` (about 315 ms to 1 ms)
- Rename the session from the session sheet (pencil next to its name); hosts that predate it answer with an error
- Added model and thinking-level pills to the composer toolbar, each opening a picker above it (a bottom sheet on phones), so switching models no longer needs the session sheet
- Added *GitHub* (⋯ → *GitHub*) through the companion: the session repository's open issues and pull requests, read with the computer's signed-in `gh`, filtered to open, mine, or (pull requests) review requested, with labels, checks, and review state. Opening one shows its description, every check, and the latest comments; *Send to agent* puts a prompt about it into the message box to edit and send
- Added an *Editor* through the companion (header button, or ⋯ → *Editor*): the session repository's files in a tree with *Go to file*, tabs, and a CodeMirror editor that saves in place. A save is refused when the file changed on disk since it was read, with reload or keep-mine choices; agent edits reload clean tabs live with the changed lines marked; go to definition through the code map; send the selected lines to the message box. Tool-card paths, the working tree and the code map open files there. View-only links and sandboxed sessions stay read-only. Restart the companion to enable it
- Added slash commands to the message box: `/` lists the host's skills, prompt templates, `/plan`, `/retry`, and your saved prompts, and sending one runs it on the host with you as the author; other host commands are refused (needs the omp hosting the session to include this change)
- Added the session slash commands `/model`, `/effort`, `/compact`, `/rename`, and (on hosts with `collab.autoStart: control`) `/new`, `/resume` and `/fork` to the message box: typing a command and a space lists its arguments, the host's models, the model's thinking levels, or the recent sessions of the host's folder. `/new`, `/resume` and `/fork` replace the session, and the app follows the new room through the paired computer, so they are listed only with one (needs the omp hosting the session to include this change)
- Added split view on wide screens: open a second session beside the current one, both live, and dock the editor next to the transcript
- Added hands-free voice mode: replies are read aloud, then the mic listens again, stops on silence, and sends what you said after a short countdown you can cancel
- Added an app icon badge counting sessions that wait for input, and *Reply* on needs-input and finished-turn notifications (Android and desktop Chrome)
- Added *Fix it* for pull requests with failing checks, from the GitHub sheet or the *Checks failed* notification: the failing logs go into a prompt for a session on that repository, ready to send
- Added a *Files* tab to pull requests in the GitHub sheet: per-file diffs with line comments, sent to the agent or submitted as a GitHub review (comment, approve, request changes), and a confirm-first *Merge…* pinned to the head commit you reviewed
- Added *Run* (⋯ → *Run*) through the companion: run the repository's package scripts, Makefile targets, `just` recipes, or `cargo test`/`cargo build` on the computer after a confirm that shows the script body, with live output, Stop, and *Send output to agent*
- Added downloads through the companion: save a file from the session's repository to the device from the editor, file viewer, working tree, or screens viewer
- Added *Schedules* through the companion: run a prompt once or daily on chosen weekdays in a new or resumed session, respecting the daily spend limit, with a notification when it starts
- Added message search to *All sessions*: find a prompt or reply across every session and open the session at that message
- Added the local relay: the companion runs a loopback relay (`ws://127.0.0.1:7467`, `--no-local-relay` to skip) next to omp, and the app on that computer connects to it first for sessions whose link carries `?local=`, falling back to the public relay at once (and not retrying for a minute) when it is unreachable. Phones always use the public relay, and Safari, which blocks `ws://` from an `https` page, falls back to it too. `mock-host --local-relay` exercises it offline
- Added a per-message model pill to the composer: pick a model, and a thinking level it accepts, for the next message only while the session keeps its own, shown accented until sent and carried through the offline queue. Replies from a model other than the session's carry an *answered by* note (needs the omp hosting the session to include this change)
- Added transcript blocks: each prompt, reply and tool run is a selectable block with a sticky tool header (command, ✓/✕ exit code, duration) and hover or long-press actions to copy the command, output or both as Markdown, quote it into the message box, or share it; ⌘↑/⌘↓ and Shift select blocks and ⌘C copies them, phones get a *Select* mode, swipe and double-tap on blocks, edge swipes for the sidebar and agents rail, and swipe-down to hide the keyboard; added keyboard shortcuts for focusing the message box, jumping to the latest message, copying the last reply, editing the last prompt, switching sessions, the session sheet and chat view, with a `?` help sheet
- Added cron and interval schedules to *Schedules* (companions advertising `canScheduleCron`): a cron expression in an IANA time zone or a repeat every N minutes, with the cron in words and the next three run times shown while editing, and a catch-up policy per schedule (skip a missed run, or run once when the computer is back). Schedules an agent created through omp's `schedule` tool are marked *made by agent*. The companion publishes a local authenticated channel (`collab-companion-ipc.json`) for that tool.

### Changed

- Reworked the phone layout: a compact two-line header whose title opens a session sheet (connection, model, context, participants, theme, leave), an edge-to-edge transcript, 40–44px touch targets, and a full-screen agent drawer whose header wraps instead of truncating the agent name
- Stopped the agents rail from opening on its own on narrow screens, where it covered the transcript
- Folded parked and aborted subagents under *Inactive* in the agents rail, closed by default; the header badge and opening the rail on wide screens count only running and idle subagents. *Clear* hides the inactive ones on this device (per session, until *Show*); a cleared subagent that comes back to life shows again
- The header and window title follow the session's live name instead of the name it had when you joined
- Wrapped code blocks, tool output, and diffs on phones instead of scrolling them sideways, and let wide Markdown tables scroll as one block
- Made the return key insert a newline on touch keyboards; the send button submits
- Restyled the client around a warm plum palette, in dark and light: a conversation panel with a lit edge and accent glow, a centred reading column with larger type, prompts as tinted bubbles on the right under the sender's name (the agent's prose runs without a label), a glass composer with the field above a toolbar and a round send button (one row on phones), pill quick replies, and solid pink lead buttons
- Polished the app chrome: the header shows model and thinking chips only to read-only guests (everyone else has them in the message box), keeps the context meter down to 760px, gives its icons clear sentence-case labels (the system theme icon is now a sun-moon, not a computer) and sizes its controls to 44px on touch screens, with the top bar growing to match; the "Reconnecting…" banner appears on phones only (the status chip says it elsewhere); the agents rail puts each agent's age beside its activity; focus rings follow the control's shape; scrollbars are visible; the light theme's muted and faint text and its green, amber and red status colors, and dark faint text, now meet 4.5:1 on every surface
- The model picker has a filter once it lists more than 12 models (name, id or provider; every word must match, and a model containing the text ranks above a looser letter-order match). Enter picks the first match, the arrow keys move through the rows, and Esc clears the filter before it closes the picker. Provider headings stay in view while scrolling and show how many models each has, the current model's provider comes first, and the picker opens scrolled to the current model

### Fixed

- Live output under a running tool shows its newest 10 lines and stays pinned to the latest one. Before, it showed the start of the last 2 KB, often mid-line, so a download or install progress meter (one line per redraw) hid the current line and jumped on every update
- Progress bars and other long unbroken runs in displayed custom messages (such as a background job's result) wrap inside the transcript instead of running off its right edge
- The sessions sidebar's footer keeps every button inside the drawer on tablets: *Start session* takes its own row above the usage, sessions, inbox, diagnostics and devices buttons, which no longer run past the drawer's right edge
- Scrolling up through a long session no longer races to the top and loops. Safari keeps no scroll position when earlier messages load above the view, and the app's own correction anchored on the sticky *N new* pill (which never moves) or on a folded tool run that remounts as it absorbs the earlier calls, so the view stayed near the top and loaded more on every scroll. And when the latest window was barely taller than the screen, the corrected position counted as "back at the bottom", which trimmed the earlier messages again and reloaded them, over and over. The correction now anchors on an entry row that stays mounted, ignores its own scroll adjustments, and only a scroll upward (not the view following new messages, or clamping when the screen grows) loads earlier messages
- A session no longer ends when the host is slow to answer: a connection the host does not welcome, or a snapshot that stops arriving, within 30 s is dropped and retried instead of showing *Session ended* (common when a phone returns from the background)
- With a paired computer, a session follows its omp process to a new room instead of ending: when the host switches sessions, upgrades the room to control, or relaunches its room after losing the relay (a laptop that slept), the app asks the companion for the current link and rejoins, carrying the unsent draft and queued prompts. This also applies on a cold launch of the home-screen app. *Session ended* shows only once the computer no longer lists the process or still reports the ended room after 10 s
- Fixed the transcript losing its bottom position when the on-screen keyboard opens or the composer grows
- Fixed the composer floating above the keyboard by the home-indicator inset, and the connection banner sliding under the status bar in standalone mode
- Fixed slow reconnects after the phone wakes: returning to the foreground or coming back online now retries immediately instead of waiting out a backoff of up to 30 seconds
- Fixed the app staying on a dead connection after a long stay in the background: iOS can suspend the page and leave its sockets open but dead, so on phones and tablets, after 10 s or more hidden (or on any device when the network returns), the session and companion connections are replaced at once, with a delta resume, instead of waiting out the 30 s timers. A short glance away leaves them alone

## [18.8.0] - 2026-10-07

### Changed

- Improved streaming transcript performance by reducing unnecessary guest updates and Markdown re-rendering, including faster rendering for transcripts with many unclosed LaTeX delimiters.
- Stopped tracking finished or no-longer-listed subagents, reducing unnecessary polling and memory usage in the agent drawer.

## [18.4.10] - 2026-10-02

### Fixed

- Fixed long transcript paragraphs slowing Markdown rendering: a 44 KB paragraph with no blank line now parses in about 3 ms instead of 100 ms ([#13961](https://github.com/can1357/oh-my-pi/pull/13961) by [@sjawhar](https://github.com/sjawhar)).
- Fixed transcript paragraphs with many unclosed `$`, `\(` or `\[`, slowing Markdown rendering for seconds ([#13961](https://github.com/can1357/oh-my-pi/pull/13961) by [@sjawhar](https://github.com/sjawhar)).

## [18.4.1] - 2026-09-28

### Fixed

- Prevented iOS Safari from zooming collab text fields on focus in wide touch viewports, including landscape orientation ([#13371](https://github.com/can1357/oh-my-pi/pull/13371) by [@andersennl](https://github.com/andersennl)).

## [18.4.0] - 2026-09-28

### Changed

- Redesigned the web client: black chassis with one inset session panel, glass top bar with the omp mark and a live status pill, a docked composer card, prompts shown as cards in the transcript, a sectioned agents rail, and a floating agent drawer; the connect screen was rebuilt too

## [18.3.1] - 2026-09-25

### Fixed

- Improved large-session browsing and reconnect behavior: recent transcript entries load quickly, earlier entries can be loaded on demand without losing your place, and the existing transcript remains visible with download progress during reconnects.

## [18.3.0] - 2026-09-24

### Added

- Added support for rendering coordinated job and messaging views through the `wait` tool.

### Removed

- Removed the obsolete `hub` tool renderer.

## [18.2.1] - 2026-09-15

### Fixed

- Browser collab guests now automatically rejoin when a transient host network drop recreates the relay room ([#11858](https://github.com/can1357/oh-my-pi/issues/11858)).

## [18.1.17] - 2026-09-10

### Fixed

- Transcript links are now allowed by the scheme the browser will actually resolve, so a destination that only becomes `javascript:` after URL normalization is dropped like any other unsafe scheme ([#11562](https://github.com/can1357/oh-my-pi/pull/11562) by [@alphastorm](https://github.com/alphastorm)).

## [18.1.3] - 2026-09-02

### Fixed

- The guest transcript now returns to the latest message after an initial connection or reconnect.

## [18.0.8] - 2026-08-27

### Added

- Transcript Markdown now renders LaTeX: `$…$` and `\(…\)` inline, `$$…$$` and `\[…\]` in display mode, plus own-line `$$`/`\[` blocks. Currency ("$5 and $10"), escaped dollars, and code spans stay literal, and half-streamed delimiters stay visible until the equation closes.
- Note: parity with the TUI covers these delimited forms only. Bare `\begin{…}…\end{…}` environments without `$$`/`\[` fences remain literal here (the TUI typesets them); web support is a follow-up.

## [17.3.8] - 2026-08-19

### Fixed

- The ask tool card now renders the note the user attached to their answer; previously it was dropped from HTML exports and the collab guest view.

## [17.2.10] - 2026-08-06

### Changed

- Updated the Markdown parsing implementation to use @oh-my-pi/pi-utils.

## [17.2.2] - 2026-07-31

### Fixed

- Fixed an issue where the guest UI could incorrectly appear idle (such as the loading spinner disappearing) while the host agent was still running after a reconnection, and ensured tool cards are properly cleared if a connection drop occurs.

## [17.2.0] - 2026-07-30

### Fixed

- Fixed an issue where the agent would stop silently without a message by ensuring terminal auto-retry failures are properly surfaced as error notices.

## [17.1.0] - 2026-07-24

### Fixed

- Fixed action metadata loss on xd://resolve, xd://reject, and xd://propose cards to ensure correct action badges are rendered.
- Added proper rendering support for reject, propose, and hub-family aliases (irc, job, await, poll, cancel_job) to prevent them from falling back to generic JSON.

## [17.0.8] - 2026-07-22

### Fixed

- Fixed an issue where IME composition (Korean, Japanese, and Chinese) duplicated the last character when pressing Enter to commit in the composer.

## [17.0.1] - 2026-07-16

### Fixed

- Rendered user and host transcript messages as Markdown and separated adjacent assistant content blocks. ([#5559](https://github.com/can1357/oh-my-pi/issues/5559))

## [17.0.0] - 2026-07-15

### Changed

- Consolidated the legacy irc and job tool renderers into a unified hub renderer for messaging, background jobs, and process supervision, while preserving existing visual styles.
- Enhanced rendering for xd:// device dispatches to resolve through their inner tool's renderer, preserving generated-image thumbnails and MCP/autoresearch presentations under a unified xd://<tool> card label.

### Removed

- Removed custom visualization for the search_tool_bm25 tool, which now falls back to generic rendering.

## [16.5.1] - 2026-07-14

### Fixed

- Fixed an issue in the live collaboration transcript where duplicate tool cards and a stale "thinking..." shimmer were rendered while a committed tool call was running.

## [16.3.7] - 2026-07-05

### Fixed

- Fixed an issue where the workspace advertised a stale package version (15.11.7) instead of the current release version.

## [16.3.3] - 2026-07-02

### Fixed

- Improved input detection for the edit tool's summary and body views.

## [16.3.1] - 2026-07-02

### Changed

- Updated the glob, grep, and ast_grep tool cards to read the new single `path` argument, falling back to the legacy `paths` array so historical transcripts still render their search scope.

## [16.3.0] - 2026-07-02

### Fixed

- Fixed missing response controls for "ask" questions in the mobile collaboration web UI.
- Fixed an issue where re-sending an editor "ask" request would clear a guest's in-progress draft response.
- Fixed infinite retry loops in the agent transcript drawer by ensuring terminal errors are displayed and polling stops.
- Fixed a delay in displaying pre-welcome connection errors (such as protocol version rejections), allowing the session to terminate immediately with the host's error reason.

## [16.2.0] - 2026-06-27

### Added

- Added dedicated renderers for glob, grep, and legacy find and search tools to improve the readability of search and file discovery results.

## [16.1.23] - 2026-06-26

### Fixed

- Hid advisory wrapper tags in collab transcript Markdown while preserving their content. ([#3559](https://github.com/can1357/oh-my-pi/issues/3559))

## [16.1.16] - 2026-06-23

### Added

- Added support for Ruby and Julia code cells in the eval tool

### Changed

- Updated the eval tool view to render the new single-cell eval args (flat `language`/`code`/`title`/`timeout`/`reset`) and to highlight Ruby (`rb`) and Julia (`jl`) cells with their own syntax instead of collapsing them to Python, while still parsing legacy multi-cell `cells` arrays and framed `input` strings from older transcripts.

### Fixed

- Improved compatibility with legacy todo task transcripts

## [16.1.8] - 2026-06-20

### Breaking Changes

- Bumped `COLLAB_PROTO` to `2`: the `welcome` frame now carries metadata only (header/state/agents/`entryCount`) and the transcript follows in a train of targeted `snapshot-chunk` frames terminated by `final: true`. Old guests speaking proto v1 are rejected with the existing protocol-mismatch error.

### Changed

- Restyled the collab shell with the stats dashboard theme tokens and added the persisted system/light/dark theme toggle.

### Fixed

- Fixed the guest hanging in the "waiting" phase on large host sessions: the client now accumulates `snapshot-chunk` frames into the transcript snapshot and only transitions to `live` after the final chunk lands (or immediately when the host's snapshot is empty). ([#3144](https://github.com/can1357/oh-my-pi/issues/3144))

## [16.0.10] - 2026-06-18

### Added

- Added support for collab browser wrapper links whose web UI host differs from the relay host, so the connect screen joins the relay encoded in the URL fragment.

## [16.0.5] - 2026-06-17

### Fixed

- Preserved assistant soft line breaks and Markdown paragraph/list indentation in the collab web transcript renderer so tree-shaped prose no longer collapses into one paragraph.
- Changed collab web transcript wrapping to keep Korean/CJK words intact before falling back to emergency breaks for long URLs or identifiers.

## [16.0.3] - 2026-06-16

### Removed

- Removed rendering support for the `render_mermaid` tool from the web tool registry

## [15.13.3] - 2026-06-15

### Fixed

- Wrapped composer button labels to display icon-only on mobile devices for a more compact and readable layout
- Made the connect screen, ended session card, and notification toasts fully responsive for smaller device viewports
- Fixed mobile layout issues where the entire chat flow would overflow horizontally and text was rendered too large on iOS Safari (by setting `text-size-adjust: 100%`)
- Made transcript rows stack vertically on small screens to optimize reading space, and prevented grid track expansion
- Hid non-essential metadata (such as the model name, thinking level, and working directory path) and context gauge tracks on mobile headers to prevent overflow

## [15.13.1] - 2026-06-15

### Added

- Added `16px` font-size overrides for all text inputs and textareas on mobile viewports to prevent iOS Safari from automatically zooming in the page on focus
- Added top and bottom safe-area padding (`env(safe-area-inset-*)`) to the header bar, connection card, and composer to prevent them from being covered by notches/home indicators
- Added translucent click-outside-to-close backdrops for the mobile side rail and agent details drawer to match native mobile chat applications
- Disabled vertical bounce reload gesture (`overscroll-behavior-y: none`) on the page body to prevent accidental pull-to-refresh page reloads during scrolling
- Applied global touch responsiveness updates (`touch-action: manipulation` and tap-highlight removals) to links and buttons to improve mobile responsiveness

### Fixed

- Fixed mobile layout issues where the entire chat flow would overflow horizontally and text was rendered too large on iOS Safari (by setting `text-size-adjust: 100%`)
- Pinned the app shell grid to a single `minmax(0, 1fr)` column so a long session title can no longer set a min-content floor that pushes the header, transcript, and composer wider than narrow or in-app mobile viewports; the title now ellipsizes instead of clipping every row's right edge
- Made transcript rows stack vertically on small screens to optimize reading space, and prevented grid track expansion
- Hid non-essential metadata (such as the model name, thinking level, and working directory path) and context gauge tracks on mobile headers to prevent overflow
- Wrapped composer button labels to display icon-only on mobile devices for a more compact and readable layout
- Made the connect screen, ended session card, and notification toasts fully responsive for smaller device viewports
- Fixed mobile layout issues where the entire chat flow would overflow horizontally and text was rendered too large on iOS Safari (by setting `text-size-adjust: 100%`)
- Made transcript rows stack vertically on small screens to optimize reading space, and prevented grid track expansion
- Hid non-essential metadata (such as the model name, thinking level, and working directory path) and context gauge tracks on mobile headers to prevent overflow
- Wrapped composer button labels to display icon-only on mobile devices for a more compact and readable layout
- Made the connect screen, ended session card, and notification toasts fully responsive for smaller device viewports

## [15.12.4] - 2026-06-13

### Fixed

- Fixed context usage percentage calculations to return null when context window is missing or non-positive, preventing invalid or Infinity/NaN usage display

## [15.12.2] - 2026-06-12

### Fixed

- Link parsing accepts the new dot-joined room secret (`<roomId>.<key>`, `/r/<roomId>.<key>`) and leniently decodes `%23`-mangled legacy deep links (macOS Foundation percent-encodes a second `#` when terminals open clicked links), which previously failed to connect

## [15.12.0] - 2026-06-12

### Added

- Added support for optional write tokens in collaboration links so full links can embed the room key and write token (48-byte fragment) while legacy key-only (32-byte) links remain supported
- Added parsing of web deep links in the form `https://<relay>/#<room>#<key>` so links opened from a page URL hash resolve correctly
- Added a `readOnly` field to guest snapshots to indicate whether the connected guest has view-only access
- Link parsing accepts full web deep links (`https://<relay>/#<link>`) pasted into the connect screen, matching the URL `/collab` now prints
- Site metadata for the deployed client: favicon set, web app manifest, robots.txt, sitemap, JSON-LD, and Open Graph/Twitter cards with a collab-specific og-image; static assets live in `public/` and are copied into `dist/` at build
- Added `src/tool-render/`: a shared per-tool React renderer suite (one view per built-in tool — bash, read, edit diffs, todo boards, eval cells, task batches, LSP, search, browser screenshots, …) with a common chrome (`ToolView`), design tokens that adapt to the host theme, and an `<omp-tool-view>` web-component wrapper; `scripts/build-tool-views.ts` bundles it (React included) for embedding into coding-agent HTML session exports
- Task tool cards now render agent ids as drill-down links: clicking one opens the matching subagent drawer in the live client (and the embedded sub-session overlay in HTML exports) via the new `ToolRenderHost` seam

### Changed

- Changed composer input to disable prompting and show a read-only session placeholder when guests connect in view-only mode
- Changed agent drawer to hide kill/revive controls and message input for read-only guests
- Changed header bar to show a read-only session chip and label read-only participants as view-only
- Restyled the client onto the omp brand palette: deep-purple surfaces, pink accent, cyan focus ring (was warm amber); og-image re-rendered to match
- Transcript tool cards now use the per-tool renderers instead of the generic args/result JSON dump — structured summaries in the collapsed header and tool-specific bodies (commands, diffs, todo boards, result images) when expanded

## [15.11.8] - 2026-06-12

### Added

- Added deep-link auto-connection support from `#<roomId>#<key>` URLs when opening the web app
- Added subagent-focused UI with a side rail and detail drawer that surfaces each subagent’s lifecycle, running progress, and per-subagent transcript
- Added session status controls in the shell, including connection banners, toast notifications, and rejoin/new-link actions after a session ends
- Added the collab web package with the browser guest client, mock host, local relay, and relay contract tests.

### Changed

- Changed relay socket behavior to retry transient disconnections with exponential backoff while treating terminal relay-close conditions and decryption failures as non-retriable
- Changed subagent transcript decoding to handle streamed JSONL payload chunks incrementally by preserving carry-over data across chunks
- Replaced the vendored collab wire type mirror with shared `@oh-my-pi/pi-wire` protocol contracts.

### Security

- Hardened transcript Markdown rendering by escaping embedded HTML and allowing only safe link schemes
