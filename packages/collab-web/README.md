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

The composer keeps unsent text per room (it survives the OS killing the app), attaches images from the photo library, camera, or clipboard (anything over 1568px or 750 KB is downscaled to JPEG before it is sealed), and shows a row of one-tap quick replies while the input is empty. The pencil chip edits the quick replies; they are stored per device.

### Companion: every session on your computer

`bun run companion` (in this package) opens one long-lived encrypted room on the relay and pairs the app with the computer it runs on. Scan the QR code it prints, or open the printed `https://…/#pair:<link>` URL, once. From then on the connect screen lists every omp session on that computer that is hosting `/collab` (name, cwd, working / idle / needs input, guests), refreshed every few seconds, and a tap joins one with full control. No per-session link is needed.

- Session data comes from the installed omp CLI (`omp collab list --json`, `omp collab link <id> --json`), so it works with any omp version that has `omp collab`. Set `OMP_BIN` when `omp` is not on `PATH` (for example under launchd).
- The relay and web URLs come from `collab.relayUrl` and `collab.webUrl`. The room id and key persist in `~/.omp/agent/collab-companion.json` (mode 0600), so restarts keep devices paired; `--rotate` issues a new key and unpairs every device.
- **The pairing link is a standing control capability for every session on the computer.** Treat it like an SSH key: the app keeps it in this origin's `localStorage` only, and *unpair* removes it.
- Only sessions publishing control access are listed. The companion must be running for the list to load. Keep it alive with a LaunchAgent, `tmux`, or similar.

To make `/collab` links and QR codes open your own deployment, set `collab.webUrl` to its URL. The repository's `collab-web pages` workflow deploys this package to a fork's GitHub Pages site (`https://<owner>.github.io/<repo>/`). It runs on pushes to the `collab-pwa` branch or on demand.

## Architecture

- `src/lib/` — vendored wire codec (`codec.ts` AES-256-GCM, `link.ts` envelope + link grammar), `socket.ts` reconnecting relay socket, `client.ts` guest session store (`GuestClient` + immutable snapshots for `useSyncExternalStore`). Shared protocol shapes come from `@oh-my-pi/pi-wire`.
- `src/components/` — `transcript/` (entries, markdown, tool cards), `agents/` (panel + transcript drawer), `shell/` (connect screen, header, composer, banners, toasts).
- `src/tool-render/` — per-tool React renderers shared with coding-agent HTML session exports: one view per built-in tool, common `ToolView` chrome, theme-adaptive `tv-` design tokens, and an `<omp-tool-view>` web-component wrapper. The `ToolRenderHost` seam lets hosts wire agent-id chips to a sub-session view (drawer here, overlay in exports).
- `scripts/` — `local-relay.ts` (content-blind relay on `Bun.serve`), `mock-host.ts` + `fixture.ts` (scripted host for offline dev), `build-tool-views.ts` (bundles `src/tool-render/` + React into `packages/coding-agent/src/export/html/tool-views.generated.js` for self-contained exports).

The package is intentionally standalone — no dependency on `@oh-my-pi/pi-coding-agent` at runtime or type level. Wire-shape drift is prevented by consuming the same `@oh-my-pi/pi-wire` contracts as the host, with sealed-frame interop still covered by `test/codec.test.ts`.
