import type { ReactNode } from "react";
import { BlockShell } from "../transcript/Block";
import { Markdown } from "../transcript/Markdown";
import "../transcript/transcript.css";

const PROMPT = "Can you make the line parser skip empty parts?";

const REPLY = [
	"Done: `parseLine` now drops empty parts.",
	"",
	"- `a,,b` gives `[a, b]`",
	"- a trailing comma is ignored ([see the tests](#tests))",
	"",
	"```ts",
	'const parts = line.split(",").filter(Boolean);',
	"```",
].join("\n");

/**
 * A short conversation drawn with the transcript's own markup and styles, so every appearance setting shows on it
 * as it will in a session. Inert: it is a picture of the settings, not something to operate.
 */
export function AppearancePreview(): ReactNode {
	return (
		<div className="tr-root sh-appr-preview" inert>
			<div className="tr-row tr-row--user">
				<div className="tr-gutter" />
				<div className="tr-body">
					<BlockShell id={null} kind="prompt" label="you">
						<Markdown text={PROMPT} />
					</BlockShell>
				</div>
			</div>
			<div className="tr-row tr-row--assistant">
				<div className="tr-gutter" />
				<div className="tr-body">
					<BlockShell id={null} kind="reply">
						<Markdown text={REPLY} />
					</BlockShell>
				</div>
			</div>
		</div>
	);
}
