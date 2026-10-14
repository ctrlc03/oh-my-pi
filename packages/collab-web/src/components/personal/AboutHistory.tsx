import type { PersonalDiffLine } from "@oh-my-pi/pi-wire/personal";
import { ChevronDown, ChevronRight, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { relTime } from "../../lib/format";
import { diffRows } from "../../lib/personal";
import { aboutVersionBy, aboutVersionDiff } from "../../lib/personal-about";
import { usePersonal, usePersonalQuery } from "../../lib/use-personal";
import { QueryView } from "./shared";
import "./memory.css";

/** Revisions asked for; the companion keeps them all. */
const HISTORY_LIMIT = 20;

/** Changed lines with a little context around them; `empty` says so when nothing changed. */
export function DiffBlock({
	lines,
	label,
	empty = "No changes.",
}: {
	lines: readonly PersonalDiffLine[];
	label: string;
	empty?: string;
}): ReactNode {
	if (lines.every(line => line.op === "keep")) return <div className="sh-field-hint">{empty}</div>;
	return (
		<div className="pa-dl" role="list" aria-label={label}>
			{diffRows(lines).map((row, i) => (
				<div
					key={i}
					role="listitem"
					className={`pa-dl-row pa-dl-${row.op}`}
					aria-label={`${row.word}: ${row.text}`}
				>
					<span className="pa-dl-mark" aria-hidden="true">
						{row.marker}
					</span>
					<span className="pa-dl-text">{row.text}</span>
				</div>
			))}
		</div>
	);
}

/** Every revision of About you, newest first. Restoring one only fills the editor; nothing is saved until the owner saves. */
export function AboutHistory({ onRestore }: { onRestore(text: string, rev: number): void }): ReactNode {
	const personal = usePersonal();
	const [open, setOpen] = useState(false);
	const [viewing, setViewing] = useState<number | null>(null);
	const query = usePersonalQuery(
		personal,
		["about"],
		call => call({ t: "personal-about-history", limit: HISTORY_LIMIT }),
		open,
	);
	const Chevron = open ? ChevronDown : ChevronRight;
	return (
		<section className="pa-hist" aria-labelledby="pa-hist-title">
			<h3 id="pa-hist-title" className="pa-card-title">
				<button
					type="button"
					className="pa-hist-toggle"
					aria-expanded={open}
					aria-controls="pa-hist-body"
					onClick={() => setOpen(!open)}
				>
					<Chevron size={15} aria-hidden="true" /> History
				</button>
			</h3>
			<div className="sh-field-hint">Every revision is kept: you can look at any of them and bring it back.</div>
			{open && (
				<div id="pa-hist-body">
					<QueryView query={query} what="history">
						{({ versions }) => (
							<>
								<ol className="pa-hist-list">
									{versions.map((version, i) => {
										const diff = viewing === version.rev ? aboutVersionDiff(versions, i) : null;
										return (
											<li key={version.rev} className="pa-hist-item">
												<div className="pa-hist-head">
													<span className="pa-hist-rev">rev {version.rev}</span>
													<span title={new Date(version.at).toLocaleString()}>{relTime(version.at)}</span>
													<span>{aboutVersionBy(version)}</span>
													{i === 0 && <span className="pa-chip-state pa-chip-pinned">Latest</span>}
												</div>
												<div className="pa-actions">
													<button
														type="button"
														className="sh-btn pa-mem-act"
														aria-expanded={viewing === version.rev}
														aria-label={`View the changes in revision ${version.rev}`}
														onClick={() => setViewing(viewing === version.rev ? null : version.rev)}
													>
														View changes
													</button>
													<button
														type="button"
														className="sh-btn pa-mem-act"
														aria-label={`Restore revision ${version.rev} into the editor`}
														onClick={() => onRestore(version.text, version.rev)}
													>
														<RotateCcw size={13} aria-hidden="true" /> Restore into editor
													</button>
												</div>
												{viewing === version.rev &&
													(diff === null ? (
														<>
															<div className="sh-field-hint">
																The revision before this one is older than the {HISTORY_LIMIT} shown, so
																the whole text is listed.
															</div>
															<pre className="pa-hist-text">{version.text}</pre>
														</>
													) : (
														<DiffBlock lines={diff} label={`Changes in revision ${version.rev}`} />
													))}
											</li>
										);
									})}
								</ol>
								{versions.length >= HISTORY_LIMIT && (
									<div className="sh-field-hint">The newest {HISTORY_LIMIT} revisions are listed.</div>
								)}
							</>
						)}
					</QueryView>
				</div>
			)}
		</section>
	);
}
