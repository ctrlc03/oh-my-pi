#!/usr/bin/env bash
# Prints the cache key (16 hex digits) of one target's pi-natives addons for CI.
#
#   scripts/ci-natives-key.sh <target> <runner-image> <x64-variants> <cargo-profile>
#   scripts/ci-natives-key.sh linux-x64 ubuntu-22.04 "baseline modern" ci
#
# Used by .github/workflows/collab-release.yml and collab-natives.yml: the composite action
# .github/actions/collab-natives stores the addons as the artifact `collab-natives-<target>-<key>`
# and later runs reuse it instead of recompiling the Rust workspace (about 30 minutes on a
# cold runner). Run it at the repository root of the tree that would be built.
#
# The key covers everything the addon build reads, and nothing else:
#
#   * crates/** (every crate, including crates/vendor and the data/, fixtures/ and prompt files
#     the crates `include_str!` / `include_bytes!`; an audit of crates/ found none that reach
#     outside crates/, and the build.rs files of pi-natives and pi-shell read only their own
#     src/ directories, so nothing outside the list below feeds the Rust build);
#   * Cargo.toml, Cargo.lock, rust-toolchain.toml (the pinned nightly), .cargo/**;
#   * packages/natives/** except docs, tests and benches: the napi package.json (its
#     `version` is stamped into every addon), build-bindings.ts and gen-enums.ts (they run the
#     build and write native/index.js and native/index.d.ts, which the artifact also holds),
#     and the tracked loader files in native/;
#   * scripts/bazel-natives.ts and its imports scripts/host-detect.ts and
#     scripts/stamp-native-version.ts (the stamp is written into the addon after linking);
#   * .gitattributes (line endings of the files above) and the resolved @napi-rs/cli entry of
#     bun.lock (the napi driver), not the rest of the lockfile;
#   * the target, the sorted x64 variant list, the cargo profile and the runner image label;
#   * this script itself, so changing the inputs here invalidates old keys.
#
# Both the index entry (mode and blob id) and the working-tree bytes of each tracked file are
# hashed, so the key is the same for a commit and its checkout, and an uncommitted edit still
# changes it. Keep the `paths:` of collab-natives.yml in step with the list below.
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <target> <runner-image> <x64-variants> <cargo-profile>" >&2
  exit 2
fi
target="$1"
runner="$2"
variants="$(tr -s ' ' '\n' <<<"$3" | sort | paste -sd, -)"
profile="$4"

self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(git rev-parse --show-toplevel)"

pathspecs=(
  crates
  Cargo.toml
  Cargo.lock
  rust-toolchain.toml
  .cargo
  .gitattributes
  packages/natives
  scripts/bazel-natives.ts
  scripts/host-detect.ts
  scripts/stamp-native-version.ts
  ':(exclude)packages/natives/CHANGELOG.md'
  ':(exclude)packages/natives/README.md'
  ':(exclude)packages/natives/LICENSE'
  ':(exclude)packages/natives/THIRD-PARTY-NOTICES.txt'
  ':(exclude)packages/natives/bench'
  ':(exclude)packages/natives/test'
)

{
  echo "format 1"
  echo "target $target"
  echo "runner $runner"
  echo "x64-variants $variants"
  echo "profile $profile"
  echo "script $(git hash-object -- "$self")"
  echo "napi-cli $(grep -E '^[[:space:]]*"@napi-rs/cli": \[' bun.lock || echo none)"
  git ls-files -s -- "${pathspecs[@]}"
  git ls-files -z -- "${pathspecs[@]}" | xargs -0 git hash-object --no-filters --
} | git hash-object --stdin | cut -c1-16
