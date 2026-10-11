#!/usr/bin/env bash
# Run by prepare.sh (which `exec`s it) for `schedule` and `workflow_dispatch`: the `prompt` input (for
# a manual dispatch, the dispatch's own `prompt` input as a fallback) is the task. The
# agent works in the checkout the workflow made, and publish.sh opens a pull request
# with whatever it changed.
#
# These events are started by the workflow file or by someone with write access, so the
# prompt is a trusted instruction, not data: there is no association check and no
# untrusted-input warning in the prompt.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

prompt="${OMP_PROMPT:-}"
if [ -z "$prompt" ] && [ "$GITHUB_EVENT_NAME" = workflow_dispatch ]; then
	prompt="$(jq -r '.inputs.prompt // ""' "$GITHUB_EVENT_PATH")"
fi
if [ -z "${prompt//[[:space:]]/}" ]; then
	echo "::error::the omp action needs a task for $GITHUB_EVENT_NAME runs: set the 'prompt' input (or a 'prompt' workflow_dispatch input)"
	exit 1
fi

default_branch="$(jq -r '.repository.default_branch // ""' "$GITHUB_EVENT_PATH")"
# A dispatch can run on any branch; the pull request goes back to the branch it ran on.
base_ref="$default_branch"
[ "${GITHUB_REF_TYPE:-}" != branch ] || base_ref="${GITHUB_REF_NAME:-$default_branch}"
if [ -z "$base_ref" ]; then
	echo "::error::cannot tell which branch the pull request should target"
	exit 1
fi

cd "$GITHUB_WORKSPACE" || exit 1
start_sha="$(git rev-parse HEAD)"
run_url="${GITHUB_SERVER_URL:-https://github.com}/$GITHUB_REPOSITORY/actions/runs/${GITHUB_RUN_ID:-0}"
# The pull request title is the first line of the task.
title="$(jq -nr --arg p "$prompt" '$p | split("\n") | map(select(test("\\S"))) | first | gsub("^\\s+|\\s+$"; "")')"

jq -n --arg title "$title" --arg author "${GITHUB_ACTOR:-github-actions}" --arg url "$run_url" \
	--arg base_ref "$base_ref" --arg start_sha "$start_sha" \
	'{kind: "task", number: "", is_pr: false, title: $title, author: $author, comment_url: $url,
	  head_ref: "", base_ref: $base_ref, cross_repo: false, untrusted: false, start_sha: $start_sha}' \
	>"$OMP_WORK_DIR/meta.json"

{
	printf 'You are running unattended in GitHub Actions, in a checkout of this repository, on a %s run. Do the task below.\n\n' "$GITHUB_EVENT_NAME"
	cat <<'EOF'
Files you modify in the working tree are committed and opened as a pull request after you finish; do not run `git commit` or `git push`, and do not try to reach GitHub yourself. Your final message becomes the pull request description (or, if you changed nothing, the run summary), so say what you changed and why, and what you could not do. Commands that need interactive approval are denied; work with the tools you have.

EOF
	printf '## Task\n\n%s\n' "$prompt"
} >"$OMP_WORK_DIR/prompt.md"

output skip false
output number ""
