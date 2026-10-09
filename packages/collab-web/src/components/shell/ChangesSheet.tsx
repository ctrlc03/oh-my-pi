import { ChevronRight, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { FileChange } from "../../lib/changes";
import { type ToolRenderHost, ToolView } from "../../tool-render";
import { Sheet } from "./Sheet";

export interface ChangesSheetProps {
	changes: readonly FileChange[];
	host: ToolRenderHost;
	onClose(): void;
}

function splitPath(path: string): { dir: string; base: string } {
	const at = path.lastIndexOf("/");
	return at < 0 ? { dir: "", base: path } : { dir: path.slice(0, at + 1), base: path.slice(at + 1) };
}

/** Files the agent changed through its edit tools; tap a file for each change's diff. */
export function ChangesSheet({ changes, host, onClose }: ChangesSheetProps): ReactNode {
	const [open, setOpen] = useState<string | null>(changes.length === 1 ? (changes[0]?.path ?? null) : null);
	return (
		<Sheet label="files changed" wide onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">
					{changes.length} file{changes.length === 1 ? "" : "s"} changed
				</div>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close">
					<X size={16} />
				</button>
			</div>
			<ul className="sh-changes">
				{changes.map(file => {
					const expanded = open === file.path;
					const { dir, base } = splitPath(file.path);
					return (
						<li key={file.path} className="sh-change">
							<button
								type="button"
								className="sh-change-head"
								onClick={() => setOpen(expanded ? null : file.path)}
								aria-expanded={expanded}
								title={file.path}
							>
								<ChevronRight size={14} className={expanded ? "tr-chev tr-chev--open" : "tr-chev"} />
								<span className="sh-change-path">
									<span className="sh-change-dir">{dir}</span>
									<span className="sh-change-base">{base}</span>
								</span>
								{file.added > 0 && <span className="sh-change-add">+{file.added}</span>}
								{file.removed > 0 && <span className="sh-change-del">−{file.removed}</span>}
							</button>
							{expanded && (
								<div className="sh-change-body">
									{file.calls.map(call => (
										<ToolView
											key={call.id}
											name={call.name}
											args={call.args}
											intent={call.intent}
											result={call.result}
											host={host}
											defaultOpen
										/>
									))}
								</div>
							)}
						</li>
					);
				})}
			</ul>
		</Sheet>
	);
}
