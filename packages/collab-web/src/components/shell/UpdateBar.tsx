import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useUpdateReady } from "../../lib/pwa";

/** Offers a reload once a newer deploy controls the page; drafts, queued prompts, and the open room survive it. */
export function UpdateBar(): ReactNode {
	if (!useUpdateReady()) return null;
	return (
		<div className="sh-update" role="status">
			<span className="sh-toast-msg">A new version of the app is ready.</span>
			<button
				type="button"
				className="sh-btn sh-btn-primary sh-update-reload"
				onClick={() => window.location.reload()}
			>
				<RefreshCw size={13} />
				Reload
			</button>
		</div>
	);
}
