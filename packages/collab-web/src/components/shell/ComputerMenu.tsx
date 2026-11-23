import { ArrowDown, ArrowUp } from "lucide-react";
import type { ReactNode } from "react";
import { OrgMenuHead } from "./OrgMenu";
import { Sheet } from "./Sheet";

export interface ComputerMenuProps {
	name: string;
	/** Where the computer stands among the groups. */
	place: { index: number; count: number };
	onMove(to: number): void;
	onClose(): void;
}

/** A computer group's menu: the keyboard and touch way to arrange the groups, which a mouse also does by dragging the heading. */
export function ComputerMenu({ name, place, onMove, onClose }: ComputerMenuProps): ReactNode {
	const move = (to: number): void => {
		onMove(to);
		onClose();
	};
	return (
		<Sheet label={`arrange ${name}`} fixed onClose={onClose}>
			<OrgMenuHead title={name} onClose={onClose} />
			<div className="sh-org-menu">
				{place.index > 0 && (
					<button type="button" className="sh-btn sh-org-menu-item" onClick={() => move(place.index - 1)}>
						<ArrowUp size={15} /> Move up
					</button>
				)}
				{place.index < place.count - 1 && (
					<button type="button" className="sh-btn sh-org-menu-item" onClick={() => move(place.index + 1)}>
						<ArrowDown size={15} /> Move down
					</button>
				)}
			</div>
		</Sheet>
	);
}
