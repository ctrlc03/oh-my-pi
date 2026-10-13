import type { Blueprint } from "@oh-my-pi/pi-wire/blueprint";
import { Download, LoaderCircle, TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import { fmtBytes } from "../../lib/format";
import type { MapSource } from "./DetailPanel";
import type { ExportPlan, ExportProgress, ExportScope } from "./blueprint-export";
import {
	buildHtml,
	collectPayload,
	exportFilename,
	planExports,
	STANDALONE_SCRIPT,
	STANDALONE_STYLE,
} from "./blueprint-export";

/** One of the viewer's built files, next to the app's own. */
async function fetchAsset(name: string): Promise<string> {
	const url = new URL(name, document.baseURI);
	let response: Response;
	try {
		response = await fetch(url, { cache: "no-cache" });
	} catch {
		throw new Error("The standalone viewer could not be fetched. Check the connection and try again.");
	}
	if (!response.ok) {
		throw new Error(
			`The standalone viewer (${name}) is not part of this app build (${response.status}); export works from a built app.`,
		);
	}
	return response.text();
}

function download(html: string, filename: string): void {
	const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	document.body.append(link);
	link.click();
	link.remove();
	// The download has started once click returns; the object URL can go a moment later.
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function describePlan(plan: ExportPlan): string {
	const places = `${plan.citations.toLocaleString()} ${plan.citations === 1 ? "place" : "places"} in ${plan.files.toLocaleString()} ${plan.files === 1 ? "file" : "files"}`;
	return `${places}, about ${fmtBytes(plan.bytes)}${plan.highlighted ? "" : ", without syntax colours"}`;
}

function describeProgress(progress: ExportProgress): string {
	return progress.phase === "reading"
		? `Reading the code: ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}`
		: `Colouring the code: ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} lines`;
}

/** "Download HTML": what the page will carry and weigh, then one standalone file that opens offline. */
export function ExportMenu({ map, source }: { map: Blueprint; source: MapSource }): ReactNode {
	const [open, setOpen] = useState(false);
	const [scope, setScope] = useState<ExportScope>("diagrams");
	const [progress, setProgress] = useState<ExportProgress | null>(null);
	const [error, setError] = useState<string | null>(null);
	const abort = useRef<AbortController | null>(null);
	// Planning reads the whole map once; it waits until the menu is opened.
	const plans = useMemo(() => (open ? planExports(map) : null), [open, map]);
	const working = progress !== null;
	// A map with no index diagrams has only one thing to export.
	const choice = plans !== null && plans.all.citations > plans.diagrams.citations;

	const run = async (): Promise<void> => {
		const controller = new AbortController();
		abort.current = controller;
		setError(null);
		setProgress({ phase: "reading", done: 0, total: 0 });
		try {
			const [payload, script, style] = await Promise.all([
				collectPayload(map, source, choice ? scope : "diagrams", {
					onProgress: setProgress,
					signal: controller.signal,
				}),
				fetchAsset(STANDALONE_SCRIPT),
				fetchAsset(STANDALONE_STYLE),
			]);
			download(buildHtml(payload, { script, style }), exportFilename(map));
			setOpen(false);
		} catch (err) {
			if (!(err instanceof DOMException && err.name === "AbortError")) {
				setError(err instanceof Error ? err.message : String(err));
			}
		} finally {
			abort.current = null;
			setProgress(null);
		}
	};

	return (
		<div className="ar-export">
			<button
				type="button"
				className={open ? "ar-btn ar-btn-on" : "ar-btn"}
				onClick={() => setOpen(value => !value)}
				aria-expanded={open}
				aria-label="Export as an HTML file"
			>
				<Download size={15} />
				<span className="ar-btn-text">Export</span>
			</button>
			{open && plans !== null && (
				<div className="ar-popover" role="dialog" aria-label="Export as an HTML file">
					<div className="ar-popover-head">
						<h3 className="ar-popover-title">Export as an HTML file</h3>
						<button
							type="button"
							className="ar-btn ar-btn-icon ar-btn-small"
							onClick={() => {
								abort.current?.abort();
								setOpen(false);
							}}
							aria-label="Close"
						>
							<X size={14} />
						</button>
					</div>
					<p className="ar-panel-note">
						One file with the map and the viewer: it opens from disk with no network, and every arrow still opens
						its code.
					</p>
					{choice ? (
						<div className="ar-choices" role="radiogroup" aria-label="Code to include">
							{(["diagrams", "all"] as const).map(value => (
								<button
									key={value}
									type="button"
									role="radio"
									aria-checked={scope === value}
									disabled={working}
									className={scope === value ? "ar-choice ar-choice-on" : "ar-choice"}
									onClick={() => setScope(value)}
								>
									<span className="ar-choice-title">
										{value === "diagrams" ? "Code of the main diagrams" : "All the code"}
									</span>
									<span className="ar-choice-sub">{describePlan(plans[value])}</span>
									{value === "diagrams" && (
										<span className="ar-choice-sub">
											Folder, file and symbol diagrams keep their shape; their arrows show the file and line,
											without code.
										</span>
									)}
								</button>
							))}
						</div>
					) : (
						<p className="ar-panel-note">{describePlan(plans.diagrams)}.</p>
					)}
					{working && (
						<div className="ar-status" role="status">
							<LoaderCircle size={14} className="ar-spin" />
							{progress.total === 0 ? "Starting" : describeProgress(progress)}
						</div>
					)}
					{error !== null && (
						<div className="ar-error" role="alert">
							<TriangleAlert size={14} /> {error}
						</div>
					)}
					<div className="ar-popover-actions">
						{working ? (
							<button type="button" className="ar-btn" onClick={() => abort.current?.abort()}>
								Cancel
							</button>
						) : (
							<button type="button" className="ar-btn ar-btn-on" onClick={() => void run()}>
								<Download size={15} /> Download
							</button>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
