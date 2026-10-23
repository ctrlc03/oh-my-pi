#!/bin/sh
# Installer for the fork's omp (with the collab companion) on macOS and Linux.
#
#   curl -fsSL https://ctrlc03.github.io/oh-my-pi/install.sh | sh
#   curl -fsSL https://ctrlc03.github.io/oh-my-pi/install.sh | sh -s -- --yes --no-login
#
# What it does (details: packages/collab-web/README.md, "Install"):
#   1. downloads the release binary for this OS and CPU plus SHA256SUMS.txt over HTTPS,
#      refuses to install anything whose checksum does not match, and, when the GitHub
#      CLI (`gh`) is installed and signed in, also verifies the build attestation;
#   2. installs it as <prefix>/omp (default ~/.local/bin/omp);
#   3. checks tmux, git and a browser opener (offers to install tmux);
#   4. sets collab.webUrl, runs `omp login` when no model provider is usable;
#   5. on a Mac or a Linux desktop session, offers the omp collab desktop app (a menu-bar / tray app that
#      runs this computer's companion and shows when a session needs you): the same release, checksum
#      verified, installed as ~/Applications/omp collab.app (macOS, which updates itself) or unpacked
#      into ~/.local/share/omp-collab/desktop with an applications-menu entry (Linux, where re-running
#      this installer is the update);
#   6. installs the companion as a background service (launchd / systemd user unit); the desktop app
#      attaches to it instead of starting its own;
#   7. opens the desktop app (without it: the pairing link in this computer's browser) and prints a QR code.
# Re-running updates in place. `--uninstall` removes the service and, on request, the binary and the desktop app.
#
# Questions are read from /dev/tty because stdin is the script itself when piped.
# Without a terminal every question is answered "no" unless --yes is given.
#
# Options:
#   -y, --yes             answer yes to every question (needs no terminal)
#       --no-login        do not run `omp login`
#       --no-service      do not install the background service
#       --desktop         install the desktop app without asking (macOS, Linux)
#       --no-desktop      do not offer the desktop app
#       --no-open         do not open the browser (the link and QR are still printed); without it the installer opens the app on this computer
#       --pair            show the pairing link and QR again on a re-run (always shown on a fresh install)
#       --prefix DIR      install DIR/omp (default: $PI_INSTALL_DIR or ~/.local/bin)
#       --tag TAG         install this release tag instead of the latest
#       --base-url URL    fetch SHA256SUMS.txt and omp-<os>-<arch> from URL (an https:// mirror)
#       --insecure-base-url  allow an http:// --base-url (local tests only: nothing is authenticated)
#       --web-url URL     set collab.webUrl to URL (default: this fork's GitHub Pages site)
#       --service-dry-run print the service definition instead of installing it
#       --uninstall       remove the service and (after asking) the binary
#   -h, --help            show this help
#
# Environment: PI_INSTALL_DIR, OMP_COLLAB_REPO (owner/name), OMP_COLLAB_BASE_URL,
# OMP_COLLAB_WEB_URL, OMP_COLLAB_DESKTOP_DIR (where the desktop app goes: the parent of "omp collab.app"
# on macOS, the app's own directory on Linux), NO_COLOR.

DEFAULT_REPO="ctrlc03/oh-my-pi"
DEFAULT_WEB_URL="https://ctrlc03.github.io/oh-my-pi/"

main() {
	set -eu

	BOLD="" RED="" YELLOW="" GREEN="" RESET=""
	REPO="${OMP_COLLAB_REPO:-$DEFAULT_REPO}"
	BASE_URL="${OMP_COLLAB_BASE_URL:-}"
	WEB_URL="${OMP_COLLAB_WEB_URL:-$DEFAULT_WEB_URL}"
	PREFIX="${PI_INSTALL_DIR:-}"
	TAG=""
	ASSUME_YES=0
	DO_LOGIN=1
	DO_SERVICE=1
	SERVICE_FAILED=0
	ALLOW_HTTP=0
	DO_OPEN=1
	FORCE_PAIR=0
	SERVICE_DRY_RUN=0
	UNINSTALL=0
	DO_DESKTOP=ask
	DESKTOP_READY=0
	DESKTOP_FAILED=0

	while [ $# -gt 0 ]; do
		case "$1" in
		-y | --yes) ASSUME_YES=1 ;;
		--no-login) DO_LOGIN=0 ;;
		--no-service) DO_SERVICE=0 ;;
		--desktop) DO_DESKTOP=1 ;;
		--no-desktop) DO_DESKTOP=0 ;;
		--no-open) DO_OPEN=0 ;;
		--pair) FORCE_PAIR=1 ;;
		--service-dry-run) SERVICE_DRY_RUN=1 ;;
		--uninstall) UNINSTALL=1 ;;
		--insecure-base-url) ALLOW_HTTP=1 ;;
		-h | --help)
			usage
			exit 0
			;;
		--prefix | --tag | --base-url | --web-url)
			[ $# -ge 2 ] && [ -n "$2" ] || die "missing value for $1"
			set_option "$1" "$2"
			shift
			;;
		--prefix=* | --tag=* | --base-url=* | --web-url=*)
			[ -n "${1#*=}" ] || die "missing value for ${1%%=*}"
			set_option "${1%%=*}" "${1#*=}"
			;;
		*) die "unknown option: $1 (see --help)" ;;
		esac
		shift
	done

	[ -n "${HOME:-}" ] || die "HOME is not set"
	[ -n "$PREFIX" ] || PREFIX="$HOME/.local/bin"
	PREFIX="${PREFIX%/}"
	OMP="$PREFIX/omp"
	# The companion finds omp through OMP_BIN; the prefix is often not on PATH.
	export OMP_BIN="$OMP"
	STATE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/omp-collab"
	STATE_FILE="$STATE_DIR/install"

	setup_output
	detect_tty

	if [ "$UNINSTALL" = 1 ]; then
		uninstall
		return 0
	fi

	detect_platform
	WORK=$(mktemp -d "${TMPDIR:-/tmp}/omp-install.XXXXXX") || die "cannot create a temporary directory"
	trap 'rm -rf "$WORK"' EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
	trap 'exit 129' HUP

	say "Installing the collab-enabled omp ($ASSET) into $PREFIX"
	confirm_install_target
	download_and_verify
	install_binary
	check_prerequisites
	configure_omp
	login_if_needed
	install_desktop
	if [ "$DO_SERVICE" = 1 ]; then
		install_service
	else
		note "Skipping the background service (--no-service). Start the companion yourself with: $OMP companion"
		pair_link "$("$OMP" companion --pair 2>&1 </dev/null || true)" "$FRESH"
	fi
	finish
	[ "$SERVICE_FAILED" = 0 ] && [ "$DESKTOP_FAILED" = 0 ] || return 1
}

# ── small helpers ────────────────────────────────────────────────────────────

usage() {
	cat <<'EOF'
Install the collab-enabled omp and its background companion.

  curl -fsSL https://ctrlc03.github.io/oh-my-pi/install.sh | sh -s -- [options]

Options:
  -y, --yes             answer yes to every question (needs no terminal)
      --no-login        do not run `omp login`
      --no-service      do not install the background service
      --desktop         install the desktop app (macOS, Linux) without asking
      --no-desktop      do not offer the desktop app
      --no-open         do not open the browser (the link and QR are still printed); without it the installer opens the app the companion serves on this computer
      --pair            show the pairing link and QR again on a re-run
      --prefix DIR      install DIR/omp (default: $PI_INSTALL_DIR or ~/.local/bin)
      --tag TAG         install this release tag instead of the latest
      --base-url URL    fetch SHA256SUMS.txt and omp-<os>-<arch> from this https:// URL
      --insecure-base-url  allow an http:// --base-url (local tests only)
      --web-url URL     set collab.webUrl to URL
      --service-dry-run print the service definition instead of installing it
      --uninstall       remove the service and (after asking) the binary
  -h, --help            show this help
EOF
}

set_option() {
	case "$1" in
	--prefix) PREFIX="$2" ;;
	--tag) TAG="$2" ;;
	--base-url) BASE_URL="$2" ;;
	--web-url) WEB_URL="$2" ;;
	esac
}

setup_output() {
	if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ]; then
		BOLD=$(printf '\033[1m')
		RED=$(printf '\033[31m')
		YELLOW=$(printf '\033[33m')
		GREEN=$(printf '\033[32m')
		RESET=$(printf '\033[0m')
	else
		BOLD="" RED="" YELLOW="" GREEN="" RESET=""
	fi
	if [ -t 2 ]; then
		PROGRESS=1
	else
		PROGRESS=0
	fi
}

say() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
ok() { printf '%s ok%s %s\n' "$GREEN" "$RESET" "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '%swarning:%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die() {
	printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2
	exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

# True when two paths name the same file, comparing directories with symlinks resolved.
same_file() {
	[ -e "$1" ] && [ -e "$2" ] || return 1
	_dir1=$(cd "$(dirname "$1")" && pwd -P) || return 1
	_dir2=$(cd "$(dirname "$2")" && pwd -P) || return 1
	[ "$_dir1/$(basename "$1")" = "$_dir2/$(basename "$2")" ]
}

# True when /dev/tty can be opened (stdin is the piped script, so questions go there).
detect_tty() {
	if ( : </dev/tty ) 2>/dev/null; then
		HAVE_TTY=1
	else
		HAVE_TTY=0
	fi
}

# ask QUESTION DEFAULT(y|n): returns 0 for yes. --yes answers yes; no terminal answers no.
ask() {
	[ "$ASSUME_YES" = 1 ] && return 0
	[ "$HAVE_TTY" = 1 ] || return 1
	case "$2" in
	y) _hint="[Y/n]" ;;
	*) _hint="[y/N]" ;;
	esac
	printf '%s %s ' "$1" "$_hint" >/dev/tty
	_answer=""
	IFS= read -r _answer </dev/tty || _answer=""
	case "$_answer" in
	[Yy]*) return 0 ;;
	[Nn]*) return 1 ;;
	"") [ "$2" = y ] ;;
	*) return 1 ;;
	esac
}

# ── platform ─────────────────────────────────────────────────────────────────

detect_os() {
	case "$(uname -s)" in
	Darwin) OS=darwin ;;
	Linux) OS=linux ;;
	*) die "unsupported OS $(uname -s): this installer supports macOS and Linux (on Windows, use WSL)" ;;
	esac
}

detect_platform() {
	detect_os
	case "$(uname -m)" in
	arm64 | aarch64) ARCH=arm64 ;;
	x86_64 | amd64) ARCH=x64 ;;
	*) die "unsupported CPU $(uname -m): releases exist for x64 and arm64" ;;
	esac
	# A shell running under Rosetta reports x86_64 on an Apple Silicon Mac.
	if [ "$OS" = darwin ] && [ "$ARCH" = x64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then
		ARCH=arm64
	fi
	# musl's ldd says so; a glibc system with musl-tools installed still reports glibc.
	if [ "$OS" = linux ] && have ldd && ldd --version 2>&1 | grep -qi musl; then
		die "this system uses musl libc (Alpine); the collab release is built for glibc distributions only"
	fi
	ASSET="omp-$OS-$ARCH"
	case "$OS" in
	darwin) DESKTOP_ASSET="collab-desktop-$OS-$ARCH.zip" ;;
	*) DESKTOP_ASSET="collab-desktop-$OS-$ARCH.tar.gz" ;;
	esac
	CUSTOM_BASE=1
	if [ -z "$BASE_URL" ]; then
		CUSTOM_BASE=0
		if [ -n "$TAG" ]; then
			BASE_URL="https://github.com/$REPO/releases/download/$TAG"
		else
			BASE_URL="https://github.com/$REPO/releases/latest/download"
		fi
	fi
	BASE_URL="${BASE_URL%/}"
	case "$BASE_URL" in
	https://*) ;;
	http://*)
		[ "$ALLOW_HTTP" = 1 ] || die "refusing $BASE_URL: downloads must use https:// (--insecure-base-url allows http for local tests)"
		warn "using a plain-http download source; nothing is authenticated"
		;;
	*) die "--base-url must start with https://" ;;
	esac
}

# ── download and verify ──────────────────────────────────────────────────────

# HTTPS only, also across redirects, unless --insecure-base-url.
fetch() {
	_url="$1"
	_out="$2"
	if have curl; then
		if [ "$ALLOW_HTTP" = 1 ]; then
			set -- --proto '=http,https' --proto-redir '=http,https'
		else
			set -- --proto '=https' --proto-redir '=https' --tlsv1.2
		fi
		if [ "$PROGRESS" = 1 ] && [ "${_out##*/}" = "$ASSET" ]; then
			curl "$@" -fL --retry 3 --connect-timeout 20 --progress-bar -o "$_out" "$_url" </dev/null
		else
			curl "$@" -fsSL --retry 3 --connect-timeout 20 -o "$_out" "$_url" </dev/null
		fi
	elif have wget; then
		if [ "$ALLOW_HTTP" = 1 ]; then
			wget -q -O "$_out" "$_url" </dev/null
		else
			wget -q --https-only -O "$_out" "$_url" </dev/null
		fi
	else
		die "curl or wget is required"
	fi
}

sha256_of() {
	if have sha256sum; then
		sha256sum "$1" | awk '{print $1}'
	elif have shasum; then
		shasum -a 256 "$1" | awk '{print $1}'
	elif have openssl; then
		openssl dgst -sha256 "$1" | awk '{print $NF}'
	else
		die "no sha256 tool found (need sha256sum, shasum or openssl); refusing to install an unverified binary"
	fi
}

download_and_verify() {
	say "Downloading from $BASE_URL"
	fetch "$BASE_URL/SHA256SUMS.txt" "$WORK/SHA256SUMS.txt" || die "could not download $BASE_URL/SHA256SUMS.txt"
	fetch "$BASE_URL/$ASSET" "$WORK/$ASSET" || die "could not download $BASE_URL/$ASSET"

	expected_sha256 "$ASSET" || die "$EXPECTED_ERR"
	NEW_SHA=$(sha256_of "$WORK/$ASSET")
	if [ "$NEW_SHA" != "$EXPECTED_SHA" ]; then
		die "checksum mismatch for $ASSET (expected $EXPECTED_SHA, got $NEW_SHA); nothing was installed"
	fi
	ok "checksum verified ($NEW_SHA)"
	verify_attestation "$WORK/$ASSET" "$ASSET" || die "build attestation check failed for $ASSET; nothing was installed"
}

# expected_sha256 NAME: sets EXPECTED_SHA to the checksum SHA256SUMS.txt lists for NAME (lower case) and returns 0;
# otherwise sets EXPECTED_ERR and returns 1.
expected_sha256() {
	EXPECTED_SHA=$(awk -v f="$1" '$2 == f || $2 == "*" f { print $1; exit }' "$WORK/SHA256SUMS.txt")
	if [ -z "$EXPECTED_SHA" ]; then
		EXPECTED_ERR="SHA256SUMS.txt has no entry for $1; refusing to install"
		return 1
	fi
	case "$EXPECTED_SHA" in
	*[!0-9a-fA-F]*) EXPECTED_SHA="" ;;
	esac
	if [ "${#EXPECTED_SHA}" -ne 64 ]; then
		EXPECTED_ERR="SHA256SUMS.txt has a malformed entry for $1; refusing to install"
		return 1
	fi
	EXPECTED_SHA=$(printf '%s' "$EXPECTED_SHA" | tr 'A-F' 'a-f')
}

# verify_attestation FILE NAME: the checksum only proves FILE matches SHA256SUMS.txt, which comes from the same
# release. A build attestation ties the asset to this repository's release workflow, so a hand-uploaded
# asset fails. It needs the GitHub CLI, signed in; without it the checksum is all there is.
# Returns 1 when the attestation does not verify.
verify_attestation() {
	if [ "$CUSTOM_BASE" = 1 ]; then
		note "custom download source: skipping the build attestation check"
		return 0
	fi
	if ! have gh; then
		note "build attestation not checked (GitHub CLI 'gh' not installed); the checksum is the only integrity check"
		return 0
	fi
	if ! gh auth status >/dev/null 2>&1 </dev/null; then
		note "build attestation not checked ('gh' is not signed in: run 'gh auth login' and re-run to verify it)"
		return 0
	fi
	if gh attestation verify "$1" --repo "$REPO" --signer-workflow "$REPO/.github/workflows/collab-release.yml" >"$WORK/attestation.out" 2>&1 </dev/null; then
		ok "build attestation verified ($2 built by $REPO's collab release workflow)"
	else
		cat "$WORK/attestation.out" >&2
		return 1
	fi
}

# ── installing the binary ────────────────────────────────────────────────────

# Reads the state file: sets RECORDED_PATH and RECORDED_SHA (empty when absent), and the desktop app's
# RECORDED_DESKTOP_PATH and RECORDED_DESKTOP_SHA.
read_state() {
	RECORDED_PATH="" RECORDED_SHA="" RECORDED_DESKTOP_PATH="" RECORDED_DESKTOP_SHA=""
	if [ -f "$STATE_FILE" ]; then
		RECORDED_PATH=$(sed -n 's/^path=//p' "$STATE_FILE" | sed -n '1p')
		RECORDED_SHA=$(sed -n 's/^sha256=//p' "$STATE_FILE" | sed -n '1p')
		RECORDED_DESKTOP_PATH=$(sed -n 's/^desktop_path=//p' "$STATE_FILE" | sed -n '1p')
		RECORDED_DESKTOP_SHA=$(sed -n 's/^desktop_sha256=//p' "$STATE_FILE" | sed -n '1p')
	fi
	DESKTOP_PATH="$RECORDED_DESKTOP_PATH" DESKTOP_SHA="$RECORDED_DESKTOP_SHA"
}

# Another omp must not be replaced silently, and an omp elsewhere on PATH is worth a word.
confirm_install_target() {
	read_state
	FRESH=1
	[ "$RECORDED_PATH" = "$OMP" ] && [ -x "$OMP" ] && FRESH=0

	if [ -e "$OMP" ] && [ "$RECORDED_PATH" != "$OMP" ]; then
		_current=$("$OMP" --version 2>/dev/null </dev/null | sed -n '1p' || true)
		warn "$OMP already exists and was not installed by this installer${_current:+ (reports: $_current)}."
		if ! ask "Replace it with the collab-enabled omp?" n; then
			if [ "$HAVE_TTY" != 1 ] && [ "$ASSUME_YES" != 1 ]; then
				die "not replacing $OMP without confirmation (no terminal to ask on; re-run with --yes to replace it, or --prefix to install elsewhere)"
			fi
			die "left $OMP alone; nothing was installed (use --prefix to install elsewhere)"
		fi
	fi

	_other=$(command -v omp 2>/dev/null || true)
	if [ -n "$_other" ] && ! same_file "$_other" "$OMP"; then
		warn "another omp is on your PATH: $_other"
		note "It is not touched. Whichever directory comes first in PATH decides which one"
		note "'omp' runs in a terminal; the background service always uses $OMP."
		if [ "$FRESH" = 1 ] && ! ask "Install the collab-enabled omp next to it?" y; then
			if [ "$HAVE_TTY" != 1 ] && [ "$ASSUME_YES" != 1 ]; then
				die "not installing next to $_other without confirmation (no terminal to ask on; re-run with --yes)"
			fi
			die "nothing was installed"
		fi
	fi
}

# write_state: records what this installer put where (omp, and the desktop app when there is one).
write_state() {
	mkdir -p "$STATE_DIR"
	printf 'path=%s\nsha256=%s\nsource=%s\n' "$OMP" "$NEW_SHA" "$BASE_URL" >"$STATE_FILE"
	if [ -n "${DESKTOP_PATH:-}" ]; then
		printf 'desktop_path=%s\ndesktop_sha256=%s\n' "$DESKTOP_PATH" "${DESKTOP_SHA:-}" >>"$STATE_FILE"
	fi
}

install_binary() {
	mkdir -p "$PREFIX" || die "cannot create $PREFIX"
	[ -w "$PREFIX" ] || die "$PREFIX is not writable (choose another directory with --prefix)"
	_staged="$PREFIX/.omp.new.$$"
	cp "$WORK/$ASSET" "$_staged" || die "cannot write into $PREFIX"
	chmod 755 "$_staged"
	# A rename replaces the file atomically; a running omp keeps its old inode.
	mv -f "$_staged" "$OMP" || {
		rm -f "$_staged"
		die "cannot replace $OMP"
	}
	write_state

	_version=$("$OMP" --version 2>/dev/null </dev/null | sed -n '1p' || true)
	[ -n "$_version" ] || die "$OMP does not run on this system (--version failed); the binary was installed but is unusable"
	if [ "$FRESH" = 1 ]; then
		ok "installed $OMP ($_version)"
	elif [ "$RECORDED_SHA" = "$NEW_SHA" ]; then
		ok "$OMP is already the latest release ($_version)"
	else
		ok "updated $OMP ($_version)"
	fi
}

# ── prerequisites ────────────────────────────────────────────────────────────

# Prints the command that installs PACKAGE here, or nothing when no package manager is known.
package_install_command() {
	if have brew; then
		printf 'brew install %s' "$1"
	elif have apt-get; then
		printf '%sapt-get install -y %s' "$(sudo_prefix)" "$1"
	elif have dnf; then
		printf '%sdnf install -y %s' "$(sudo_prefix)" "$1"
	elif have yum; then
		printf '%syum install -y %s' "$(sudo_prefix)" "$1"
	elif have pacman; then
		printf '%spacman -S --noconfirm %s' "$(sudo_prefix)" "$1"
	elif have zypper; then
		printf '%szypper install -y %s' "$(sudo_prefix)" "$1"
	elif have apk; then
		printf '%sapk add %s' "$(sudo_prefix)" "$1"
	fi
}

sudo_prefix() {
	if [ "$(id -u)" != 0 ] && have sudo; then
		printf 'sudo '
	fi
}

human_install_command() {
	# What to show people: the apt/dnf spelling without -y.
	case "$1" in
	*apt-get*) printf '%s' "$1" | sed 's/apt-get install -y/apt install/' ;;
	*dnf* | *yum*) printf '%s' "$1" | sed 's/ -y / /' ;;
	*) printf '%s' "$1" ;;
	esac
}

ensure_package() { # binary package why
	have "$1" && {
		ok "$1 found"
		return 0
	}
	_cmd=$(package_install_command "$2")
	if [ -z "$_cmd" ]; then
		warn "$1 is missing ($3) and no package manager was found; install $2 yourself."
		return 0
	fi
	warn "$1 is missing: $3"
	note "install it with: $(human_install_command "$_cmd")"
	if ask "Run '$_cmd' now?" y; then
		case "$_cmd" in
		*apt-get*)
			# A fresh image has no package lists; a failed refresh is not fatal.
			if [ -n "$(sudo_prefix)" ]; then
				sudo apt-get update </dev/null || true
			else
				apt-get update </dev/null || true
			fi
			;;
		esac
		# shellcheck disable=SC2086 # the command is a fixed word list built above
		if $_cmd </dev/null; then
			have "$1" && ok "$1 installed" && return 0
		fi
		warn "installing $2 did not work; install it yourself, then re-run this installer."
	else
		note "skipped; re-run the installer or install it yourself later."
	fi
}

check_prerequisites() {
	say "Checking tools"
	ensure_package tmux tmux "starting sessions from the app and other vendors' agents need it"
	if have git; then
		ok "git found"
	elif [ "$OS" = darwin ]; then
		warn "git is missing: the app's git features need it. Install it with: xcode-select --install"
	else
		ensure_package git git "the app's git features need it"
	fi
	if [ "$OS" = darwin ]; then
		OPENER=open
	elif have xdg-open; then
		OPENER=xdg-open
	else
		OPENER=""
		note "no browser opener (xdg-open) found; the pairing link will be printed instead of opened"
	fi
}

# ── configuration, login, service ────────────────────────────────────────────

configure_omp() {
	say "Pointing omp at the web app ($WEB_URL)"
	"$OMP" config set collab.webUrl "$WEB_URL" </dev/null >/dev/null || die "could not set collab.webUrl (omp config set failed)"
	ok "collab.webUrl set"
}

# True when at least one model can be used (an API key or a login).
has_usable_model() {
	"$OMP" models --json --no-extensions 2>/dev/null </dev/null | grep -q '"id"'
}

login_if_needed() {
	[ "$DO_LOGIN" = 1 ] || {
		note "skipping login (--no-login); run '$OMP login' before starting sessions"
		return 0
	}
	if has_usable_model; then
		ok "a model provider is already set up"
		return 0
	fi
	say "No model provider is logged in"
	if [ "$HAVE_TTY" != 1 ]; then
		warn "no terminal to log in on. Run '$OMP login' yourself; sessions cannot work until you do."
		return 0
	fi
	if ask "Log in to a provider now? (sessions the app starts use this login)" y; then
		"$OMP" login </dev/tty || warn "login did not finish; run '$OMP login' again before starting sessions"
	else
		note "skipped; run '$OMP login' before starting sessions"
	fi
}

# ── desktop app ──────────────────────────────────────────────────────────────
#
# macOS: a signed bundle, ~/Applications/omp collab.app. Linux: a tarball unpacked into one directory
# (~/.local/share/omp-collab/desktop), started through its launcher, with an applications-menu entry.

DESKTOP_APP_NAME="omp collab.app"
DESKTOP_BUNDLE_ID="sh.omp.collab.desktop"
DESKTOP_LINUX_EXE="omp-collab"
DESKTOP_LINUX_LAUNCHER="omp-collab-launch"
DESKTOP_LINUX_ENTRY="omp-collab.desktop"

desktop_default_dir() {
	if [ "$OS" = linux ]; then
		printf '%s' "${OMP_COLLAB_DESKTOP_DIR:-$STATE_DIR/desktop}"
	else
		printf '%s' "${OMP_COLLAB_DESKTOP_DIR:-$HOME/Applications}"
	fi
}

linux_applications_dir() { printf '%s' "${XDG_DATA_HOME:-$HOME/.local/share}/applications"; }
linux_autostart_dir() { printf '%s' "${XDG_CONFIG_HOME:-$HOME/.config}/autostart"; }

# plist_value APP KEY: a value of the app's Info.plist (empty when unreadable).
plist_value() { /usr/bin/plutil -extract "$2" raw -o - "$1/Contents/Info.plist" 2>/dev/null || true; }

# desktop_running APP: the app at APP is running (its own executable, not any copy elsewhere).
desktop_running() {
	if [ "$OS" = darwin ]; then
		ps -axo command= 2>/dev/null | awk -v exe="$1/Contents/MacOS/${DESKTOP_APP_NAME%.app}" 'index($0, exe) == 1 { found = 1 } END { exit !found }'
	else
		# The launcher execs the executable by its real path; a match must end there (the launcher's own name starts the same).
		_real=$(cd "$1" 2>/dev/null && pwd -P) || _real="$1"
		ps -A -o args= 2>/dev/null | awk -v exe="$_real/$DESKTOP_LINUX_EXE" 'index($0, exe) == 1 { after = substr($0, length(exe) + 1, 1); if (after == "" || after == " ") found = 1 } END { exit !found }'
	fi
}

# True with a desktop session: not over ssh, and on a Mac launchd says this is a GUI (Aqua) session, on Linux
# an X11 or Wayland display is set.
has_desktop_session() {
	[ -z "${SSH_CONNECTION:-}" ] || return 1
	if [ "$OS" = darwin ]; then
		_session=$(launchctl managername 2>/dev/null || true)
		[ -z "$_session" ] || [ "$_session" = Aqua ]
	else
		[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]
	fi
}

# Where the app goes. macOS: where this installer put it before, a copy in /Applications (from the disk image)
# that this user can replace, else ~/Applications. Linux: where this installer put it before, else the default.
desktop_target() {
	if [ -n "$RECORDED_DESKTOP_PATH" ] && [ -d "$RECORDED_DESKTOP_PATH" ]; then
		printf '%s' "$RECORDED_DESKTOP_PATH"
	elif [ "$OS" = linux ]; then
		desktop_default_dir
	elif [ -z "${OMP_COLLAB_DESKTOP_DIR:-}" ] && [ -d "/Applications/$DESKTOP_APP_NAME" ] && [ -w /Applications ]; then
		printf '/Applications/%s' "$DESKTOP_APP_NAME"
	else
		printf '%s/%s' "$(desktop_default_dir)" "$DESKTOP_APP_NAME"
	fi
}

desktop_fail() {
	warn "$1"
	note "the desktop app was not installed; omp itself is installed and works without it (re-run to try again)"
	DESKTOP_FAILED=1
}

# desktop_exec_quote PATH: PATH as one argument of a desktop entry's Exec line (double-quoted; ", `, $ and \ escaped
# with a backslash, and every backslash doubled again by the file's own string escaping; % doubled).
desktop_exec_quote() {
	printf '"%s"' "$(printf '%s' "$1" | sed -e 's/%/%%/g' -e 's/[\\"`$]/\\&/g' -e 's/\\/\\\\/g')"
}

# write_desktop_entry APP: the applications-menu entry (Linux), replaced atomically.
write_desktop_entry() {
	_apps=$(linux_applications_dir)
	mkdir -p "$_apps" || return 1
	_entry="$_apps/$DESKTOP_LINUX_ENTRY"
	_tmp="$_entry.new.$$"
	{
		printf '[Desktop Entry]\nType=Application\nName=omp collab\n'
		printf 'Comment=Runs the omp collab companion on this computer and shows when a session needs you\n'
		printf 'Exec=%s\n' "$(desktop_exec_quote "$1/$DESKTOP_LINUX_LAUNCHER")"
		printf 'Icon=%s/resources/icon.png\nTerminal=false\nCategories=Development;\nStartupWMClass=omp-collab\n' "$1"
	} >"$_tmp" || return 1
	mv -f "$_tmp" "$_entry" || {
		rm -f "$_tmp"
		return 1
	}
}

# remove_desktop_entries: the applications-menu entry and the Open at Login entry (Linux), when they are the app's.
remove_desktop_entries() {
	for _file in "$(linux_applications_dir)/$DESKTOP_LINUX_ENTRY" "$(linux_autostart_dir)/$DESKTOP_LINUX_ENTRY"; do
		if [ -f "$_file" ] && grep -q "^Exec=.*$DESKTOP_LINUX_LAUNCHER" "$_file" 2>/dev/null; then
			rm -f "$_file"
		fi
	done
}

# warn_missing_libs APP: Electron needs system libraries (GTK, NSS, ALSA...); a missing one makes the app exit at
# start with no window, so say so now. Never fails the install.
warn_missing_libs() {
	have ldd || return 0
	_missing=$(ldd "$1/$DESKTOP_LINUX_EXE" 2>/dev/null </dev/null | awk '/not found/ { printf "%s ", $1 }')
	if [ -n "$_missing" ]; then
		warn "the desktop app will not start until these libraries are installed: ${_missing% }"
		note "On Debian/Ubuntu: sudo apt install libgtk-3-0 libasound2 libnss3 libgbm1 libxss1 (libgtk-3-0t64 and libasound2t64 on 24.04); on Fedora: sudo dnf install gtk3 alsa-lib nss mesa-libgbm libXScrnSaver"
	fi
}

# desktop_unpack STAGE: unpacks the verified download into STAGE and sets _new to the app inside it. Returns 1
# with DESKTOP_ERR set when it will not unpack or is not the omp collab app.
desktop_unpack() {
	if [ "$OS" = darwin ]; then
		if ! ditto -x -k "$WORK/$DESKTOP_ASSET" "$1" || [ ! -d "$1/$DESKTOP_APP_NAME" ]; then
			DESKTOP_ERR="could not unpack $DESKTOP_ASSET"
			return 1
		fi
		_new="$1/$DESKTOP_APP_NAME"
		if [ "$(plist_value "$_new" CFBundleIdentifier)" != "$DESKTOP_BUNDLE_ID" ]; then
			DESKTOP_ERR="$DESKTOP_ASSET does not hold the omp collab app"
			return 1
		fi
		if have codesign && ! codesign --verify --deep --strict "$_new" >"$WORK/codesign.out" 2>&1; then
			cat "$WORK/codesign.out" >&2
			DESKTOP_ERR="the app's signature does not verify"
			return 1
		fi
	else
		_new="$1/app"
		mkdir "$_new"
		# The archive holds one top-level directory named after itself.
		if ! tar -xzf "$WORK/$DESKTOP_ASSET" -C "$_new" --strip-components=1; then
			DESKTOP_ERR="could not unpack $DESKTOP_ASSET"
			return 1
		fi
		if [ ! -x "$_new/$DESKTOP_LINUX_EXE" ] || [ ! -x "$_new/$DESKTOP_LINUX_LAUNCHER" ] || [ ! -f "$_new/resources/app.asar" ]; then
			DESKTOP_ERR="$DESKTOP_ASSET does not hold the omp collab app"
			return 1
		fi
	fi
}

# Offers (or, with --desktop, just does) the desktop app: the same checksum and attestation checks as the omp
# binary, then an atomic swap of the app. On macOS the bundle is signed ad hoc, which macOS accepts when the
# download did not come from a browser (curl sets no quarantine flag). On Linux the unpacked app gets an
# applications-menu entry, and its launcher decides whether Chromium's sandbox can run. A failure here never
# undoes the omp install.
install_desktop() {
	[ "$DO_DESKTOP" != 0 ] || return 0
	if [ "$DO_DESKTOP" = ask ] && ! has_desktop_session; then
		return 0
	fi
	if ! awk -v f="$DESKTOP_ASSET" '$2 == f || $2 == "*" f { found = 1 } END { exit !found }' "$WORK/SHA256SUMS.txt"; then
		if [ "$DO_DESKTOP" = 1 ]; then
			warn "this release has no desktop app for $OS-$ARCH ($DESKTOP_ASSET is not in SHA256SUMS.txt); skipping it"
		else
			note "this release has no desktop app for $OS-$ARCH; skipping it"
		fi
		return 0
	fi
	_dest=$(desktop_target)
	say "The omp collab desktop app"
	if [ "$DO_DESKTOP" = ask ]; then
		if [ "$OS" = darwin ]; then
			note "A menu-bar app: it runs this computer's companion, tells you when a session needs your input, and updates itself."
		else
			note "A tray app: it runs this computer's companion and tells you when a session needs your input. Re-run this installer to update it."
		fi
		if ! ask "Install it as $_dest?" y; then
			note "skipped; add it later with: curl -fsSL ${WEB_URL%/}/install.sh | sh -s -- --desktop"
			return 0
		fi
	fi
	fetch "$BASE_URL/$DESKTOP_ASSET" "$WORK/$DESKTOP_ASSET" || {
		desktop_fail "could not download $BASE_URL/$DESKTOP_ASSET"
		return 0
	}
	if ! expected_sha256 "$DESKTOP_ASSET"; then
		desktop_fail "$EXPECTED_ERR"
		return 0
	fi
	_have=$(sha256_of "$WORK/$DESKTOP_ASSET")
	if [ "$_have" != "$EXPECTED_SHA" ]; then
		desktop_fail "checksum mismatch for $DESKTOP_ASSET (expected $EXPECTED_SHA, got $_have)"
		return 0
	fi
	ok "checksum verified ($_have)"
	verify_attestation "$WORK/$DESKTOP_ASSET" "$DESKTOP_ASSET" || {
		desktop_fail "build attestation check failed for $DESKTOP_ASSET"
		return 0
	}
	DESKTOP_APP="$_dest"
	if [ -d "$_dest" ] && [ "$RECORDED_DESKTOP_PATH" = "$_dest" ] && [ "$RECORDED_DESKTOP_SHA" = "$_have" ]; then
		[ "$OS" != linux ] || write_desktop_entry "$_dest" || warn "could not write the applications-menu entry"
		ok "$_dest is already the latest release"
		DESKTOP_READY=1
		return 0
	fi
	if [ -d "$_dest" ] && desktop_running "$_dest"; then
		warn "omp collab is running, so $_dest was not replaced; quit it and run the installer again to update"
		DESKTOP_READY=1
		return 0
	fi
	_dir=$(dirname "$_dest")
	if ! { mkdir -p "$_dir" 2>/dev/null && [ -w "$_dir" ]; }; then
		desktop_fail "$_dir is not writable"
		return 0
	fi
	_stage="$_dir/.omp-collab-update.$$"
	rm -rf "$_stage"
	mkdir "$_stage"
	if ! desktop_unpack "$_stage"; then
		rm -rf "$_stage"
		desktop_fail "$DESKTOP_ERR"
		return 0
	fi
	if [ -e "$_dest" ]; then
		rm -rf "$_dest.old"
		mv "$_dest" "$_dest.old" || {
			rm -rf "$_stage"
			desktop_fail "cannot replace $_dest"
			return 0
		}
	fi
	if ! mv "$_new" "$_dest"; then
		[ ! -e "$_dest.old" ] || mv "$_dest.old" "$_dest"
		rm -rf "$_stage"
		desktop_fail "cannot install $_dest"
		return 0
	fi
	rm -rf "$_dest.old" "$_stage"
	if [ "$OS" = darwin ]; then
		xattr -dr com.apple.quarantine "$_dest" 2>/dev/null || true
	else
		write_desktop_entry "$_dest" || warn "could not write the applications-menu entry; start the app with $_dest/$DESKTOP_LINUX_LAUNCHER"
		warn_missing_libs "$_dest"
	fi
	DESKTOP_PATH="$_dest"
	DESKTOP_SHA="$_have"
	DESKTOP_READY=1
	write_state
	ok "installed $_dest"
}

# Starts the desktop app and returns 0 once it is up (Linux: still running after two seconds, or handed over to
# the instance that already runs).
open_desktop() {
	if [ "$OS" = darwin ]; then
		"$OPENER" "$DESKTOP_APP" >/dev/null 2>&1 </dev/null
		return
	fi
	if have setsid; then
		setsid "$DESKTOP_APP/$DESKTOP_LINUX_LAUNCHER" >"$WORK/desktop-open.out" 2>&1 </dev/null &
	else
		nohup "$DESKTOP_APP/$DESKTOP_LINUX_LAUNCHER" >"$WORK/desktop-open.out" 2>&1 </dev/null &
	fi
	_pid=$!
	_polls=0
	while [ "$_polls" -lt 10 ]; do
		# Gone already: it handed over to the running instance (exit 0) or failed to start.
		kill -0 "$_pid" 2>/dev/null || {
			wait "$_pid"
			return
		}
		sleep 0.2
		_polls=$((_polls + 1))
	done
	return 0
}

# True when this installer can open the desktop app now (macOS: the opener exists; Linux: there is a display).
can_open_desktop() {
	if [ "$OS" = darwin ]; then
		[ -n "${OPENER:-}" ]
	else
		[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]
	fi
}

# Offers to delete the desktop app on --uninstall. Sets DESKTOP_KEPT to its path when it stays.
uninstall_desktop() {
	DESKTOP_KEPT=""
	if [ "$OS" = darwin ]; then
		_app="${RECORDED_DESKTOP_PATH:-$(desktop_default_dir)/$DESKTOP_APP_NAME}"
		[ -d "$_app" ] || return 0
		if [ "$(plist_value "$_app" CFBundleIdentifier)" != "$DESKTOP_BUNDLE_ID" ]; then
			warn "$_app is not the omp collab desktop app; leaving it alone"
			return 0
		fi
	else
		_app="${RECORDED_DESKTOP_PATH:-$(desktop_default_dir)}"
		[ -d "$_app" ] || return 0
		if [ ! -x "$_app/$DESKTOP_LINUX_EXE" ] || [ ! -f "$_app/resources/app.asar" ]; then
			warn "$_app is not the omp collab desktop app; leaving it alone"
			return 0
		fi
	fi
	if desktop_running "$_app"; then
		warn "omp collab is running; quit it and run the uninstall again to delete $_app"
		DESKTOP_KEPT="$_app"
	elif ask "Delete the desktop app $_app?" n; then
		rm -rf "$_app" || die "cannot delete $_app"
		ok "deleted $_app"
		if [ "$OS" = darwin ]; then
			note "Kept: its settings and logs in ~/Library/Application Support/omp collab (and an 'Open at Login' entry, which macOS drops once the app is gone)."
		else
			remove_desktop_entries
			note "Removed: its applications-menu entry and its Open at Login entry. Kept: its settings and logs in ${XDG_CONFIG_HOME:-~/.config}/omp collab."
		fi
	else
		note "kept $_app"
		DESKTOP_KEPT="$_app"
	fi
}

install_service() {
	say "Installing the companion as a background service"
	_out="$WORK/companion.out"
	if [ "$SERVICE_DRY_RUN" = 1 ]; then
		"$OMP" companion --install --dry-run >"$_out" 2>&1 </dev/null || true
		cat "$_out"
		return 0
	fi
	if ! "$OMP" companion --install >"$_out" 2>&1 </dev/null; then
		cat "$_out" >&2
		warn "'$OMP companion --install' failed, so there is no background service yet."
		note "Fix the problem above and re-run this installer, or run the companion by hand: $OMP companion"
		SERVICE_FAILED=1
		pair_link "$("$OMP" companion --pair 2>&1 </dev/null || true)" "$FRESH"
		return 0
	fi
	ok "service installed"
	pair_link "$(cat "$_out")" "$FRESH"
}

# local_link TRIES: print the link that pairs a browser on this computer with the companion's own copy of the
# app (omp companion --print-local-link), waiting up to TRIES seconds for a service that was just started.
# Fails when the companion is not running or serves no app (--no-local-app, or a build without one).
local_link() {
	_tries="$1"
	while :; do
		_link=$("$OMP" companion --print-local-link 2>/dev/null </dev/null | grep -o 'http://[^ ]*#pair:[^ ]*' | sed -n '1p' || true)
		if [ -n "$_link" ]; then
			printf '%s\n' "$_link"
			return 0
		fi
		[ "$_tries" -gt 1 ] || return 1
		_tries=$((_tries - 1))
		sleep 1
	done
}

# pair_link COMPANION_OUTPUT SHOW: print the QR block and, on a fresh install, open the browser on this computer.
# The printed link and QR code (the public app) are for a phone; the browser here opens the companion's own
# copy of the app over loopback when it serves one, and the public link otherwise.
pair_link() {
	PAIR_OUTPUT="$1"
	_show="$2"
	[ "$FORCE_PAIR" = 1 ] && _show=1
	if [ "$_show" != 1 ]; then
		note "this computer is already paired from an earlier install; run '$OMP companion --pair' for a new link"
		return 0
	fi
	PAIR_URL=$(printf '%s\n' "$PAIR_OUTPUT" | grep -o 'https\{0,1\}://[^ ]*#pair:[^ ]*' | sed -n '1p' || true)
	if [ -z "$PAIR_URL" ]; then
		PAIR_OUTPUT=$("$OMP" companion --pair 2>&1 </dev/null || true)
		PAIR_URL=$(printf '%s\n' "$PAIR_OUTPUT" | grep -o 'https\{0,1\}://[^ ]*#pair:[^ ]*' | sed -n '1p' || true)
	fi
	if [ -z "$PAIR_URL" ]; then
		warn "could not read a pairing link; run '$OMP companion --pair' to print one"
		return 0
	fi
	say "Pair a device"
	printf '%s\n' "$PAIR_OUTPUT"
	if [ "$DO_OPEN" = 1 ] && [ "$DESKTOP_READY" = 1 ] && can_open_desktop; then
		# The app finds the companion (the service just started), starts one when there is none, and pairs its own window.
		if open_desktop; then
			OPENED=desktop
			note "opened the omp collab desktop app (it pairs itself with this computer's companion)"
		else
			cat "$WORK/desktop-open.out" >&2 2>/dev/null || true
			warn "could not open the desktop app; open $DESKTOP_APP yourself"
		fi
	elif [ "$DO_OPEN" = 1 ] && [ -n "${OPENER:-}" ]; then
		_tries=1
		[ "$DO_SERVICE" = 1 ] && [ "$SERVICE_FAILED" = 0 ] && _tries=15
		if _local=$(local_link "$_tries"); then
			OPEN_URL="$_local"
			OPENED=local
		else
			OPEN_URL="$PAIR_URL"
			OPENED=public
		fi
		if "$OPENER" "$OPEN_URL" >/dev/null 2>&1 </dev/null; then
			if [ "$OPENED" = local ]; then
				note "opened the app on this computer (served by the companion over loopback, no internet needed)"
			else
				note "opened the app at $WEB_URL"
			fi
		else
			OPENED=""
			warn "could not open the browser; open the link above yourself"
		fi
	else
		note "open the link above in a browser, or scan the QR code with your phone"
	fi
}

finish() {
	_found=$(command -v omp 2>/dev/null || true)
	if [ -n "$_found" ] && same_file "$_found" "$OMP"; then
		:
	else
		case ":$PATH:" in
		*":$PREFIX:"*) ;;
		*)
			say "Add omp to your PATH"
			note "export PATH=\"$PREFIX:\$PATH\"   # put this in your shell profile"
			;;
		esac
	fi
	say "Done. What to do next"
	if [ "${OPENED:-}" = desktop ]; then
		if [ "$OS" = darwin ]; then
			note "Open the app:   the omp collab window this installer opened; open it again from $DESKTOP_APP or Spotlight."
		else
			note "Open the app:   the omp collab window this installer opened; open it again from your applications menu ('omp collab')"
			note "                or with $DESKTOP_APP/$DESKTOP_LINUX_LAUNCHER."
		fi
		note "                On a phone use $WEB_URL (pair it below)."
	elif [ "${OPENED:-}" = local ]; then
		note "Open the app:   the browser tab this installer opened is the app on this computer, served by the"
		note "                companion. Open it again with '$OMP companion --open'."
		note "                On a phone use $WEB_URL (pair it below)."
	elif [ "${OPENED:-}" = public ]; then
		note "Open the app:   $WEB_URL (opened paired with this computer)"
	else
		note "Open the app:   '$OMP companion --open' opens the copy the companion serves on this computer;"
		note "                $WEB_URL works from any device."
	fi
	note "Pair a phone:   run '$OMP companion --pair' and scan the QR code it prints."
	note "                The link and QR code work like a password: a paired device controls this computer."
	if [ "$DO_SERVICE" = 1 ] && [ "$SERVICE_FAILED" = 0 ] && [ "$SERVICE_DRY_RUN" = 0 ]; then
		if [ "$OS" = darwin ]; then
			note "Logs:           ~/Library/Logs/omp-collab-companion.log"
		else
			note "Logs:           journalctl --user -u omp-collab-companion -f"
		fi
	fi
	if [ "$DESKTOP_READY" = 1 ]; then
		if [ "$OS" = darwin ]; then
			note "Desktop app:    $DESKTOP_APP (its menu has 'Open at Login'; it keeps itself up to date)."
		else
			note "Desktop app:    $DESKTOP_APP (its menu has 'Open at Login'; run the install command again to update it)."
		fi
	fi
	note "Update:         run the install command again"
	note "Uninstall:      curl -fsSL ${WEB_URL%/}/install.sh | sh -s -- --uninstall"
	[ "$SERVICE_FAILED" = 0 ] || note "The background service is NOT installed (see above)."
	[ "$DESKTOP_FAILED" = 0 ] || note "The desktop app is NOT installed (see above)."
}

# ── uninstall ────────────────────────────────────────────────────────────────

uninstall() {
	detect_os
	read_state
	if [ -n "$RECORDED_PATH" ]; then
		OMP="$RECORDED_PATH"
		export OMP_BIN="$OMP"
	fi
	say "Uninstalling the collab-enabled omp"
	if [ -x "$OMP" ]; then
		if "$OMP" companion --uninstall </dev/null; then
			ok "background service removed"
		else
			warn "'$OMP companion --uninstall' failed; the service may still be installed"
		fi
	else
		warn "$OMP not found, so the background service cannot be removed by this script"
		note "macOS: launchctl bootout gui/\$(id -u)/<label> and delete ~/Library/LaunchAgents/*omp*collab*.plist"
		note "Linux: systemctl --user disable --now omp-collab-companion; rm ~/.config/systemd/user/omp-collab-companion.service"
	fi

	if [ -e "$OMP" ]; then
		if [ -z "$RECORDED_PATH" ]; then
			warn "$OMP was not installed by this installer."
		fi
		if ask "Delete $OMP?" n; then
			rm -f "$OMP" || die "cannot delete $OMP"
			ok "deleted $OMP"
		else
			note "kept $OMP"
		fi
	fi
	uninstall_desktop
	if [ ! -e "$OMP" ] && [ -z "$DESKTOP_KEPT" ]; then
		rm -f "$STATE_FILE"
		rmdir "$STATE_DIR" 2>/dev/null || true
	elif [ ! -e "$OMP" ]; then
		printf 'desktop_path=%s\ndesktop_sha256=%s\n' "$DESKTOP_KEPT" "$RECORDED_DESKTOP_SHA" >"$STATE_FILE"
	fi
	note "Kept: your omp settings, logins and pairing data under ~/.omp (delete that folder to remove them)."
}

main "$@"
