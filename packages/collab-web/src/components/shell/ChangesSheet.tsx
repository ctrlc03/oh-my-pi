import { ChevronRight, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { FileChange } from "../../lib/changes";
import type { CompanionClient } from "../../lib/companion";
import { splitPath } from "../../lib/format";
import { type ToolRenderHost, ToolView } from "../../tool-render";
import { Sheet } from "./Sheet";
import { WorkingTree } from "./WorkingTree";

/** The paired computer's companion host for this session: enables the working tree. */
export interface ChangesTree {
	client: CompanionClient;
	instanceId: string;
}

export interface ChangesSheetProps {
	changes: readonly FileChange[];
	host: ToolRenderHost;
	/** null: no companion host for this session, so only the agent's own edits are known. */
	tree: ChangesTree | null;
	onClose(): void;
}

type Tab = "agent" | "tree";

/**
 * What changed: the agent's edit-tool calls from the transcript, and, when the
 * session's computer is paired, the repository's working tree.
 */
export function ChangesSheet({ changes, host, tree, onClose }: ChangesSheetProps): ReactNode {
	const [tab, setTab] = useState<Tab>(changes.length === 0 && tree !== null ? "tree" : "agent");
	return (
		<Sheet label="changes" wide onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">
					{tree === null
						? `${changes.length} file${changes.length === 1 ? "" : "s"} changed`
						: tab === "agent"
							? "Agent edits"
							: "Working tree"}
				</div>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close">
					<X size={16} />
				</button>
			</div>
			{tree !== null && (
				<div className="sh-tabs" role="tablist" aria-label="changes view">
					<button
						type="button"
						role="tab"
						aria-selected={tab === "agent"}
						className="sh-tab"
						onClick={() => setTab("agent")}
					>
						Agent edits{changes.length > 0 && <span className="sh-tab-count">{changes.length}</span>}
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={tab === "tree"}
						className="sh-tab"
						onClick={() => setTab("tree")}
					>
						Working tree
					</button>
				</div>
			)}
			{tab === "tree" && tree !== null ? (
				<WorkingTree client={tree.client} instanceId={tree.instanceId} host={host} />
			) : (
				<AgentEdits changes={changes} host={host} />
			)}
		</Sheet>
	);
}

/** Files the agent changed through its edit tools; tap a file for each change's diff. */
function AgentEdits({ changes, host }: { changes: readonly FileChange[]; host: ToolRenderHost }): ReactNode {
	const [open, setOpen] = useState<string | null>(changes.length === 1 ? (changes[0]?.path ?? null) : null);
	if (changes.length === 0) {
		return <div className="sh-companion-empty">The agent has not edited any files in this session yet.</div>;
	}
	return (
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
	);
}
