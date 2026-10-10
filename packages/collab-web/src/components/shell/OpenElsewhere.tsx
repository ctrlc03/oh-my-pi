import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { type SessionHolder, SessionOpenElsewhereError } from "../../lib/companion";

interface Conflict {
	holders: SessionHolder[];
	/** Resume anyway: the caller's own resume, sent with `force`. */
	force(): void;
}

function describe({ pid, tty, app }: SessionHolder): string {
	return `pid ${pid}${app ? ` in ${app}` : ""}${tty ? ` on ${tty}` : ""}`;
}

/**
 * The warning shown when the computer refuses to resume a session another omp has open. Call
 * `intercept` from the `catch` of every resume: it recognises the refusal and shows `notice` (put it
 * near the top of the sheet) with "Resume anyway" running `force`; any other error is for the caller.
 */
export function useOpenElsewhere(): {
	intercept(err: unknown, force: () => void): boolean;
	dismiss(): void;
	notice: ReactNode;
} {
	const [conflict, setConflict] = useState<Conflict | null>(null);
	const intercept = (err: unknown, force: () => void): boolean => {
		if (!(err instanceof SessionOpenElsewhereError)) return false;
		setConflict({ holders: err.holders, force });
		return true;
	};
	const notice = conflict && (
		<div className="sh-open-elsewhere" role="alert">
			<div className="sh-open-elsewhere-title">
				<TriangleAlert size={15} /> Already open on your computer
			</div>
			<div>
				Another omp has this session open ({conflict.holders.map(describe).join("; ")}). If you resume it here too,
				two copies write to the same session and their history gets mixed up.
			</div>
			<div className="sh-open-elsewhere-actions">
				<button type="button" className="sh-btn" onClick={() => setConflict(null)}>
					Cancel
				</button>
				<button
					type="button"
					className="sh-btn sh-btn-stop"
					onClick={() => {
						setConflict(null);
						conflict.force();
					}}
				>
					Resume anyway
				</button>
			</div>
		</div>
	);
	return { intercept, dismiss: () => setConflict(null), notice };
}
