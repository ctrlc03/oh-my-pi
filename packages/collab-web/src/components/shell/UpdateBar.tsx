import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { applyUpdate, useUpdateReady } from "../../lib/pwa";
import { STALE_BUILD_MESSAGE, useStaleBuild } from "../../lib/stale-build";

/**
 * Offers a reload once a newer deploy is available, or once a lazy chunk of this page is gone because the host now
 * serves another build; drafts, queued prompts, and the open room survive the reload. It never reloads by itself.
 */
export function UpdateBar(): ReactNode {
	const ready = useUpdateReady();
	const stale = useStaleBuild();
	const [applying, setApplying] = useState(false);
	if (!ready && !stale) return null;
	return (
		<div className="sh-update" role="status">
			<span className="sh-toast-msg">{stale ? STALE_BUILD_MESSAGE : "A new version of the app is ready."}</span>
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
