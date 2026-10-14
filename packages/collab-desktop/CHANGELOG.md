# Changelog

## [Unreleased]

### Added

- Added the omp collab desktop app for macOS: an Electron window around the collab web app that runs this computer's companion, attaches to one that already runs, and restarts it when it crashes.
- Added a menu-bar icon with the number of sessions waiting for you, native notifications when a session needs input or finishes a turn, a global shortcut, a native save dialog, and an *Open at Login* option.
- Added *Run the Companion Inside This App…* to move off the launchd/systemd service without doing it automatically.
- Added a self-updater that checks GitHub releases, verifies the download against `SHA256SUMS.txt` and swaps the app when it quits.
- Added ad-hoc signed `collab-desktop-darwin-<arch>.zip` and `.dmg` assets to the collab release, and the installer's `--desktop` / `--no-desktop` step.
