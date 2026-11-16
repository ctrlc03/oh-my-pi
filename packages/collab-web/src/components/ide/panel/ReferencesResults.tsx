import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo } from "react";
import type { LspLocation } from "../../../lib/repo-intel";
import { baseName } from "../file-tree";
import { groupLocations, resultCounts } from "../explorer/search-model";

export interface ReferencesResultsProps {
	/** The editor's last find-references answer; null before the first. */
	references: { title: string; locations: LspLocation[] } | null;
	onOpen(path: string, line: number, character: number): void;
	onClear(): void;
}

/**
 * The editor's last find-references answer: locations by file, with the line each one is on. Those in the repository
 * open on a click; the rest (a dependency, the standard library) are listed greyed with their absolute path.
 */
export function ReferencesResults({ references, onOpen, onClear }: ReferencesResultsProps): ReactNode {
	const locations = references?.locations;
	const groups = useMemo(() => (locations === undefined ? [] : groupLocations(locations)), [locations]);
	if (references === null || locations === undefined) {
		return <div className="sh-ex-note">Find references (Shift+F12) lists where a symbol is used.</div>;
	}
	return (
		<>
			<div className="sh-ex-tools">
				<span className="sh-ex-branch-name" title={references.title}>
					{references.title}
				</span>
				<button
					type="button"
					className="sh-ex-icon-btn"
					onClick={onClear}
					aria-label="Clear references"
					title="Clear"
				>
					<X size={14} />
				</button>
			</div>
			<div className="sh-ex-scroll">
				{locations.length === 0 ? (
					<div className="sh-ex-note">No references found.</div>
				) : (
					<>
						<div className="sh-ex-counts-head">{resultCounts(locations.length, groups.length)}</div>
						{groups.map(group => {
							const inRepo = group.items[0]?.inRepo === true;
							return (
								<section
									key={`${inRepo ? "repo" : "out"}:${group.path}`}
									className="sh-ex-group"
									aria-label={group.path}
									data-outside={inRepo ? undefined : "true"}
								>
									<div className="sh-ex-row sh-ex-file-head" title={group.path}>
										<span className="sh-ex-name">{inRepo ? baseName(group.path) : group.path}</span>
										{inRepo && group.path.includes("/") && (
											<span className="sh-ex-dir">{group.path.slice(0, group.path.lastIndexOf("/"))}</span>
										)}
										{!inRepo && <span className="sh-ex-dir">outside this repository</span>}
										<span className="sh-ex-count">{group.items.length}</span>
									</div>
									<ul className="sh-ex-list">
										{group.items.map(location => {
											const { line, character } = location.range.start;
											const body = (
												<>
													<span className="sh-ex-line">{line}</span>
													<span className="sh-ex-text">{location.preview ?? ""}</span>
												</>
											);
											return (
												<li key={`${line}:${character}`}>
													{inRepo ? (
														<button
															type="button"
															className="sh-ex-row sh-ex-match"
															onClick={() => onOpen(location.path, line, character)}
															title={`${location.path}:${line}`}
														>
															{body}
														</button>
													) : (
														<div
															className="sh-ex-row sh-ex-match"
															aria-disabled="true"
															title={`${location.path}:${line}`}
														>
															{body}
														</div>
													)}
												</li>
											);
										})}
									</ul>
								</section>
							);
						})}
					</>
				)}
			</div>
		</>
	);
}
