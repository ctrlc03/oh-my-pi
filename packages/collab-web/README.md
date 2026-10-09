# @oh-my-pi/collab-web

Web client for [omp collab sessions](../../docs/collab.md). Paste a `/collab` link into the browser and you get the same live session guests see in the TUI: streaming transcript, tool-call cards, subagent panel with live transcripts, and a composer that prompts (or interrupts) the host agent.

## Quick start

```sh
# dev server (Bun HTML dev server with HMR) — http://localhost:3000
bun run dev

# offline demo: local relay + scripted mock host; prints a ws://localhost link
bun run mock-host
```

Host a session from any omp instance (`/collab`, or `/collab ws://localhost:7466` to use the mock relay), then paste the printed link into the connect screen. Deep links work too: `http://localhost:3000/#<roomId>.<key>` auto-connects on load.

## Build & deploy

```sh
bun run build   # static site in dist/
```

`dist/` is a fully static SPA — host it anywhere, at the site root or under a path prefix (every URL the build emits is relative). JS/CSS bundles and chunks are content-hashed; favicons, `manifest.webmanifest`, `robots.txt`, `sitemap.xml`, and `og-image.png` come from `public/` and are emitted under stable names (canonical URL: `https://my.omp.sh/`). `scripts/build-sw.ts` then writes `sw.js`, an app-shell service worker that precaches the build. Its cache name is derived from the emitted files, so every deploy that changes the client ships a new worker. Two runtime requirements:

- **Secure context**: room keys are unwrapped with WebCrypto (`crypto.subtle`). WebCrypto and service workers are available only on `https://` or `localhost`.
- **Relay reachability**: the client connects straight to the relay over WebSocket (`wss://` for anything that isn't localhost). The default relay is `wss://my.omp.sh`; bare `<roomId>.<key>` links resolve against it (legacy `<roomId>#<key>` and `%23`-mangled links still parse).

The room key never leaves the URL fragment — it is not sent to the relay or any server.

## Installed app (PWA)

The client installs to a phone's home screen: Safari → Share → *Add to Home Screen*, or Chrome → *Install app*. A home-screen launch opens `start_url`, which has no fragment, so the client keeps its own state in `localStorage`:

- **Recent sessions**: every room that welcomed the guest, with its title, cwd, and full join link. Tapping one rejoins it. A room the relay reports as gone (`no such room`) is dropped.
- **Resume**: the room on screen when the OS last killed the app. It reconnects on launch, and an explicit *Leave* clears it.
- **Join without typing**: *Paste link* reads the clipboard (works with macOS → iPhone Universal Clipboard and accepts `omp join "<link>"` verbatim). *Scan QR* reads the `/collab` QR code with the camera (native `BarcodeDetector` where available, otherwise a lazily loaded `jsqr` chunk). Android's share sheet can also send a link to the installed app through the manifest's `share_target`.

Stored join links grant whatever their access says until the host closes the room; *forget* removes one. Foregrounding the app or regaining the network reconnects right away instead of waiting out the socket backoff.

The composer keeps unsent text per room (it survives the OS killing the app), attaches images from the photo library, camera, or clipboard (anything over 1568px or 750 KB is downscaled to JPEG before it is sealed), and shows a row of one-tap quick replies while the input is empty. The pencil chip edits the quick replies; they are stored per device. Prompts sent while the connection is down are queued (stored per room, so they survive an app kill), shown as pending bubbles you can cancel, and sent in order once the session is live again. Each queued prompt is sent at most once: a drop right after hand-off loses it rather than risking a duplicate. Read-only links never queue.

Inside a session:

- **Chat view** (⋯ → *View*): prompts and replies only. Thinking and model/thinking-level markers are hidden, each run of tool calls folds into one line that expands to the usual cards, and a single status line tracks the running tool. The choice is stored per device; without one, phones (≤640px) start in chat view and larger screens in the full transcript.
- **Find** (magnifier): searches prompt and reply text, newest match first; ↑/↓ or Enter/Shift+Enter step through matches, which are highlighted with the CSS Custom Highlight API.
- **Changes** (⋯ → *Changes*): every file changed through `edit`, `apply_patch`, `write`, or an applied `ast_edit`, newest first, with line counts and each change's diff. Built from the transcript, so shell commands and edits made outside the session do not appear here; the companion's *Working tree* tab covers those.
- **New since you left**: rejoining a room shows a divider before the first entry you have not seen and an *N new* pill that jumps to it. The last seen entry is stored per room (50 rooms).
- **Session controls** (⋯): switch the host's model (session only, not saved as the default), set the thinking level, or compact with optional instructions. Shown only on full links to hosts whose omp supports guest session commands; older hosts hide them.
- **Usage** (⋯): session cost and input/output/cache tokens summed from the assistant replies, plus the last turn.
- **Keyboard** (desktop): ⌘K / Ctrl+K opens the session switcher, `/` opens find, Esc closes the top sheet or find, otherwise stops a running turn. Shortcuts other than Esc are ignored while typing.
- A **Latest** button appears once you scroll away from the tail, and every code block has a **Copy** button.

### Companion: every session on your computer

`bun run companion` (in this package) opens one long-lived encrypted room on the relay and pairs the app with the computer it runs on. Scan the QR code it prints, or open the printed `https://…/#pair:<link>` URL, once. From then on the connect screen lists every omp session on that computer that is hosting `/collab` (name, cwd, working / idle / needs input, guests), refreshed every few seconds, and a tap joins one with full control. No per-session link is needed. Inside a session, the header's switcher button lists the same sessions plus recent rooms (with a dot while another session needs input), and a banner offers a one-tap jump when another session starts waiting on input.

```sh
bun scripts/companion.ts                       # print the pairing QR, then serve
bun scripts/companion.ts --install             # run it as a LaunchAgent (macOS), started at login and restarted on exit
bun scripts/companion.ts --install --dry-run   # print the plist without writing or loading it
bun scripts/companion.ts --uninstall           # stop and remove the LaunchAgent
bun scripts/companion.ts --pair                # print the pairing QR from the stored state and exit
bun scripts/companion.ts --rotate              # new room key: unpairs every device
```

- Session data comes from the installed omp CLI (`omp collab list --json`, `omp collab link <id> --json`), so it works with any omp version that has `omp collab`. Set `OMP_BIN` when `omp` is not on `PATH`.
- The relay and web URLs come from `collab.relayUrl` and `collab.webUrl`. The room id and key persist in `~/.omp/agent/collab-companion.json` (mode 0600), so restarts keep devices paired; `--rotate` issues a new key and unpairs every device.
- **LaunchAgent**: `--install` writes `~/Library/LaunchAgents/sh.omp.collab-companion.plist` (absolute bun and script paths, `OMP_BIN`, `PATH`, and `PI_CONFIG_DIR` captured at install time) and logs to `~/Library/Logs/omp-collab-companion.log`. Stop a manually started companion first: two companions fight over the same room. Re-run `--install` after moving the repository. Use `--pair` to pair another device while the LaunchAgent runs.
- **The pairing link is a standing capability for the whole computer**: joining every session with full control, reading files inside each session's repository, git status and diffs, and starting omp in any folder. Treat it like an SSH key: the app keeps it in this origin's `localStorage` only, and *unpair* removes it.
- **Notifications**: the bell on the computer card (or ⋯ → *Notify*) subscribes the device to Web Push. The companion then pushes when a session needs input (the body is the pending `ask` question, read from the tail of the session file) or finishes a turn (the start of the last reply), straight to the browser's push service with its own VAPID key (stored in the same state file; `--rotate` replaces it and drops every subscription). A device showing the app gets the in-app banner instead. Tapping a notification opens that session. iOS offers push only to the installed app (16.4+); notifications stop while the companion is not running.
- **Working tree** (⋯ → *Changes* → *Working tree*): branch, upstream ahead/behind, changed files with line counts, per-file diffs against HEAD, and the last 15 commits, read with `git --no-optional-locks` in the session's repository. Includes changes made by shell commands and outside omp.
- **File viewer**: file paths in read, write, edit, `ast_edit`, LSP, and glob cards open the file read-only (first 512 KB, binary files detected). Paths must resolve, after symlinks, inside the session's repository (or its cwd outside a repository).
- **Start session**: pick a recent folder (from the local session store) and start a new session or resume a recent one. The companion runs `omp --config <overlay> [-r <id>]` in a detached tmux session (`tmux attach -t omp-<id>` on the computer), with an overlay at `~/.omp/agent/collab-companion-overlay.yml` that sets `collab.autoStart: control`, and opens it once it is listed. Requires tmux.
- **Share idle sessions**: sessions that are running but not hosting `/collab` appear under *Not sharing* with a *Share* button, which starts hosting with control access through `omp collab start`. Needs an omp with `omp collab start`; with older versions the section stays empty.
- The working tree, file viewer, and path links appear only when the companion lists the current session. Only sessions publishing control access are listed. The companion must be running for the list to load.

To make `/collab` links and QR codes open your own deployment, set `collab.webUrl` to its URL. The repository's `collab-web pages` workflow deploys this package to a fork's GitHub Pages site (`https://<owner>.github.io/<repo>/`). It runs on pushes to the `collab-pwa` branch or on demand.

## Architecture

- `src/lib/` — vendored wire codec (`codec.ts` AES-256-GCM, `link.ts` envelope + link grammar), `socket.ts` reconnecting relay socket, `client.ts` guest session store (`GuestClient` + immutable snapshots for `useSyncExternalStore`). Shared protocol shapes come from `@oh-my-pi/pi-wire`.
- `src/components/` — `transcript/` (entries, markdown, tool cards), `agents/` (panel + transcript drawer), `shell/` (connect screen, header, composer, banners, toasts).
- `src/tool-render/` — per-tool React renderers shared with coding-agent HTML session exports: one view per built-in tool, common `ToolView` chrome, theme-adaptive `tv-` design tokens, and an `<omp-tool-view>` web-component wrapper. The `ToolRenderHost` seam lets hosts wire agent-id chips to a sub-session view (drawer here, overlay in exports) and, through the optional `openFile`, turn file paths into links (the companion file viewer here).
- `scripts/` — `local-relay.ts` (content-blind relay on `Bun.serve`), `mock-host.ts` + `fixture.ts` (scripted host for offline dev), `companion.ts` + `web-push.ts` (companion room and its WebCrypto-only Web Push sender: RFC 8291 encryption, RFC 8292 VAPID), `companion-git.ts` (read-only git and contained file reads), `companion-sessions.ts` (session-file parsing for notifications and recent folders), `companion-start.ts` (tmux launch), `companion-launchd.ts` (LaunchAgent), `build-sw.ts` (service worker: app-shell cache, push display, notification taps), `build-tool-views.ts` (bundles `src/tool-render/` + React into `packages/coding-agent/src/export/html/tool-views.generated.js` for self-contained exports).

The package is intentionally standalone — no dependency on `@oh-my-pi/pi-coding-agent` at runtime or type level. Wire-shape drift is prevented by consuming the same `@oh-my-pi/pi-wire` contracts as the host, with sealed-frame interop still covered by `test/codec.test.ts`.
