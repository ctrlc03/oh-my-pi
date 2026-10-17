# Changelog

## [Unreleased]

### Added

- Added the omp collab desktop app for macOS: an Electron window around the collab web app that runs this computer's companion, attaches to one that already runs, and restarts it when it crashes.
- Added a menu-bar icon with the number of sessions waiting for you, native notifications when a session needs input or finishes a turn, a global shortcut, a native save dialog, and an *Open at Login* option.
- Added *Run the Companion Inside This App…* to move off the launchd/systemd service without doing it automatically.
- Added a self-updater that checks GitHub releases, verifies the download against `SHA256SUMS.txt` and swaps the app when it quits.
- Added ad-hoc signed `collab-desktop-darwin-<arch>.zip` and `.dmg` assets to the collab release, and the installer's `--desktop` / `--no-desktop` step.

### Fixed

- Fixed the app starting its own companion while the launchd/systemd service was also running, which left two companions fighting over the relay room (close 4009, retried every few seconds for hours). With the service installed the app now never spawns a companion: it asks the service manager to start the service (`launchctl kickstart` without `-k`, `systemctl --user start`), shows "waiting for the companion service", and asks again at most every 30 s. A live companion lock (`collab-companion.lock`) also makes the app wait instead of starting one. A service that is installed but not loaded is loaded with `launchctl bootstrap` first; one that still fails three asks in a row, or a lock holder that publishes no address for 60 s, is reported instead of waited for forever.
- Fixed the app never pairing with the companion when `omp` is a `bun link` to a source checkout: that `omp` has no `companion` command, so the app now runs the checkout's companion (`bun packages/collab-web/scripts/companion.ts`) instead of reporting "no companion to pair with".
- Fixed the installer refusing to update or delete the app whenever any "omp collab" process ran: it now checks only the copy it is about to replace or delete.
