# Changelog

## [Unreleased]

### Added

- Made the web client an installable app: a service worker precaches the build for instant and offline launches, and the manifest and every emitted URL are relative, so the build also works under a path prefix such as a GitHub Pages project site
- Added recent sessions to the connect screen: a home-screen launch reopens the last session, or lists rooms joined before for one-tap rejoin. Rooms the relay reports gone are dropped
- Added *Paste link* and *Scan QR* to the connect screen, plus Android share-sheet intake (`share_target`)
- Added image attachments to the composer: photo library, camera, or pasted screenshots, downscaled on the device before sending
- Added editable one-tap quick replies above the empty composer
- Kept unsent composer text per room across reloads and app restarts
- Added the collab companion (`bun run companion`): pair the app with a computer once, then pick any session hosting `/collab` on it from the connect screen, with live working / needs-input state
- Added a chat view, chosen per device from the session sheet (default on phones): prompts and replies only, each run of tool calls folded into one expandable line, and one live status line while the agent works
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
- Added *All sessions* through the companion: past and live sessions across projects, grouped by folder with spend, searchable, with *Open*, *Share*, or *Resume* on each row

### Changed

- Reworked the phone layout: a compact two-line header whose title opens a session sheet (connection, model, context, participants, theme, leave), an edge-to-edge transcript, 40–44px touch targets, and a full-screen agent drawer whose header wraps instead of truncating the agent name
- Stopped the agents rail from opening on its own on narrow screens, where it covered the transcript. The header badge still counts subagents
- Wrapped code blocks, tool output, and diffs on phones instead of scrolling them sideways, and let wide Markdown tables scroll as one block
- Made the return key insert a newline on touch keyboards; the send button submits

### Fixed

- Fixed the transcript losing its bottom position when the on-screen keyboard opens or the composer grows
- Fixed the composer floating above the keyboard by the home-indicator inset, and the connection banner sliding under the status bar in standalone mode
- Fixed slow reconnects after the phone wakes: returning to the foreground or coming back online now retries immediately instead of waiting out a backoff of up to 30 seconds

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
