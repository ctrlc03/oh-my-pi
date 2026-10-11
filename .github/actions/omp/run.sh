#!/usr/bin/env bash
# Run omp headlessly on the prepared prompt. Always exits 0; the omp exit status is
# recorded in $OMP_WORK_DIR/status and acted on by publish.sh.
# Outputs: exit-code, events-file, answer-file.
#
# Environment: OMP_MODEL, OMP_THINKING, OMP_MAX_COST, OMP_MAX_TIME, OMP_APPROVAL_MODE,
#   OMP_TOOLS, OMP_PROJECT_EXTENSIONS, OMP_WORK_DIR, GITHUB_WORKSPACE, GITHUB_OUTPUT.
#   OMP_BIN overrides the executable (tests only). The provider API key is inherited
#   from the calling step's env.
#
# Pull request reviews and issue triage (meta.json `kind` review / triage) ignore
# OMP_APPROVAL_MODE, OMP_TOOLS and OMP_PROJECT_EXTENSIONS: they always run read-only.
set -uo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

work="$OMP_WORK_DIR"
kind="$(jq -r '.kind // "mention"' "$work/meta.json")"
untrusted="$(jq -r '.untrusted // false' "$work/meta.json")"

approval_mode="$OMP_APPROVAL_MODE"
tools="$OMP_TOOLS"
extensions="$OMP_PROJECT_EXTENSIONS"
extra=()
case "$kind" in
review | triage)
	# Reviews and triage only read. This does not depend on the approval-mode, tools and
	# project-extensions inputs (they are for runs that edit): the tool allowlist and the
	# deny-by-default approval mode are fixed here, and the repository's own MCP servers
	# and extensions are never loaded.
	approval_mode=always-ask
	tools="read,grep,find,glob,ast_grep"
	extensions=false
	{
		# outsideProject: the file tools cannot read /proc/self/environ or other files outside the checkout.
		printf 'mcp:\n  enableProjectConfig: false\ntools:\n  outsideProject: deny\n'
		# The built-in review profile adds the read-only review prompt and limits lsp.
		[ "$kind" != review ] || printf 'profile:\n  default: review\n'
	} >"$work/readonly.yml"
	extra+=(--config "$work/readonly.yml")
	# A fork pull request is untrusted code: its skills and rules are prompt material
	# written by the author.
	[ "$untrusted" != true ] || extra+=(--no-skills --no-rules)
	;;
esac

# --no-session: the runner is ephemeral and the JSON event stream is kept instead.
args=(-p --mode json --no-session --no-title --approval-mode "$approval_mode" --max-time "$OMP_MAX_TIME")
[ -z "$OMP_MODEL" ] || args+=(--model "$OMP_MODEL")
[ -z "$OMP_THINKING" ] || args+=(--thinking "$OMP_THINKING")
[ -z "$OMP_MAX_COST" ] || args+=(--max-cost "$OMP_MAX_COST")
[ -z "$tools" ] || args+=(--tools "$tools")
[ "$extensions" = true ] || args+=(--no-extensions)
args+=(${extra[@]+"${extra[@]}"})

if [ "$approval_mode" = yolo ]; then
	echo "::warning::omp runs with approval-mode 'yolo': every tool call, including shell commands, is auto-approved."
fi

echo "omp ${args[*]}"

cd "$GITHUB_WORKSPACE" || exit 1
# The agent never needs the workflow token (publish.sh uses it), so keep it out of
# the agent's environment, including its shell tool.
env -u GH_TOKEN -u GITHUB_TOKEN "${OMP_BIN:-omp}" "${args[@]}" \
	<"$work/prompt.md" >"$work/events.jsonl" 2>"$work/stderr.log"
status=$?

if [ -s "$work/stderr.log" ]; then
	echo "::group::omp stderr (last 60 lines)"
	tail -n 60 "$work/stderr.log"
	echo "::endgroup::"
fi

# Tolerate non-JSON lines in the stream. The answer is the text of the final
# assistant message; the cost is the sum of per-message costs (subagent spend and
# provider-side orchestration may not be included).
events='split("\n") | map(fromjson? | select(type == "object" and .type == "message_end" and .message.role == "assistant"))'
jq -Rrs "$events | last // {} | (.message.content // []) | map(select(.type == \"text\") | .text) | join(\"\\n\")" \
	"$work/events.jsonl" >"$work/answer.md" 2>/dev/null || : >"$work/answer.md"
cost="$(jq -Rrs "$events | map(.message.usage.cost.total // 0) | add // 0" "$work/events.jsonl" 2>/dev/null || echo 0)"

printf '%s\n' "$status" >"$work/status"
printf '%s\n' "$cost" >"$work/cost"
output exit-code "$status"
output events-file "$work/events.jsonl"
output answer-file "$work/answer.md"
exit 0
