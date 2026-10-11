/**
 * TUI side of `/inspect` and `/preview-request`: a navigable list of the session's model
 * requests whose pick opens the request's detail, and a report of the request the next turn
 * would send.
 */
import { Markdown, Text } from "@oh-my-pi/pi-tui";
import { getMarkdownTheme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "../../modes/types";
import { markdownFenceFor } from "../../utils/markdown-fence";
import { inspectRowDetail, inspectRowLine, inspectSummary, previewHeader } from "./inspect-report";

/** Size cap of the preview body in the terminal; the collab frame allows more. */
const TUI_PREVIEW_MAX_CHARS = 60_000;

/** `/inspect`: list every model request, newest last and preselected; Enter opens one request's detail. */
export async function runInspectCommand(ctx: InteractiveModeContext): Promise<void> {
	const { rows, total } = ctx.session.getInspectRows();
	if (rows.length === 0) {
		ctx.showStatus("No model requests yet.");
		return;
	}
	const options = rows.map(row => ({
		label: inspectRowLine(row),
		description: row.injected.map(item => item.label).join(" · ") || "nothing new in the context",
	}));
	const choice = await ctx.showHookSelector(`Trajectory — ${inspectSummary(rows)}`, options, {
		initialIndex: options.length - 1,
	});
	const picked = choice === undefined ? undefined : rows[options.findIndex(option => option.label === choice)];
	if (!picked) return;
	const detail = inspectRowDetail(picked);
	const hidden = total > rows.length ? `\n\n${total - rows.length} older requests are not listed.` : "";
	ctx.showCommandReport({ title: `Request #${picked.seq}`, body: new Text(detail + hidden, 0, 0) });
}

/** `/preview-request`: the provider request the next turn would send, built without sending it. */
export async function runPreviewRequestCommand(ctx: InteractiveModeContext): Promise<void> {
	try {
		const preview = await ctx.session.previewNextRequest({ maxChars: TUI_PREVIEW_MAX_CHARS });
		const fence = markdownFenceFor(preview.text);
		const markdown = `${previewHeader(preview)}\n\n${fence}json\n${preview.text}\n${fence}`;
		ctx.showCommandReport({ title: "Next request", body: new Markdown(markdown, 0, 0, getMarkdownTheme()) });
	} catch (error) {
		ctx.showError(error instanceof Error ? error.message : String(error));
	}
}
