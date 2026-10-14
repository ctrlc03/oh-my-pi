import type { PersonalExportFormat } from "@oh-my-pi/pi-wire/personal";
import { Download, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { saveBlob } from "../../lib/download";
import { assembleExport } from "../../lib/personal";
import { exportFileName } from "../../lib/personal-memory";
import { usePersonal } from "../../lib/use-personal";
import { useAction } from "./shared";
import "./memory.css";

const FORMATS: readonly { format: PersonalExportFormat; label: string }[] = [
	{ format: "json", label: "JSON" },
	{ format: "markdown", label: "Markdown" },
];

/** Saves every memory to this device, in one file. */
export function MemoryExport(): ReactNode {
	const personal = usePersonal();
	const action = useAction();
	const [format, setFormat] = useState<PersonalExportFormat | null>(null);
	const [part, setPart] = useState(0);
	const [saved, setSaved] = useState<string | null>(null);

	const run = async (chosen: PersonalExportFormat): Promise<void> => {
		setFormat(chosen);
		setPart(0);
		setSaved(null);
		await action.run(async () => {
			let parts = 0;
			const file = await assembleExport(offset => {
				setPart(++parts);
				return personal.call({ t: "personal-memory-export", format: chosen, offset });
			});
			const name = exportFileName(file.name, chosen);
			const result = await saveBlob(new Blob([file.text], { type: file.mime }), name);
			if (result !== "cancelled") setSaved(name);
		});
	};

	return (
		<div className="pa-export">
			<div className="pa-export-row">
				<span className="sh-field-label">Export</span>
				<div className="pa-actions" role="group" aria-label="Export memories">
					{FORMATS.map(({ format: id, label }) => (
						<button
							key={id}
							type="button"
							className="sh-btn pa-mem-act"
							aria-label={`Export memories as ${label}`}
							disabled={action.busy}
							onClick={() => void run(id)}
						>
							{action.busy && format === id ? (
								<LoaderCircle size={14} className="sh-spin" aria-hidden="true" />
							) : (
								<Download size={14} aria-hidden="true" />
							)}
							{label}
						</button>
					))}
				</div>
			</div>
			<div className="sh-field-hint" role="status">
				{action.busy
					? `Collecting memories${part > 1 ? ` (part ${part})` : ""}…`
					: saved === null
						? "Includes retracted and replaced memories."
						: `Saved ${saved}. Includes retracted and replaced memories.`}
			</div>
			{action.error !== null && <div className="sh-connect-error">{action.error}</div>}
		</div>
	);
}
