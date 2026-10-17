# omp collab desktop

An Electron app for macOS that shows the collab web app (`packages/collab-web`) in its own window and runs this computer's companion. The user-facing description is in `docs/collab.md` ("Desktop app"); this file is for people working on it.

The window loads the app the companion serves on loopback (`http://127.0.0.1:<port>/`), so it connects to other computers exactly as the web app does. The shell adds what a browser tab cannot do: a menu-bar icon and native notifications, a global shortcut (default `⌥⌘O`), a native save dialog, a login item, and the companion's lifecycle.

## How it finds and runs the companion

1. **Discovery.** The companion publishes `<config>/agent/collab-companion-local.json` (`{pid, port, app}`; `<config>` is `~/<PI_CONFIG_DIR or .omp>`). The app attaches when that file names a live process whose port answers a request. A companion that runs but serves no app (`--no-local-app`) is reported, never duplicated. A file left by a crashed companion is ignored.
2. **Start and supervise.** Two companions on one room fight over it (the relay closes the loser with 4009 and each retries every few seconds), so the app starts one only when nothing else is there or on its way:
   - A live single-instance lock (`<config>/agent/collab-companion.lock`, `{pid, startedAt}`; live when that pid runs a companion: a command line with `companion.ts` or `omp companion`) means a companion is starting or standing by. The app waits for its endpoint and spawns nothing. A holder that publishes no endpoint within 60 s (started without its local relay or web app) is reported by pid as in the way; the app keeps watching and attaches when the endpoint appears.
   - With the launchd/systemd service installed the app **never spawns a companion**. When none is found it asks the service manager to start the service (macOS `launchctl kickstart gui/<uid>/sh.omp.collab-companion`, without `-k`; Linux `systemctl --user start omp-collab-companion.service`), shows *waiting for the companion service*, checks again after 1 s, 2 s, 4 s, then every 5 s, and asks again no more than every 30 s while it does not come. A service whose plist exists but is not loaded (after `launchctl bootout`, or a failed bootstrap) is loaded with `launchctl bootstrap gui/<uid> <plist>` and kicked. After 3 failed asks in a row the window says the service cannot start and offers *Run the Companion Inside This App…* (remove the service) — the app still never spawns beside the service file — and keeps asking, attaching if it comes up.
   - With no service, no lock and no endpoint it spawns `omp companion` (detached, output in `<userData>/logs/companion.log`, mode 0600 — it holds the one-time pairing code the companion prints at start). A crash restarts it after 1 s, doubling to 30 s, reset after a minute of stable running. If another companion appears meanwhile, the app attaches instead.

   An attached companion that disappears is handled the same way: the app waits for the service or the lock holder, or runs its own when there is neither.
3. **Quit.** Stops the companion the app started (SIGTERM, SIGKILL after 6 s) unless *Keep the Companion Running After Quit* is on. Never stops one it attached to.
4. **Pairing.** The window opens the plain app URL and reads `omp.collab.computers` from its storage. Only when it holds no credentials (or invite) for this companion's room does the app run `omp companion --print-local-link` and load the one-time link. *Companion → Pair This Computer Again* forces it.
5. **The in-app *Restart companion*** is refused for a companion that nothing manages (the hint says so). Use the app's own *Companion → Restart Companion.

### Where the `omp` comes from

The app does **not** bundle omp; it requires the one the installer put on this computer. Resolution order (a GUI app has a bare `PATH`): the checkout's `packages/collab-web/scripts/companion.ts` when the app is unpackaged and `bun` exists; `OMP_BIN`; the *omp path* setting (`settings.json` `ompPath`); the installer's state file (`${XDG_DATA_HOME:-~/.local/share}/omp-collab/install`, `path=`); then `~/.local/bin`, `PATH`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.bun/bin`. A candidate must be executable and answer `companion --help` (only the compiled omp has the subcommand). If none does, the app shows the installer's one-liner.

Why not bundle it: sessions run with this omp, which must be the one the user logs in with in a terminal; the compiled binary is about 250 MB, which would be added to every self-update; two copies drift; and paths inside an updatable ad-hoc bundle are fragile.

## Security

- `contextIsolation`, `sandbox`, no `nodeIntegration`, no `webview`; the preload exposes `window.ompDesktop` with exactly `saveFile`, `reportSessions`, `onOpenSession` (plus `version`, `platform`).
- Every IPC handler checks that the sender is the app origin's top frame, and validates its input (sizes, shapes, file names).
- Navigation is limited to the app origin; every other `http(s)`/`mailto` link opens in the default browser, anything else is dropped. Permissions: notifications, clipboard, microphone/camera, for the app origin only.
- Single-instance lock; the window position and size persist and are restored only onto a display that still exists.

## Updates

macOS only, and only for release builds (a development build has no `OmpBuildTag` and never updates). The app lists the fork's releases, takes the newest `collab-v<semver>-<n>` newer than its own tag that carries `collab-desktop-darwin-<arch>.zip` and `SHA256SUMS.txt`, downloads the zip (URL pinned to `github.com/<repo>/releases/download/<tag>/`), and verifies size and sha256 against `SHA256SUMS.txt` and GitHub's digest. It unpacks beside the installed bundle with `ditto`, checks the bundle id, the build tag and `codesign --verify`, and a detached script swaps the bundle once the app has quit (rolling back on failure). Squirrel/electron-updater are not usable with an unsigned app, hence the small custom updater. Windows and Linux report "updates not supported".

## Install and Gatekeeper

The one-line installer (`scripts/install-collab.sh`, `--desktop` / `--no-desktop`) is the primary route: curl downloads carry no quarantine flag, so macOS runs the ad-hoc signed app. The `.dmg` and `.zip` on each release are for people who download in a browser: macOS then blocks the first launch. Open *System Settings → Privacy & Security*, scroll to the message about "omp collab" and choose *Open Anyway* (or run `xattr -dr com.apple.quarantine "/Applications/omp collab.app"`). The app is not notarized.

## Leaving the launchd/systemd service

Nothing is automatic. With a service installed, the app attaches to it and starts it when it is stopped; it never runs a companion of its own beside it. *Companion → Run the Companion Inside This App…* stops watching, runs `omp companion --uninstall`, waits for the service's endpoint to go away and then starts the app's own companion (the service file is gone by then, which is what allows it); there is no menu item when no service file exists.

## Working on it

```sh
bun run dev                 # build and run unpackaged, companion from this checkout
bun run pack                # signed omp collab.app in release/ (--dir)
bun run dist                # .app, collab-desktop-darwin-<arch>.zip and .dmg
bun test                    # pure logic: discovery, supervisor, pairing, updater, release selection, menus
bun run smoke               # launches the real app against a throw-away HOME (see below)
bun scripts/smoke.ts --packaged "release/mac-arm64/omp collab.app" --omp /path/to/compiled/omp
```

`OMP_DESKTOP_DATA_DIR` moves the app's own data (settings, window state, logs); `HOME` and `PI_CONFIG_DIR` move the companion's (Electron's own directories do not follow `$HOME` on macOS). `OMP_DESKTOP_TEST=1` exposes `globalThis.__ompDesktop` (diagnostics, window toggle, tray menu) for the smoke test. `OMP_BUILD_TAG` and `OMP_RELEASE_REPO` (or `--tag` / `--repo`) record the release a build belongs to. `scripts/smoke.ts` builds on the collab-web e2e harness (private tmux, scripted model, companion on a free port) and never touches `~/.omp`, the user's tmux or port 7467. It needs a macOS GUI session; the release workflow runs the unit tests and checks the bundle, not the GUI smoke.
