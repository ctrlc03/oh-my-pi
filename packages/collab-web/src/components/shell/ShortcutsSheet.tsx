import type { ReactNode } from "react";
import { Fragment } from "react";
import { formatCombo, GESTURES, IS_MAC, SHORTCUTS, type ShortcutGroup } from "../../lib/shortcuts";
import { Sheet } from "./Sheet";
import "./shortcuts.css";

const GROUPS: readonly ShortcutGroup[] = ["Blocks", "Session", "View", "General"];

/** Every keyboard shortcut, read from the same table the handlers match against, and the touch gestures. */
export function ShortcutsSheet({ onClose }: { onClose(): void }): ReactNode {
	const shortcuts = Object.values(SHORTCUTS);
	return (
		<Sheet label="Keyboard shortcuts and gestures" onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">Shortcuts</div>
			</div>
			<div className="sh-keys">
				{GROUPS.map(group => (
					<Fragment key={group}>
						<h3 className="sh-keys-group">{group}</h3>
						<dl className="sh-keys-list">
							{shortcuts
								.filter(shortcut => shortcut.group === group)
								.map(shortcut => (
									<Fragment key={shortcut.label}>
										<dt>{shortcut.label}</dt>
										<dd>
											<kbd className="sh-kbd">{formatCombo(shortcut.keys, IS_MAC)}</kbd>
										</dd>
									</Fragment>
								))}
						</dl>
					</Fragment>
				))}
				<h3 className="sh-keys-group">Touch gestures</h3>
				<dl className="sh-keys-list">
					{GESTURES.map(item => (
						<Fragment key={item.gesture}>
							<dt>{item.gesture}</dt>
							<dd className="sh-keys-gesture">{item.label}</dd>
						</Fragment>
					))}
				</dl>
			</div>
		</Sheet>
	);
}
