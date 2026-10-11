import { ShieldAlert, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { FULL_ACCESS_WARNING, PERMISSION_HINT, PERMISSION_LABEL, PERMISSIONS } from "../../lib/agents";
import type { ForeignPermission } from "../../lib/companion";
import "./agents.css";
import "./review.css";

export interface PermissionControlProps {
	value: ForeignPermission;
	onChange(permission: ForeignPermission): void;
}

/**
 * How a vendor agent's tool-permission requests are answered: Supervised asks the people in the session, Full access
 * approves every call. Going to Full access needs a confirmation; going back to Supervised does not.
 */
export function PermissionControl({ value, onChange }: PermissionControlProps): ReactNode {
	const [confirming, setConfirming] = useState(false);
	const choose = (choice: ForeignPermission): void => {
		if (choice === value) {
			setConfirming(false);
			return;
		}
		if (choice === "full") setConfirming(true);
		else {
			setConfirming(false);
			onChange(choice);
		}
	};
	return (
		<div className="sh-agent-perm">
			<div className="sh-segmented sh-segmented-fill" role="radiogroup" aria-label="Permissions">
				{PERMISSIONS.map(choice => (
					<button
						key={choice}
						type="button"
						role="radio"
						aria-checked={value === choice}
						className={value === choice ? "sh-segment sh-segment-on" : "sh-segment"}
						onClick={() => choose(choice)}
					>
						{choice === "full" && <ShieldAlert size={14} />} {PERMISSION_LABEL[choice]}
					</button>
				))}
			</div>
			{confirming ? (
				<div className="sh-review-confirm" role="group" aria-label="Confirm full access">
					<div className="sh-agent-warn">
						<TriangleAlert size={15} />
						<span>{FULL_ACCESS_WARNING}</span>
					</div>
					<div className="sh-review-confirm-actions">
						<button type="button" className="sh-btn" onClick={() => setConfirming(false)}>
							Cancel
						</button>
						<button
							type="button"
							className="sh-btn sh-btn-stop"
							onClick={() => {
								setConfirming(false);
								onChange("full");
							}}
						>
							<ShieldAlert size={14} /> Allow full access
						</button>
					</div>
				</div>
			) : (
				<span className="sh-field-hint">{PERMISSION_HINT[value]}</span>
			)}
		</div>
	);
}
