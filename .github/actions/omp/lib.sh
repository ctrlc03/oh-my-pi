#!/usr/bin/env bash
# Shared helpers for the omp composite action. Sourced by the step scripts;
# never executed directly. Every value that originates in GitHub event data
# stays in variables or files and is never spliced into a command string.

# The checkout is untrusted and the agent may have edited .git/config: never let
# repository config run commands (fsmonitor) or hooks while the token is in play.
# publish.sh goes further and never reads the workspace's .git at all.
git() {
	command git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null "$@"
}

# Emit a single-line step output.
output() {
	printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"
}

# Run git against $GITHUB_SERVER_URL with the workflow token. The token is
# supplied per invocation so a checkout made with `persist-credentials: false`
# (which keeps it out of .git/config, away from the agent) still fetches and
# pushes. The empty header resets any credential `actions/checkout` persisted;
# GitHub rejects a request carrying two Authorization headers.
git_auth() {
	local key="http.${GITHUB_SERVER_URL:-https://github.com}/.extraheader" basic
	basic="$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')"
	git -c "$key=" -c "$key=AUTHORIZATION: basic $basic" "$@"
}

# post_comment <issue-or-pr-number> <body-file>
post_comment() {
	gh api "repos/$GITHUB_REPOSITORY/issues/$1/comments" -F "body=@$2" --silent
}
