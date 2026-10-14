import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { isStaleBuildError } from "../../lib/stale-build";

export interface LoadFailureProps {
	/** The thing that did not load, for the sentence: "the quizzes". */
	what: string;
	/** What was being done to it: "load" (the default) or "open". */
	verb?: string;
	error: Error;
	onRetry(): void;
}

/**
 * Why code or data a sheet needs did not load. A page whose build is gone cannot fix that by retrying: it says so,
 * and the app's update bar (`UpdateBar`) carries the Reload. Anything else offers a Retry.
 */
export function LoadFailure({ what, verb = "load", error, onRetry }: LoadFailureProps): ReactNode {
	if (isStaleBuildError(error)) {
		return (
			<div className="sh-tree-error">
				<div className="sh-connect-error">
					Could not {verb} {what}: the app was updated.
				</div>
			</div>
		);
	}
	return (
		<div className="sh-tree-error">
			<div className="sh-connect-error">
				Could not {verb} {what}: {error.message}
			</div>
			<button type="button" className="sh-btn" onClick={onRetry}>
				<RefreshCw size={14} /> Retry
			</button>
		</div>
	);
}
