import { CircleX, Info, Lightbulb, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { baseName } from "../file-tree";
import type { ProblemRow } from "../problems";

export interface ProblemsViewProps {
	/** Worst first (see `sortProblems`). */
	rows: readonly ProblemRow[];
	/** What to say when there are none: no language server, or a clean bill. */
	emptyNote: string;
	onOpen(path: string, line: number, character: number): void;
}

const ICONS = { error: CircleX, warning: TriangleAlert, info: Info, hint: Lightbulb } as const;

/** The language server's diagnostics of every open file. A click opens the file at the problem. */
export function ProblemsView({ rows, emptyNote, onOpen }: ProblemsViewProps): ReactNode {
	if (rows.length === 0) return <div className="sh-ex-note">{emptyNote}</div>;
	return (
		<ul className="sh-pb-list">
			{rows.map((row, i) => {
				const Icon = ICONS[row.severity];
				const where = `${row.path}:${row.line}:${row.character + 1}`;
				return (
					<li key={`${where}:${i}`}>
						<button
							type="button"
							className="sh-pb-row"
							data-severity={row.severity}
							onClick={() => onOpen(row.path, row.line, row.character)}
							title={`${where}\n${row.message}`}
						>
							<Icon size={14} className="sh-pb-icon" aria-label={row.severity} />
							<span className="sh-pb-message">{row.message}</span>
							{(row.source !== undefined || row.code !== undefined) && (
								<span className="sh-pb-source">
									{row.source}
									{row.code !== undefined && ` (${row.code})`}
								</span>
							)}
							<span className="sh-pb-where">
								{baseName(row.path)}:{row.line}:{row.character + 1}
							</span>
						</button>
					</li>
				);
			})}
		</ul>
	);
}
