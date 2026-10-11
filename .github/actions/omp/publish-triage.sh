#!/usr/bin/env bash
# Run by publish.sh for a successful triage run: post one triage comment on the issue
# and, only when OMP_APPLY_LABELS is `true`, apply the proposed labels.
#
# The answer is the comment followed by a fenced json block (see prepare-triage.sh):
# {"labels": [...], "duplicate_of": <number or null>}. Nothing in it is trusted beyond
# that: a label counts only if it exists in labels.json (the repository's labels, fetched
# before the agent ran), at most 5 are used, and duplicate_of counts only if it is a
# candidate in candidates.json.
#
# Exit status: 0 everything asked for happened; 1 the comment or the label update failed.
#
# Environment: OMP_WORK_DIR, OMP_APPLY_LABELS, GH_TOKEN, GITHUB_REPOSITORY,
#   GITHUB_SERVER_URL, GITHUB_RUN_ID
set -uo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

work="$OMP_WORK_DIR"
number="$(jq -r '.number' "$work/meta.json")"
cost="$(printf '%.2f' "$(<"$work/cost")")"
run_url="${GITHUB_SERVER_URL:-https://github.com}/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
exit_code=0

text="$work/triage-text.md"
json="$work/triage-json.json"
split_json_block "$work/answer.md" "$text" "$json"
comment="$(<"$text")"
[ -n "$comment" ] || comment="_omp finished without a comment._"

labels='[]'
duplicate=""
if [ -s "$json" ] && jq -e 'type == "object"' "$json" >/dev/null 2>&1; then
	labels="$(jq -c --slurpfile all "$work/labels.json" '
		($all[0] | map(.name)) as $names
		| [(.labels | if type == "array" then . else [] end)[] | select(type == "string") | select(. as $l | ($names | index($l)) != null)]
		| unique | .[:5]' "$json")"
	duplicate="$(jq -r --slurpfile all "$work/candidates.json" '
		(.duplicate_of // null) as $d
		| if ($d | type) == "number" and ($all[0] | map(.number) | index($d)) != null then $d else empty end' "$json")"
elif [ -s "$json" ]; then
	echo "::warning::the triage json block is not an object; no labels or duplicate were taken from it"
fi

line=""
label_list="$(jq -r 'map("`\(.)`") | join(", ")' <<<"$labels")"
if [ "$labels" != '[]' ]; then
	if [ "${OMP_APPLY_LABELS:-false}" = true ]; then
		args=()
		while IFS= read -r name; do
			args+=(-f "labels[]=$name")
		done < <(jq -r '.[]' <<<"$labels")
		if gh api "repos/$GITHUB_REPOSITORY/issues/$number/labels" "${args[@]}" --silent; then
			line="Labels applied: $label_list."
		else
			line="Suggested labels: $label_list (could not apply them; see the [run log]($run_url))."
			exit_code=1
		fi
	else
		line="Suggested labels: $label_list (not applied)."
	fi
fi

{
	printf '%s' "${comment:0:60000}"
	if [ -n "$duplicate" ] && ! grep -qE "#${duplicate}([^0-9]|\$)" <<<"$comment"; then
		printf '\n\nPossible duplicate of #%s.' "$duplicate"
	fi
	[ -z "$line" ] || printf '\n\n%s' "$line"
	printf '\n\n<!-- omp-triage -->\n<sub>omp · [run](%s) · ≈$%s</sub>\n' "$run_url" "$cost"
} >"$work/comment.md"

# The comment is the whole reply: a failed post is reported, not retried as another comment.
if ! post_comment "$number" "$work/comment.md"; then
	echo "::error::could not post the triage comment on #$number"
	exit_code=1
fi
exit "$exit_code"
