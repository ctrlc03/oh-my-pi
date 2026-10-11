import type { SessionCommand } from "@oh-my-pi/pi-wire";
import { Scissors } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { ContextItemsInfo } from "../../lib/client";
import { fmtPercent, fmtTokens } from "../../lib/format";
import "./context-items.css";

export interface ContextItemsProps {
	/** Latest ranking from the host; null until the first reply. */
	info: ContextItemsInfo | null;
	/** Pruning rewrites the host's context, so view-only guests only look. */
	canPrune: boolean;
	onSessionCommand(cmd: SessionCommand, arg?: string): void;
}

/**
 * "What fills the context": the host's largest items (tool results, files, attachments, the
 * system prompt, tool schemas) with a prune button on the ones it can elide. Asks the host for
 * the ranking when opened; a prune is answered with the refreshed ranking.
 */
export function ContextItems({ info, canPrune, onSessionCommand }: ContextItemsProps): ReactNode {
	const [open, setOpen] = useState(false);
	// The id being pruned; the host's refreshed ranking (a new `info`) ends the wait.
	const [pruning, setPruning] = useState<string | null>(null);
	useEffect(() => setPruning(null), [info]);

	const toggle = (): void => {
		if (!open) onSessionCommand("context-items");
		setOpen(!open);
	};

	return (
		<div className="sh-ctxitems">
			<button type="button" className="sh-btn" onClick={toggle} aria-expanded={open}>
				{open ? "Hide" : "Show what fills the context"}
			</button>
			{open && info === null && <span className="sh-sheet-faint">Asking the host…</span>}
			{open && info !== null && (
				<>
					{info.pruned && (
						<span className="sh-sheet-faint">
							Pruned {info.pruned.entries} {info.pruned.entries === 1 ? "entry" : "entries"}, freed ~
							{fmtTokens(info.pruned.tokensFreed)} tokens
						</span>
					)}
					<ol className="sh-ctxitems-list">
						{info.items.map(item => (
							<li key={item.id} className="sh-ctxitems-row">
								<span className="sh-ctxitems-label sh-sheet-mono" title={item.label}>
									{item.label}
								</span>
								<span className="sh-ctxitems-figure sh-sheet-faint">
									{fmtTokens(item.tokens)} · {fmtPercent(item.share * 100)}
								</span>
								<span className="sh-gauge-track sh-ctxitems-bar">
									<span className="sh-gauge-fill" style={{ width: `${Math.min(100, item.share * 100)}%` }} />
								</span>
								{canPrune && item.prunable ? (
									<button
										type="button"
										className="sh-btn sh-btn-icon"
										onClick={() => {
											setPruning(item.id);
											onSessionCommand("context-prune", item.id);
										}}
										disabled={pruning !== null}
										aria-label={`prune ${item.label} from the context`}
										title="Prune from the context"
									>
										<Scissors size={14} />
									</button>
								) : (
									<span className="sh-ctxitems-fixed sh-sheet-faint">{item.prunable ? "" : "fixed"}</span>
								)}
							</li>
						))}
					</ol>
				</>
			)}
		</div>
	);
}
