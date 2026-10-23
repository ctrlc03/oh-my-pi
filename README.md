# oh-my-pi, collab fork

This is [ctrlc03/oh-my-pi](https://github.com/ctrlc03/oh-my-pi), a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`), a coding agent that runs in your terminal. For what omp itself does (providers and models, tools, configuration, the SDK, RPC and ACP modes), see the [upstream project](https://github.com/can1357/oh-my-pi) and [omp.sh](https://omp.sh). To install upstream omp without this fork's additions (Homebrew, npm, Nix, mise, Windows), follow [upstream's install instructions](https://github.com/can1357/oh-my-pi#install).

`main` follows upstream releases and adds:

- **Collab**: a background service on your computer (the *companion*), a web app for a browser, phone or iPad, and a desktop app for macOS and Linux. From the app you start, watch and steer every omp session on that computer, and on other computers you pair. See [Getting started](docs/collab-getting-started.md) and the [reference](docs/collab.md).
- **Personal agent** (opt-in, off by default): [docs/personal-agent.md](docs/personal-agent.md), [docs/personal-chat-tree.md](docs/personal-chat-tree.md).
- **Control over what the agent may do**: [agent profiles](docs/profiles.md), [approval modes](docs/approval-mode.md), and an [OS-level shell sandbox](docs/sandbox.md).
- **Session tools**: per-session spend caps, `/undo` and `/redo`, `/diff`, the [request inspector](docs/inspector.md), [pull request watching](docs/pr-watch.md), [schedules](docs/tools/schedule.md), the [`trace`](docs/tools/trace.md) and [`flow`](docs/tools/flow.md) code-map tools, and a [GitHub Action](docs/github-action.md).

## Install

macOS or Linux, x64 or arm64. On Linux, glibc 2.35 or newer (Ubuntu 22.04, Debian 12, Fedora 36 or newer). On Windows, run it inside WSL. You also need an account with a model provider omp supports (Claude, OpenAI, …) or an API key.

```sh
curl -fsSL https://ctrlc03.github.io/oh-my-pi/install.sh | sh
```

The installer asks before anything that needs a decision; <kbd>Enter</kbd> takes the default. In order, it:

1. Downloads the fork's `omp` from the latest `collab-v*` GitHub Release, refuses it if its checksum does not match the release's `SHA256SUMS.txt`, and installs it as `~/.local/bin/omp`.
2. Offers to install tmux (needed to start sessions from the app), and git on Linux.
3. Runs `omp login` if no model provider is logged in. Pick your provider and follow its prompts.
4. **On a Mac or a Linux desktop, offers the desktop app** and installs it as `~/Applications/omp collab.app` (macOS) or into `~/.local/share/omp-collab/desktop` with an applications-menu entry (Linux); the default answer is yes. It is optional: everything also works in a browser.
5. Installs the companion as a background service that starts at login and restarts if it dies (a LaunchAgent on macOS, a systemd user unit on Linux).
6. Opens the desktop app, or without it the web app in this computer's browser, already paired with this computer. It also prints a link and QR code for pairing a phone.

Skip the questions with `sh -s -- --yes --no-login`. Other options: `--no-desktop` / `--desktop`, `--no-service` (install only the `omp` binary), `--no-open`. Every option, the checksum and build-attestation checks, and where each file goes are in [the installer reference](packages/collab-web/README.md#install).

### What you have afterwards

| Piece | Where | What it is for |
| --- | --- | --- |
| `omp` | `~/.local/bin/omp` | The coding agent in a terminal, plus the `omp companion` commands below. |
| Companion service | `sh.omp.collab-companion` (macOS), `omp-collab-companion` (Linux) | Runs in the background, starts sessions for the app, and serves the web app on this computer at `http://127.0.0.1:7467`. |
| Desktop app (macOS, if you said yes) | `~/Applications/omp collab.app` | The web app in its own window, with a menu-bar icon that counts sessions waiting for you, native notifications, and the shortcut <kbd>⌥⌘O</kbd> to show or hide it. It uses the companion service and updates itself from this fork's releases. |
| Web app | `http://127.0.0.1:7467` on this computer, <https://ctrlc03.github.io/oh-my-pi/> everywhere else | The same app for any browser, phone or iPad. Add it to the home screen to get it as an app with push notifications. |

Sessions run on your computer, in your folders, with your logins. The apps are windows onto them: closing one does not stop a session.

### What to do next

1. **Open the app.** On a Mac, open *omp collab* from Spotlight or `~/Applications`, or press <kbd>⌥⌘O</kbd> while it runs. Otherwise run `omp companion --open`, which opens the app in your browser and pairs it.
2. **Start a session.** On the connect screen, under your computer, choose *Start session*, pick a folder (*No project* gives you a fresh one), optionally *New git worktree* to keep your checkout untouched, type a prompt and start. The session runs in tmux (`tmux attach -t omp-<id>` shows it in a terminal).
3. **Pair your phone or iPad.** Open <https://ctrlc03.github.io/oh-my-pi/> on it, run `omp companion --pair` on the computer, and scan the QR code (or tap *Scan QR* in the app). Pairing links work once, for 10 minutes. Add the app to the home screen (Safari: Share → *Add to Home Screen*) and turn on *Notify* on the computer card to be told when a session needs you.
4. **Keep using omp in a terminal.** Run `omp` in a project folder as usual. Those sessions show up in the app too, and opening one there shares it. `/collab` in a session prints a link and QR code that let someone else join it (`/collab view` for read-only).
5. **Add another computer** (optional), such as a server that stays on: install there the same way and pair it from *Add a computer*. See [Add another computer](docs/collab-getting-started.md#add-another-computer-such-as-a-server).

[Getting started](docs/collab-getting-started.md) walks through all of this, the daily features (inbox, schedules, changes and pull requests, other agents such as Claude Code and Codex), and [troubleshooting](docs/collab-getting-started.md#if-something-does-not-work).

### Staying on this computer: the local relay

The companion runs a relay on loopback (`ws://127.0.0.1:7467`, or the next free port) next to the public one at `my.omp.sh`. An app on the same computer that uses it skips the internet entirely; messages are end-to-end encrypted either way.

| Where you open the app | Connection |
| --- | --- |
| The desktop app, or the copy the companion serves (`omp companion --open`) | Local relay, for the companion and the sessions it starts. The app needs no internet once loaded (the model calls still do). |
| The Pages site on the same computer | Public relay in practice: browsers block an `https` page from opening `ws://127.0.0.1` (Chrome's local network check, Safari outright). Use the local copy instead. |
| A phone, an iPad or another computer | Public relay. The local relay listens on loopback only, so nothing on your network can reach it. |

Sessions you start yourself with `omp` in a terminal use only the public relay until you point them at the local one. Find the companion's port (`omp companion --print-local-link` prints `http://127.0.0.1:<port>/…`), then:

```sh
omp config set collab.localRelayUrl ws://127.0.0.1:<port>
```

Leaving it on is safe: a session only sends to the local relay while someone is connected through it, a local relay that is down never affects the public session, and links printed by `/collab` still name only the public relay. If the companion later starts on another port (because the old one was taken), hand-started sessions fall back to the public relay until you update the setting; sessions the companion starts always follow it. Details: [Local relay for the web app on the host's computer](docs/collab.md#local-relay-for-the-web-app-on-the-hosts-computer).

### Keep your links private

> [!WARNING]
> Anyone with a pairing link or a `/collab` link can control your computer. Treat them like passwords.

- **Pairing links and QR codes** (`omp companion --pair`, `--open`, the installer's link) make a device a full remote for this computer. It can start sessions in any folder, and those sessions run shell commands, edit files and use your `git`, `gh` and model logins as you. A pairing link works once and for 10 minutes, but whoever opens it first is paired. Pair only your own devices, never post a link or a screenshot of the QR code, and don't share your screen while one is shown.
- **`/collab` links** let whoever opens them send prompts to that session, which runs tools as you. Share them only with people you trust with your computer, and use `/collab view` for a read-only link. `/collab stop` ends sharing, and with it every link to that session.
- **If a link leaked**, remove the device in the app's *Devices* settings, or run `omp companion --rotate` to unpair every device at once.

The relay that carries the traffic only sees encrypted messages: the key is in the link's `#` fragment, which is never sent to a server. That is also why the link alone is enough to get in. More: [Trust, in plain words](docs/collab-getting-started.md#trust-in-plain-words).

### Everyday commands

| Command | Does |
| --- | --- |
| `omp` | Start an interactive session in the current folder. |
| `omp login` | Log in to a model provider. Sessions started from the app use this login. |
| `omp companion --open` | Open the app on this computer, paired. |
| `omp companion --pair` | Print a one-time pairing link and QR code for another device. |
| `omp companion --rotate` | Unpair every device at once. |
| `omp update` | Update to this fork's latest release (re-running the install line does the same). |

**Uninstall**: `curl -fsSL https://ctrlc03.github.io/oh-my-pi/install.sh | sh -s -- --uninstall`. It removes the service and, if you agree, the binary and the desktop app. Your logins, settings and pairing in `~/.omp` are kept; delete that folder to forget them.

### VM sessions: agents with no limits, in a VM

`omp vm` runs an agent with root, an open network and no approvals inside a Linux VM on your computer, paired with your devices as its own computer. Your model logins (subscriptions included) stay on this computer: the VM's model calls go through it. GitHub works the same way: git and `gh` in the VM go through this computer, which adds a one-hour token limited to the VM's repositories and refuses pushes to the default branch, tags and merges. The VM holds no GitHub credential.

```sh
omp vm init                          # what is installed, what is missing (Lima, QEMU, the GitHub App)
omp vm github setup                  # once: create the GitHub App and install it on your repositories
omp vm create api --repo acme/api    # prints a pairing link for the new computer
```

The app does the same from *Add a computer → New virtual machine*. Requirements, limits and the threat model: [VM sessions](docs/vm-sessions.md).

### Shell completions

`omp` generates completion scripts for **bash**, **zsh** and **fish** from its own command metadata, including model names and your saved sessions.

```sh
# zsh: add to ~/.zshrc
eval "$(omp completions zsh)"

# bash: add to ~/.bashrc
eval "$(omp completions bash)"

# fish
omp completions fish > ~/.config/fish/completions/omp.fish
```

## Run the fork from source

```sh
git clone https://github.com/ctrlc03/oh-my-pi.git
cd oh-my-pi
bun setup                          # workspace dependencies and the Rust native addon
(cd packages/coding-agent && bun link)   # `omp` on your PATH now runs this checkout
omp companion --install            # optional: the collab companion as a login service
```

To update, run `git pull && bun install`, then `bun run build:native` if the pull changed `crates/` or `packages/natives`. Restart the companion afterwards with `omp companion --install`.

**Apple's on-device model** (`apple/on-device`; needs macOS 27 on Apple silicon with Apple Intelligence turned on): the native addon embeds the bridge to it only when Swift 6.4 and the macOS 27 SDK are installed at build time. Otherwise the build prints a warning and the model never appears. Install them with `sudo softwareupdate -i "Command Line Tools for Xcode 27.0-27.0"` (or install Xcode 27), check with `sh crates/pi-natives/src/applefm/build-bridge.sh detect` (it prints a toolchain when one is usable), then run `bun run build:native`.

## Maintaining the fork

- **Take upstream changes**: `git fetch origin --tags`, then `git merge v<version>` on `main` (`origin` is can1357/oh-my-pi). Resolve conflicts and run `bun run check:ts` before pushing `main`.
- **Publish a release**: push a tag `collab-v<version>-<n>`, where `<version>` is `packages/coding-agent/package.json`'s version and `<n>` counts releases of that version. See *For the maintainer: publishing a release* in [the installer reference](packages/collab-web/README.md#install).
- **What runs on GitHub**: a push to `main` deploys the web app and the installer to GitHub Pages and prebuilds the native addons. A `collab-v*` tag builds and publishes the release binaries and the desktop app. Upstream's own CI workflows are disabled in this fork.

## Contributing

Issues and pull requests are open to everyone. Open PRs are currently a
**trial** — the previous vouch requirement is lifted while we evaluate how it
goes, and it may return. See **[CONTRIBUTING.md](CONTRIBUTING.md)** for
guidelines on contributing.

---

## License

OMP is licensed under the [MIT License](LICENSE).

Third-party and vendored code, including `crates/vendor/brush-core` and the
third-party portions identified in `crates/pi-builtins/LICENSE`, remains under
its respective upstream license. See `THIRD-PARTY-NOTICES.txt` and
component-local notices for attribution and additional terms.

© 2025 Mario Zechner  
© 2025-2026 Can Bölük  
© 2026 [Stencil Labs, Inc.](https://stencil.so)
