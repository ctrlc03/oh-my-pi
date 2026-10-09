import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { applyUpdate, useUpdateReady } from "../../lib/pwa";

/** Offers a reload once a newer deploy is available; drafts, queued prompts, and the open room survive it. */
export function UpdateBar(): ReactNode {
	const ready = useUpdateReady();
	const [applying, setApplying] = useState(false);
	if (!ready) return null;
	return (
		<div className="sh-update" role="status">
			<span className="sh-toast-msg">A new version of the app is ready.</span>
			<button
				type="button"
				className="sh-btn sh-btn-primary sh-update-reload"
				disabled={applying}
				onClick={() => {
					setApplying(true);
					void applyUpdate();
				}}
			>
				<RefreshCw size={13} />
				{applying ? "Updating…" : "Reload"}
			</button>
		</div>
	);
}
