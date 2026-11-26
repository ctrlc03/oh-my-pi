#!/usr/bin/env bash
#
# Sign a compiled macOS `omp` binary: with a Developer ID identity and
# notarization when those credentials are configured, with a stable
# self-signed identity when that one is, ad hoc otherwise.
#
# The release build (`ci:release:build-binaries`) cross-compiles the binary on
# Linux, where Bun's own signature is not usable as shipped: the arm64 binary
# carries a bare linker signature, and the x86_64 one keeps the Bun runtime's
# Developer ID signature, which no longer matches the appended payload. This
# script *replaces* it with
#   - with Developer ID credentials: a Developer ID Application signature plus
#     the hardened runtime, a secure timestamp, and the JIT, Apple Events, and
#     library-validation entitlements that the Bun runtime, Xcode MCP bridge,
#     and runtime-extracted native addon require (see
#     scripts/macos-entitlements.plist), then notarizes the result with App
#     Store Connect API credentials;
#   - with a stable identity (OMP_MACOS_SIGNING_PEM): a signature by that
#     certificate with the same entitlements, not notarized. Its designated
#     requirement is `identifier "omp-darwin-<arch>" and certificate root =
#     H"<cert hash>"`, the same for every build signed with the certificate, so
#     macOS keeps privacy permissions (Documents, Full Disk Access) across
#     updates. An ad-hoc signature's requirement is the build's cdhash, so each
#     update is a new program to macOS: its grants stop matching and the
#     companion, a background service, waits on a prompt nobody sees;
#   - without any: an ad-hoc signature with the same entitlements, so the
#     binary runs (forks and releases before the secrets exist).
# All go through rcodesign (github.com/indygreg/apple-platform-rs, pinned and
# sha256-checked below), the open-source implementation of codesign and
# notarytool. The signing identifier is the file name (omp-darwin-<arch>),
# as every release before had it.
#
# A bare Mach-O executable cannot be stapled (stapling only supports .app/.pkg/
# .dmg), so the notarization ticket is served online: Gatekeeper fetches it by
# cdhash on first assessment. `curl` downloads and Homebrew *formula* installs do
# not set the quarantine bit, so they never invoke Gatekeeper; for an offline,
# quarantined cask we would need a stapleable .pkg/.dmg wrapper (follow-up).
# Apple's `codesign --verify --strict` and the launch check under the final
# signature run on a macOS runner afterwards (release_smoke in
# .github/workflows/ci.yml); notarization itself rejects a malformed signature
# first.
#
# Developer ID credentials (GitHub Actions secrets; all five or none):
#   APPLE_CERTIFICATE_P12        base64 of the Developer ID Application .p12 bundle
#   APPLE_CERTIFICATE_PASSWORD   password protecting that .p12
#   APPLE_API_KEY_ID             App Store Connect API key id (the "Key ID")
#   APPLE_API_ISSUER_ID          App Store Connect API issuer id (UUID)
#   APPLE_API_KEY                base64 of the App Store Connect .p8 private key
# Stable identity (used only without the Developer ID credentials):
#   OMP_MACOS_SIGNING_PEM        base64 of a PEM file holding the private key and
#                                its self-signed code-signing certificate
#   OMP_MACOS_SIGNING_PEM_FILE   or the path of that PEM file (local builds)
#
# Runs on Linux (CI) and macOS (a local release build).
#
# Usage: scripts/ci-macos-sign.sh <path-to-binary>

set -euo pipefail

case "$(uname -s)" in
Linux) host_os=linux ;;
Darwin) host_os=darwin ;;
*)
	echo "ci-macos-sign: runs on Linux or macOS" >&2
	exit 1
	;;
esac

BINARY="${1:-}"
if [[ -z "$BINARY" ]]; then
	echo "usage: ci-macos-sign.sh <path-to-binary>" >&2
	exit 1
fi
if [[ ! -f "$BINARY" ]]; then
	echo "ci-macos-sign: binary not found: $BINARY" >&2
	exit 1
fi

set_vars=()
missing=()
for var in APPLE_CERTIFICATE_P12 APPLE_CERTIFICATE_PASSWORD APPLE_API_KEY_ID APPLE_API_ISSUER_ID APPLE_API_KEY; do
	if [[ -n "${!var:-}" ]]; then set_vars+=("$var"); else missing+=("$var"); fi
done
if ((${#set_vars[@]} && ${#missing[@]})); then
	echo "ci-macos-sign: incomplete credentials, missing: ${missing[*]}" >&2
	exit 1
fi
developer_id=$((${#set_vars[@]} > 0))

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTITLEMENTS="$SCRIPT_DIR/macos-entitlements.plist"
if [[ ! -f "$ENTITLEMENTS" ]]; then
	echo "ci-macos-sign: entitlements not found: $ENTITLEMENTS" >&2
	exit 1
fi

# rcodesign 0.29.0, per host OS and arch.
RCODESIGN_VERSION=0.29.0
case "$host_os-$(uname -m)" in
linux-x86_64) platform=x86_64-unknown-linux-musl sha=dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002 ;;
linux-aarch64 | linux-arm64) platform=aarch64-unknown-linux-musl sha=4af92c87ddf52f5f2d1258a3b4e56c7dcb8f1b2468df744976c5f139e031961f ;;
darwin-arm64) platform=aarch64-apple-darwin sha=d1a532150adaf90048260d76359261aa716abafc45c53c5dc18845029184334a ;;
darwin-x86_64) platform=x86_64-apple-darwin sha=14ef11bedd51a8d95eafd767939ae96d5900e5a61511bef75bb21db6e7c74140 ;;
*)
	echo "ci-macos-sign: no pinned rcodesign for $host_os $(uname -m)" >&2
	exit 1
	;;
esac

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "ci-macos-sign: fetching rcodesign $RCODESIGN_VERSION"
tarball="$WORKDIR/rcodesign.tar.gz"
curl -fsSL --retry 3 -o "$tarball" \
	"https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F$RCODESIGN_VERSION/apple-codesign-$RCODESIGN_VERSION-$platform.tar.gz"
if [[ "$host_os" == darwin ]]; then
	echo "$sha  $tarball" | shasum -a 256 -c - >/dev/null
else
	echo "$sha  $tarball" | sha256sum -c - >/dev/null
fi
tar -xzf "$tarball" -C "$WORKDIR" --strip-components=1
RCODESIGN="$WORKDIR/rcodesign"
sign=("$RCODESIGN" sign --binary-identifier "$(basename "$BINARY")" --entitlements-xml-file "$ENTITLEMENTS")

if ((!developer_id)) && [[ -n "${OMP_MACOS_SIGNING_PEM:-}${OMP_MACOS_SIGNING_PEM_FILE:-}" ]]; then
	PEM_PATH="$WORKDIR/signing.pem"
	if [[ -n "${OMP_MACOS_SIGNING_PEM:-}" ]]; then
		(umask 077 && printf '%s' "$OMP_MACOS_SIGNING_PEM" | base64 --decode >"$PEM_PATH")
	else
		PEM_PATH="$OMP_MACOS_SIGNING_PEM_FILE"
	fi
	echo "ci-macos-sign: signing with the stable self-signed identity"
	"${sign[@]}" --pem-file "$PEM_PATH" "$BINARY"
	exit 0
fi

if ((!developer_id)); then
	echo "ci-macos-sign: no APPLE_* credentials; signing ad hoc"
	"${sign[@]}" "$BINARY"
	exit 0
fi

CERT_PATH="$WORKDIR/cert.p12"
CERT_PASSWORD_PATH="$WORKDIR/cert-password"
API_KEY_PATH="$WORKDIR/api-key.p8"
API_KEY_JSON="$WORKDIR/api-key.json"
ZIP_PATH="$WORKDIR/$(basename "$BINARY").zip"

echo "ci-macos-sign: decoding credentials"
(
	umask 077
	printf '%s' "$APPLE_CERTIFICATE_P12" | base64 --decode >"$CERT_PATH"
	printf '%s' "$APPLE_CERTIFICATE_PASSWORD" >"$CERT_PASSWORD_PATH"
	printf '%s' "$APPLE_API_KEY" | base64 --decode >"$API_KEY_PATH"
)

echo "ci-macos-sign: signing with the Developer ID identity"
"${sign[@]}" \
	--p12-file "$CERT_PATH" \
	--p12-password-file "$CERT_PASSWORD_PATH" \
	--code-signature-flags runtime \
	--for-notarization \
	"$BINARY"

echo "ci-macos-sign: submitting for notarization"
(cd "$(dirname "$BINARY")" && zip -q -X "$ZIP_PATH" "$(basename "$BINARY")")
"$RCODESIGN" encode-app-store-connect-api-key -o "$API_KEY_JSON" \
	"$APPLE_API_ISSUER_ID" "$APPLE_API_KEY_ID" "$API_KEY_PATH" >/dev/null
# Apple's notary requests time out now and then while the submission carries
# on; a failed submission is retried.
for attempt in 1 2 3; do
	if "$RCODESIGN" notary-submit --api-key-file "$API_KEY_JSON" --wait --max-wait-seconds 1800 "$ZIP_PATH"; then
		echo "ci-macos-sign: notarized $(basename "$BINARY")"
		echo "ci-macos-sign: note — a bare Mach-O cannot be stapled; the ticket is verified online."
		exit 0
	fi
	echo "ci-macos-sign: notarization attempt $attempt failed" >&2
	sleep 30
done
exit 1
