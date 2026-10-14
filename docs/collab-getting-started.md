# Getting started with omp collab

A guide for a colleague who has never used omp. It takes about five minutes.

## What this is

omp is a coding agent that runs in your terminal. This fork adds a small background service, the *companion*, and a web app. Install it once on your computer, pair the app with it, and you can start and watch coding-agent sessions from a browser, a phone or an iPad. The sessions run on your computer, in your folders, with your own accounts. The web app is only a window onto them.

## What you need

- A Mac or a Linux computer (x64 or arm64). On Linux, glibc 2.35 or newer: Ubuntu 22.04, Debian 12, Fedora 36 or newer. Alpine (musl) is not supported, and on Windows you need WSL.
- An account with a model provider omp can use: Claude, OpenAI or another one that `omp login` offers (or an API key in your environment).
- A browser. A phone or iPad is optional.
- Optional: `git`, and the GitHub CLI `gh` signed in for the pull request features.

## Install

Open Terminal on that computer and paste one line:

```sh
curl -fsSL https://ctrlc03.github.io/oh-my-pi/install.sh | sh
```

The installer asks before anything that needs a decision, and you can answer with <kbd>Enter</kbd> for the default shown:

- **An `omp` already exists.** One the installer did not put there is never replaced unless you say yes. Another `omp` elsewhere on your `PATH` is named and left alone.
- **tmux is missing.** The app needs it to start sessions, so the installer offers to install it with your package manager (`brew`, `apt`, `dnf`, `pacman`, `zypper` or `apk`). On Linux it offers the same for `git`.
- **No model is logged in.** It runs `omp login` in the terminal. Pick your provider and follow its prompts; for providers that sign in through the browser, a window opens and you come back to the terminal when it is done. Skip it and run `omp login` yourself later, because sessions cannot work without a login.

Then it installs the companion as a background service that starts when you log in, opens the web app in your browser, already paired with this computer, and prints a link and QR code for your phone. The app it opens is the copy the companion itself serves on this computer (`http://127.0.0.1:7467`); it needs no internet once loaded. To skip the questions: `curl -fsSL https://ctrlc03.github.io/oh-my-pi/install.sh | sh -s -- --yes --no-login`.

What goes where, the checksum and build checks, and every installer option are in [Install for colleagues](../packages/collab-web/README.md#install-for-colleagues).

## Pair your devices

The browser the installer opened is paired already. Its address is `http://127.0.0.1:7467` (the companion logs the port it picked): the web app served by the companion on this computer. Its connect screen shows your computer, with every omp session on it. To open it again, or in another browser, run `omp companion --open` (it pairs that browser with a fresh one-time link; `omp companion --print-local-link` prints the link without opening it). A browser pairs per address, so one already paired on the Pages site pairs again at `127.0.0.1`.

Use the local copy on this computer and <https://ctrlc03.github.io/oh-my-pi/> everywhere else:

| Where                          | Open                                        | Why                                                                                      |
| ------------------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| On the computer running omp    | `omp companion --open`                      | Same machine, no internet needed, no browser prompts about local network, installs as an app |
| Phone, iPad, another computer  | The Pages address above                     | Needs `https`, reaches the computer through the public relay                             |

To add a phone or iPad:

1. Open the web app on it: <https://ctrlc03.github.io/oh-my-pi/>. It needs `https`, which that address has.
2. On the computer, run `omp companion --pair`. It prints a one-time link (for the Pages address) and a QR code and works while the service is running. Or open *Devices* in the app on a device that is already paired and choose *Add a device*.
3. Scan the QR code with the phone's camera, or in the app tap *Scan QR* on the connect screen. Opening the printed link on the device works as well.

A pairing code works once and expires after 10 minutes. Each device then keeps its own credentials. In *Devices* you can rename or remove a device.

To keep the app on your home screen: in Safari tap Share, then *Add to Home Screen*; in Chrome choose *Install app*. The installed app reopens the last session, lists recent ones, and on iOS 16.4 or newer it is the only form that can send push notifications (*Notify* on the computer card).

## Add another computer, such as a server

You can pair the same phone or browser with several computers and see all their sessions in one list, labelled by computer. A server that stays on is the usual second one: sessions on it keep running when you close the laptop, and the phone still reaches them.

1. Log in to the server over SSH and install omp the way you did on the laptop (the install line above). On a server with no browser, use `--no-open`.
2. There, run `omp companion --install` (the installer does it unless you passed `--no-service`): a systemd user unit on Linux, started now and at login. On a server that nobody logs in to, run `loginctl enable-linger <user>` once so the unit keeps running after you disconnect.
3. Run `omp companion --pair`. It prints a one-time pairing link and a QR code.
4. In the app, on the phone or the laptop's browser, open Settings → *Computers* (or *Add a computer* on the connect screen), then scan the QR code or paste the link.

The new computer appears as its own group in the sessions list under its machine name, and *Start session* asks which computer to use. Closing the laptop, or any one computer going offline, only greys out that computer's group: sessions on the others keep running and stay reachable. *Remove* in Settings → *Computers* forgets a computer on this device.

## Your first session

1. On the connect screen, under your computer, tap *Start session*.
2. Pick a folder. The list shows folders you have used omp in before; *No project* gives you a fresh folder for one-off work.
3. Choose *New git worktree* to work on a separate branch and checkout, so your main checkout stays untouched. Optionally type a first prompt.
4. Start. The session opens and you can watch the agent, answer its questions and send prompts.

The session runs in the background on the computer in a tmux session named `omp-<id>` (`tmux attach -t omp-<id>` shows it), so closing the app does not stop it.

**Other agents.** The *Agents* screen on the computer card (the agent picker in *Start session* links to it with *Open agents* when an agent needs attention) lists Claude Code, Codex, Cursor, Grok and OpenCode and whether each is installed and signed in. Each runs as its own session on your computer with its own login, not omp's. If one needs signing in, the screen shows the command to run in your terminal, for example `claude auth login` or `codex login`. You can also add any agent that speaks the Agent Client Protocol as a custom agent.

## Using it every day

Everything below is described in [Collab: Live Session Sharing](./collab.md#web-client) and [the web app's README](../packages/collab-web/README.md#installed-app-pwa). A few places to start:

- The chat view, find, quick replies, attachments, voice input and the command palette (<kbd>⌘K</kbd> or <kbd>Ctrl+K</kbd>, or ⋯ → *Search* on a phone): [The message box](./collab.md#the-message-box) and [Command palette and keybindings](./collab.md#command-palette-and-keybindings).
- *Inbox* lists sessions waiting for you; *Schedules* runs a prompt later or daily; *Usage* shows spend; *All sessions* searches past sessions.
- *Changes* and *Branch* show what the agent edited, and commit, push and open a pull request after you confirm: [the companion section](../packages/collab-web/README.md#companion-every-session-on-your-computer).
- Undo and edit-and-resend: [Undoing the last turn](./collab.md#undoing-the-last-turn) and [Rewinding files](./collab.md#rewinding-files).

## Update

Run the install line again. It replaces the program, restarts the service and keeps your pairing. `omp update` also works and follows this fork's releases, not upstream's. The app's *Diagnostics* screen shows the companion's build.

## Uninstall

```sh
curl -fsSL https://ctrlc03.github.io/oh-my-pi/install.sh | sh -s -- --uninstall
```

This stops and removes the service and, if you agree, deletes the `omp` binary. It keeps `~/.omp` (logins, settings, pairing), so a reinstall needs no new pairing. Delete that folder if you want everything gone. In the app, *Devices* removes a paired device; `omp companion --rotate` unpairs every device at once.

## If something does not work

**Is the service running?**

- macOS: `launchctl print gui/$(id -u)/sh.omp.collab-companion`. The log is `~/Library/Logs/omp-collab-companion.log`.
- Linux: `systemctl --user status omp-collab-companion`, and `journalctl --user -u omp-collab-companion -f` for the log.
- The app's *Diagnostics* screen shows whether launchd or systemd runs it, its version and recent connection events. Its *Restart companion* button restarts the service.

**The computer shows offline after a reboot or logout (Linux).** A user service stops with your last login session unless lingering is on. The installer prints the fix: `loginctl enable-linger $USER`.

**No background service on Linux.** Without a running systemd user manager (WSL without systemd, containers, `su` or `sudo -u` without a login session) the installer installs the program only and says so. Run `omp companion` in a terminal and keep it open, or fix systemd and re-run the installer.

***Start session* fails, or other agents will not start.** tmux is missing. Install it (`brew install tmux`, `sudo apt install tmux`) and try again.

**`omp: command not found` in a terminal.** `~/.local/bin` is not on your `PATH`. The installer prints the line to add to your shell profile: `export PATH="$HOME/.local/bin:$PATH"`. The service does not need it.

**The browser did not open on Linux.** Without `xdg-open` the installer prints the pairing link instead. Open it in a browser yourself, or run `omp companion --print-local-link` for a link to the app on this computer (`omp companion --pair` prints one for the Pages address).

**`http://127.0.0.1:7467` does not load.** The companion is not running (see the service checks above), it picked another port because 7467 was taken (its log says `open http://127.0.0.1:<port> on this computer`; `omp companion --open` finds it), or it was started with `--no-local-app` or `--no-local-relay`. A page that loaded once still opens without the companion; it shows the computer as unreachable until the companion is back. When the companion runs from a source checkout, the first load may say the app is building; the page refreshes itself.

**The link expired, or the app lost its pairing.** Run `omp companion --open` (this computer) or `omp companion --pair` (another device) and pair again. After `--rotate`, or when a device was removed in *Devices*, that device has to pair again.

**The computer goes offline while you are away (macOS).** While the companion runs it keeps the Mac from idle-sleeping, but closing the lid still sleeps a Mac without an external display. Leave the lid open (the screen may turn off).

**Sessions fail with a login error.** Run `omp login` on the computer. Sessions use that login.

## Trust, in plain words

- Everything runs on your computer. Sessions use your provider logins and API keys, so the usage is billed to your own account. Nothing is shared with the person who published the installer.
- **A paired device controls your computer.** It can start sessions in any folder, and an omp session runs shell commands, edits files and uses `git`, `gh` and your logins as you; the app can also read and edit repository files. Pair only devices you own. Treat a pairing link or QR code like a password: it works once and for 10 minutes, but whoever opens it first is paired.
- The relay in the middle only passes encrypted messages. The key never leaves the link's fragment.
- You trust whoever controls this fork, its Pages site and its release workflow, as with any `curl | sh`. To read the script first: `curl -fsSL https://ctrlc03.github.io/oh-my-pi/install.sh | less`. The installer refuses a binary whose checksum is missing or wrong, and, when `gh` is installed and signed in, one the release workflow did not build.

More detail on all of this: [Install for colleagues](../packages/collab-web/README.md#install-for-colleagues).
