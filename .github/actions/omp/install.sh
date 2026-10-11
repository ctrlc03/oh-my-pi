#!/usr/bin/env bash
# Install omp. Default: the published npm package via bun. With OMP_SOURCE
# (`owner/repo@ref`): build that fork ref from source and expose it as `omp`.
#
# Environment: OMP_VERSION, OMP_SOURCE, RUNNER_TEMP, GITHUB_PATH, GITHUB_SERVER_URL
set -euo pipefail

if [ -z "${OMP_SOURCE:-}" ]; then
	if ! [[ "${OMP_VERSION:-latest}" =~ ^[A-Za-z0-9._-]+$ ]]; then
		echo "::error::omp-version must be an npm version or dist-tag, got '${OMP_VERSION}'"
		exit 1
	fi
	bun install -g "@oh-my-pi/pi-coding-agent@${OMP_VERSION:-latest}"
	echo "$HOME/.bun/bin" >>"$GITHUB_PATH"
	export PATH="$HOME/.bun/bin:$PATH"
else
	if ! [[ "$OMP_SOURCE" =~ ^([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)@([A-Za-z0-9._/-]+)$ ]]; then
		echo "::error::omp-source must look like 'owner/repo@branch-or-tag', got '${OMP_SOURCE}'"
		exit 1
	fi
	repo="${BASH_REMATCH[1]}"
	ref="${BASH_REMATCH[2]}"
	src="$RUNNER_TEMP/omp-src"
	bin="$RUNNER_TEMP/omp-bin"
	git clone --depth 1 --branch "$ref" "${GITHUB_SERVER_URL:-https://github.com}/$repo.git" "$src"
	# `bun setup` installs the workspaces and builds the native addon (needs the
	# Rust toolchain that GitHub-hosted runners ship).
	(cd "$src" && bun setup)
	mkdir -p "$bin"
	printf '#!/usr/bin/env bash\nexec bun %q "$@"\n' "$src/packages/coding-agent/src/cli.ts" >"$bin/omp"
	chmod +x "$bin/omp"
	echo "$bin" >>"$GITHUB_PATH"
	export PATH="$bin:$PATH"
fi

omp --version
