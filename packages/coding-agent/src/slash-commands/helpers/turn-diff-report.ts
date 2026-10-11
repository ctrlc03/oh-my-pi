import { promptIdsOf, runSessionDiff, runTurnDiff, type TurnDiffOutcome } from "../../session/turn-diff-run";
import type { SlashCommandRuntime } from "../types";

export const DIFF_USAGE = "Usage: /diff [turn [<n>]|session]";

export type DiffCommandArgs = { scope: "turn"; turn: number | undefined } | { scope: "session" } | { error: string };

/** Parse `/diff` arguments: the latest turn by default, `turn <n>` for the nth prompt (1-based), or `session`. */
export function parseDiffArgs(args: string): DiffCommandArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const verb = tokens[0]?.toLowerCase();
	if (verb === undefined) return { scope: "turn", turn: undefined };
	if (verb === "session" && tokens.length === 1) return { scope: "session" };
	if (verb !== "turn" || tokens.length > 2) return { error: DIFF_USAGE };
	if (tokens.length === 1) return { scope: "turn", turn: undefined };
	const turn = Number(tokens[1]);
	return Number.isInteger(turn) && turn >= 1 ? { scope: "turn", turn } : { error: DIFF_USAGE };
}

/** How a line of a diff is painted; the identity for plain text. */
export type DiffPaint = (kind: "add" | "del" | "ctx" | "head", text: string) => string;

const PLAIN: DiffPaint = (_kind, text) => text;

/** Run the diff `args` asks for against `runtime`'s session; `label` heads the printed report. */
export async function runDiffCommand(
	args: Exclude<DiffCommandArgs, { error: string }>,
	runtime: Pick<SlashCommandRuntime, "session" | "sessionManager">,
): Promise<{ outcome: TurnDiffOutcome; label: string }> {
	if (args.scope === "session") {
		return { outcome: await runSessionDiff(runtime.session), label: "Changes since the session's first snapshot" };
	}
	const prompts = promptIdsOf(runtime.sessionManager.getBranch());
	const turn = args.turn ?? prompts.length;
	const promptId = prompts[turn - 1];
	if (promptId === undefined) {
		const reason =
			prompts.length === 0 ? "there are no prompts yet" : `there is no turn ${turn} (1-${prompts.length})`;
		return { outcome: { reason }, label: "" };
	}
	return { outcome: await runTurnDiff(runtime.session, promptId), label: `Changes in turn ${turn}` };
}

/** The diff as text: a summary line, then per file its status line and unified diff. */
export function formatTurnDiff(outcome: TurnDiffOutcome, label: string, paint: DiffPaint = PLAIN): string {
	if ("reason" in outcome) return `No diff: ${outcome.reason}.`;
	const { files, omitted, spansTurns } = outcome.diff;
	if (files.length === 0) return `${label}: no files changed.`;
	let added = 0;
	let removed = 0;
	for (const file of files) {
		added += file.added ?? 0;
		removed += file.removed ?? 0;
	}
	const total = files.length + omitted;
	const span = spansTurns > 1 ? ` (spans ${spansTurns} turns: a later prompt has no snapshot)` : "";
	const lines = [`${label}: ${total} file${total === 1 ? "" : "s"}, +${added} −${removed}${span}`];
	for (const file of files) {
		const counts = file.added === null ? "binary" : `+${file.added} −${file.removed}`;
		lines.push("", paint("head", `${file.status} ${file.path} (${counts})`));
		if (file.diff.length === 0) continue;
		for (const line of file.diff.replace(/\n$/, "").split("\n")) {
			const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
			lines.push(paint(kind, line));
		}
		if (file.truncated) lines.push(paint("ctx", "… diff cut"));
	}
	if (omitted > 0) lines.push("", `… ${omitted} more file${omitted === 1 ? "" : "s"} not listed`);
	return lines.join("\n");
}
