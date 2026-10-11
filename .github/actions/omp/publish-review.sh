#!/usr/bin/env bash
# Run by publish.sh for a successful review run: post omp's answer to the pull request
# as one review (event COMMENT, never an approval or a change request) with a summary
# and inline comments, then collapse the reviews omp posted for earlier commits.
#
# The answer is the summary followed by a fenced json block of findings (see
# prepare-review.sh). GitHub rejects the whole review when one inline comment names a
# line that is not in the diff, so a finding becomes an inline comment only when its
# path and line are in valid-lines.json; the rest, and anything over
# OMP_MAX_INLINE_COMMENTS, is listed in the summary instead.
#
# Exit status: 0 the review was posted; 1 it was not, and the summary is left in
# $OMP_WORK_DIR/fallback.md for publish.sh to post as a plain comment.
#
# Environment: OMP_WORK_DIR, OMP_BOT_LOGIN, OMP_MAX_INLINE_COMMENTS, GH_TOKEN,
#   GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID
set -uo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

work="$OMP_WORK_DIR"
number="$(jq -r '.number' "$work/meta.json")"
head_sha="$(jq -r '.head_sha' "$work/meta.json")"
cost="$(printf '%.2f' "$(<"$work/cost")")"
run_url="${GITHUB_SERVER_URL:-https://github.com}/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
bot_login="${OMP_BOT_LOGIN:-github-actions[bot]}"
max="${OMP_MAX_INLINE_COMMENTS:-20}"
[[ "$max" =~ ^[0-9]+$ ]] || max=20

# write_review_body <body-file> <summary> <findings-markdown>
write_review_body() {
	{
		printf '%s' "${2:0:40000}"
		[ -z "$3" ] || printf '\n\n**Findings**\n\n%s' "${3:0:15000}"
		printf '\n\n<!-- omp-review sha=%s -->\n<sub>omp · [run](%s) · ≈$%s</sub>\n' "$head_sha" "$run_url" "$cost"
	} >"$1"
}

# post_review <comments-json> <body-file>: prints the API response.
post_review() {
	jq -n --arg commit "$head_sha" --rawfile body "$2" --argjson comments "$1" \
		'{commit_id: $commit, event: "COMMENT", body: $body, comments: $comments}' >"$work/review.json" &&
		gh api "repos/$GITHUB_REPOSITORY/pulls/$number/reviews" --input "$work/review.json"
}

# collapse_outdated <node-id>: hide an earlier review or review comment as outdated.
collapse_outdated() {
	local query
	read -r -d '' query <<'EOF' || true
mutation($id: ID!) {
	minimizeComment(input: {subjectId: $id, classifier: OUTDATED}) { minimizedComment { isMinimized } }
}
EOF
	gh api graphql -f query="$query" -f id="$1" --silent ||
		echo "::warning::could not collapse the earlier omp review item $1"
}

# supersede_reviews <new-review-id>: collapse every earlier omp review of this pull
# request (recognized by the marker and by who posted it) and its inline comments.
supersede_reviews() {
	local id node comment_node
	while read -r id node; do
		collapse_outdated "$node"
		while read -r comment_node; do
			collapse_outdated "$comment_node"
		done < <(gh api --paginate "repos/$GITHUB_REPOSITORY/pulls/$number/reviews/$id/comments" --jq '.[].node_id')
	done < <(gh api --paginate "repos/$GITHUB_REPOSITORY/pulls/$number/reviews" \
		--jq '.[] | {id, node_id, login: .user.login, body: (.body // "")}' |
		jq -r --arg login "$bot_login" --argjson new "$1" \
			'select(.login == $login and .id != $new and (.body | contains("<!-- omp-review "))) | "\(.id) \(.node_id)"')
}

text="$work/review-text.md"
json="$work/review-json.json"
split_json_block "$work/answer.md" "$text" "$json"
summary="$(<"$text")"
[ -n "$summary" ] || summary="_omp finished without a summary._"

findings='[]'
if [ -s "$json" ] && jq -e '(.findings | type) == "array"' "$json" >/dev/null 2>&1; then
	findings="$(jq -c '.findings' "$json")"
elif [ -s "$json" ]; then
	echo "::warning::the review's json block has no findings array; posting the summary only"
fi

jq -n --argjson f "$findings" --slurpfile v "$work/valid-lines.json" --argjson max "$max" '
	def sev: if (.severity | type) == "string" then (.severity | ascii_downcase) else "note" end;
	def item: "- `\(.path):\(.line)` (\(sev)): \(.body[:1500])";
	($v[0] // {}) as $valid
	| [$f[] | select(type == "object" and (.path | type) == "string" and (.line | type) == "number"
		and .line == (.line | floor) and (.body | type) == "string" and (.body | length) > 0)] as $ok
	| ($ok | map(. as $x | select((($valid[$x.path] // []) | index($x.line)) != null))) as $anchored
	| {
		inline: ($anchored[:$max] | map({path, line, side: "RIGHT", body: "**\(sev)**: \(.body[:4000])"})),
		rest: (($anchored[$max:] + ($ok - $anchored)) | map(item))
	}' >"$work/review-split.json"

comments="$(jq -c '.inline' "$work/review-split.json")"
rest="$(jq -r '.rest | join("\n")' "$work/review-split.json")"
body="$work/review-body.md"

write_review_body "$body" "$summary" "$rest"
if ! response="$(post_review "$comments" "$body")" && [ "$comments" != '[]' ]; then
	# Typically a 422 for an inline comment GitHub could not place: fold them all into the body.
	echo "::warning::posting the review with inline comments failed; retrying with the findings in the summary"
	rest="$(jq -r '((.inline | map("- `\(.path):\(.line)`: \(.body)")) + .rest) | join("\n")' "$work/review-split.json")"
	write_review_body "$body" "$summary" "$rest"
	response="$(post_review '[]' "$body")"
fi
if [ -z "${response:-}" ] || ! jq -e '.id' <<<"$response" >/dev/null 2>&1; then
	printf '%s\n' "$summary" >"$work/fallback.md"
	exit 1
fi

supersede_reviews "$(jq -r '.id' <<<"$response")"
