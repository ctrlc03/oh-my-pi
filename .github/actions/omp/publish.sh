#!/usr/bin/env bash
# Post omp's answer on the thread and, when the run succeeded and left changes,
# publish them: push to the PR branch for a same-repo pull request, otherwise push
# a new branch and open a pull request. Exits with omp's status when it failed.
# Output: pull-request-url.
#
# The agent may write anywhere in the workspace, including .git/config,
# .git/info/attributes and .gitattributes, and git runs the commands those name
# (filter.*.clean, diff.*.textconv, core.sshCommand, core.askPass, include paths...).
# So no git command here ever reads the workspace's .git: the changes are staged and
# pushed from a private repository ($OMP_WORK_DIR/publish.git) whose config this script
# wrote, using the workspace only as a work tree. Filter and textconv drivers are not
# defined there, so `filter=x` in an agent-written .gitattributes names nothing, and
# system and global git config are disabled.
#
# Pull request reviews and issue triage (meta.json `kind`) are read-only: nothing is
# staged or pushed, and publish-review.sh / publish-triage.sh post the reply. A `task`
# (schedule, workflow_dispatch) has no thread: its pull request is opened as for an
# issue and the reply goes to the job summary.
#
# Environment: OMP_CREATE_PR, OMP_BRANCH_PREFIX, OMP_GIT_USER_NAME, OMP_GIT_USER_EMAIL,
#   OMP_APPLY_LABELS, OMP_BOT_LOGIN, OMP_MAX_INLINE_COMMENTS (the last three are read by
#   the review and triage scripts), OMP_WORK_DIR, GH_TOKEN, GITHUB_REPOSITORY,
#   GITHUB_RUN_ID, GITHUB_SERVER_URL, GITHUB_WORKSPACE, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY
set -uo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# No system or global config (credential helpers, filter drivers such as git-lfs's,
# includes), and never an interactive prompt.
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0

work="$OMP_WORK_DIR"
meta() { jq -r --arg k "$1" '.[$k] | if . == null then "" else . end' "$work/meta.json"; }

status="$(<"$work/status")"
cost="$(printf '%.2f' "$(<"$work/cost")")"
number="$(meta number)"
title="$(meta title)"
author="$(meta author)"
comment_url="$(meta comment_url)"
is_pr="$(meta is_pr)"
head_ref="$(meta head_ref)"
base_ref="$(meta base_ref)"
cross_repo="$(meta cross_repo)"
start_sha="$(meta start_sha)"
kind="$(meta kind)"
[ -n "$kind" ] || kind=mention
run_url="${GITHUB_SERVER_URL:-https://github.com}/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"

answer="$(<"$work/answer.md")"
exit_code=0
note=""
# Set once the review or triage script posted the reply itself.
posted=false

# Push to the repository the workflow runs in, not to whatever `origin` points at now.
remote="${GITHUB_SERVER_URL:-https://github.com}/$GITHUB_REPOSITORY.git"

changed=false
base=""

# stage_changes: build the private repository, fetch the commit the agent started
# from, and stage the workspace's files on top of it. Sets $changed and $base.
stage_changes() {
	local gitdir="$work/publish.git" spec="$start_sha"
	rm -rf "$gitdir"
	git init -q --bare --template= --initial-branch=publish "$gitdir" || return 1
	export GIT_DIR="$gitdir" GIT_WORK_TREE="$GITHUB_WORKSPACE"
	cd "$GITHUB_WORKSPACE" || return 1
	# A fork PR's commit is only reachable through the base repository's pull ref.
	[ "$cross_repo" != true ] || spec="pull/$number/head"
	git_auth fetch -q --no-tags --depth 1 "$remote" "$spec" || return 1
	base="$(git rev-parse --verify -q 'FETCH_HEAD^{commit}')" || return 1
	git update-ref refs/heads/publish "$base" || return 1
	git read-tree "$base" || return 1
	git add -A || return 1
	# A submodule or nested repository would be recorded as a gitlink the agent
	# chose; refuse rather than publish one.
	if git diff --cached --raw --no-renames --no-ext-diff --no-textconv "$base" |
		awk '$1 == ":160000" || $2 == "160000" { found = 1 } END { exit !found }'; then
		echo "::error::the agent changed a submodule or embedded git repository, which the action does not publish"
		return 1
	fi
	git diff --cached --quiet "$base" || changed=true
}

commit_staged() {
	git -c "user.name=$OMP_GIT_USER_NAME" -c "user.email=$OMP_GIT_USER_EMAIL" \
		commit --no-verify -q -m "omp: ${title:0:60}" -m "Requested by @$author in $comment_url"
}

publish() {
	if [ "$cross_repo" = true ]; then
		note="Changes were left in the runner's checkout of this fork pull request; nothing was pushed (the action never writes to fork branches)."
		return 0
	fi
	if [ "$is_pr" = true ]; then
		commit_staged || return 1
		git_auth push --no-verify "$remote" "HEAD:refs/heads/$head_ref" || return 1
		note="Pushed 1 commit to \`$head_ref\`."
		return 0
	fi
	local branch="${OMP_BRANCH_PREFIX}issue-${number}-${GITHUB_RUN_ID}"
	[ "$kind" != task ] || branch="${OMP_BRANCH_PREFIX}task-${GITHUB_RUN_ID}"
	commit_staged || return 1
	git_auth push --no-verify "$remote" "HEAD:refs/heads/$branch" || return 1
	# Everything below talks to GitHub only, from outside any repository.
	unset GIT_DIR GIT_WORK_TREE
	cd "$work" || return 1
	{
		printf 'Requested by @%s in %s.\n\n' "$author" "$comment_url"
		[ -z "$number" ] || printf 'Refs #%s\n\n' "$number"
		printf '%s\n' "$answer"
	} >"$work/pr-body.md"
	local url
	url="$(gh pr create --repo "$GITHUB_REPOSITORY" --base "$base_ref" --head "$branch" \
		--title "omp: $title" --body-file "$work/pr-body.md")" || return 1
	output pull-request-url "$url"
	note="Opened $url from \`$branch\`."
}

case "$status" in
0)
	[ -n "$answer" ] || answer="_omp finished without a text reply._"
	if [ "$kind" = review ] || [ "$kind" = triage ]; then
		# Read-only runs: nothing is staged or pushed, whatever the workspace holds.
		if bash "$(dirname "${BASH_SOURCE[0]}")/publish-$kind.sh"; then
			posted=true
		elif [ "$kind" = triage ]; then
			# It already tried to post the comment; the failure is in the log.
			posted=true
			exit_code=1
		else
			exit_code=1
			note="Could not post a pull request review; see the [run log]($run_url). The review is posted here as a comment instead."
			[ ! -s "$work/fallback.md" ] || answer="$(<"$work/fallback.md")"
		fi
	elif ! stage_changes; then
		note="Could not stage the changes for publication; see the [run log]($run_url). Nothing was pushed."
		exit_code=1
	elif [ "$changed" = true ]; then
		if [ "$OMP_CREATE_PR" = true ]; then
			if ! publish; then
				note="Publishing the changes failed; see the [run log]($run_url). The changes are only in the runner's checkout."
				exit_code=1
			fi
		else
			note="Files were changed but \`create-pr\` is disabled, so nothing was pushed."
		fi
	fi
	;;
3)
	answer="omp stopped because it reached the spend cap (\`max-cost\`). Nothing was published."
	exit_code=3
	;;
*)
	answer="omp failed (exit code $status); see the [run log]($run_url). Nothing was published."
	exit_code="$status"
	;;
esac

# Past this point only GitHub's API is used, from outside any repository.
unset GIT_DIR GIT_WORK_TREE
cd "$work" || exit 1

# The review or triage script already posted the reply.
[ "$posted" != true ] || exit "$exit_code"

{
	printf '%s' "${answer:0:60000}"
	[ -z "$note" ] || printf '\n\n%s' "$note"
	printf '\n\n<sub>omp · [run](%s) · ≈$%s</sub>\n' "$run_url" "$cost"
} >"$work/comment.md"

if [ "$kind" = task ]; then
	# No thread to answer on: the run summary is the reply.
	cat "$work/comment.md" >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
elif ! post_comment "$number" "$work/comment.md"; then
	echo "::error::could not post the reply comment on #$number"
	[ "$exit_code" -ne 0 ] || exit_code=1
fi

exit "$exit_code"
