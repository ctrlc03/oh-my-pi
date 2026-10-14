import { ArrowDown, ArrowUp, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import {
	isDefaultTopBar,
	moveTopBarItem,
	resetTopBar,
	setTopBar,
	showTopBarItem,
	topBarButton,
	useTopBar,
} from "../../lib/top-bar";
import { TOP_BAR_ICONS } from "../shell/top-bar-icons";

/** The session top bar's optional buttons: show or hide each, and move it up or down. The bar follows at once. */
export function TopBarControls(): ReactNode {
	const items = useTopBar();
	const last = items.length - 1;
	return (
		<div className="sh-appr-bar">
			<ul className="sh-appr-bar-list">
				{items.map((item, i) => {
					const { label, phone } = topBarButton(item.id);
					const Icon = TOP_BAR_ICONS[item.id];
					return (
						<li key={item.id} className="sh-appr-bar-item">
							<label className="sh-appr-bar-show">
								<input
									type="checkbox"
									checked={item.shown}
									onChange={e => setTopBar(showTopBarItem(items, item.id, e.currentTarget.checked))}
								/>
								<Icon size={15} aria-hidden="true" />
								<span>{label}</span>
								{!phone && <span className="sh-field-hint">Not on phones</span>}
							</label>
							{/* aria-disabled, not disabled: a button that disables itself under the keyboard drops its focus. */}
							<button
								type="button"
								className="sh-btn sh-btn-icon"
								aria-label={`Move ${label} up`}
								aria-disabled={i === 0}
								onClick={() => i > 0 && setTopBar(moveTopBarItem(items, item.id, -1))}
							>
								<ArrowUp size={14} />
							</button>
							<button
								type="button"
								className="sh-btn sh-btn-icon"
								aria-label={`Move ${label} down`}
								aria-disabled={i === last}
								onClick={() => i < last && setTopBar(moveTopBarItem(items, item.id, 1))}
							>
								<ArrowDown size={14} />
							</button>
						</li>
					);
				})}
			</ul>
			<button type="button" className="sh-btn" disabled={isDefaultTopBar(items)} onClick={resetTopBar}>
				<RotateCcw size={14} /> Reset top bar
			</button>
		</div>
	);
}
