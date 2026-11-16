import { X } from "lucide-react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useRef } from "react";
import { type Active, activatePane, type PaneEntry, slotRef, tabKeyTarget, tabTitle } from "../../lib/workspace";
import "./workspace.css";

/** DOM ids that tie a tab to its panel (`aria-controls`, `aria-labelledby`). */
export const tabId = (active: Active): string => `ws-tab-${active}`;
export const panelId = (active: Active): string => `ws-panel-${active}`;

export interface WorkspaceTabsProps {
	/** The panes shown as tabs after the conversation, in the order they were opened. */
	tabs: readonly PaneEntry[];
	/** The tab in front. */
	active: Active;
}

/**
 * The strip over the main area while a pane is open as a tab: the conversation, then one tab per pane. The arrow
 * keys, Home and End move between tabs (the tab in front follows the focus); × and a middle click close the pane.
 */
export function WorkspaceTabs({ tabs, active }: WorkspaceTabsProps): ReactNode {
	const labels = useRef(new Map<Active, HTMLButtonElement>());
	const order: readonly Active[] = ["conversation", ...tabs.map(tab => tab.kind)];

	const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		const from = order.findIndex(id => labels.current.get(id) === document.activeElement);
		if (from < 0) return;
		const to = tabKeyTarget(event.key, from, order.length);
		if (to === null) return;
		event.preventDefault();
		const id = order[to];
		if (id === undefined) return;
		activatePane(id);
		labels.current.get(id)?.focus();
	};

	const onAuxClick = (event: MouseEvent<HTMLElement>, tab: PaneEntry): void => {
		if (event.button !== 1) return;
		event.preventDefault();
		tab.close();
	};

	const track = (id: Active) => (element: HTMLButtonElement | null) => {
		if (element === null) labels.current.delete(id);
		else labels.current.set(id, element);
	};

	return (
		<div className="sh-ws-tabs" role="tablist" aria-label="Main area" onKeyDown={onKeyDown}>
			<div className="sh-ws-tab" data-active={active === "conversation" ? "" : undefined}>
				<button
					ref={track("conversation")}
					type="button"
					role="tab"
					id={tabId("conversation")}
					className="sh-ws-tab-label"
					aria-selected={active === "conversation"}
					aria-controls={panelId("conversation")}
					tabIndex={active === "conversation" ? 0 : -1}
					onClick={() => activatePane("conversation")}
				>
					<span>Conversation</span>
				</button>
			</div>
			{tabs.map(tab => {
				const selected = active === tab.kind;
				const title = tabTitle(tab.label);
				return (
					<div
						key={tab.kind}
						className="sh-ws-tab"
						data-active={selected ? "" : undefined}
						onAuxClick={event => onAuxClick(event, tab)}
						// A middle press would start the browser's autoscroll.
						onMouseDown={event => {
							if (event.button === 1) event.preventDefault();
						}}
					>
						<button
							ref={track(tab.kind)}
							type="button"
							role="tab"
							id={tabId(tab.kind)}
							className="sh-ws-tab-label"
							aria-selected={selected}
							aria-controls={panelId(tab.kind)}
							tabIndex={selected ? 0 : -1}
							title={title}
							onClick={() => activatePane(tab.kind)}
						>
							<span>{title}</span>
						</button>
						<button
							type="button"
							className="sh-ws-tab-close"
							tabIndex={-1}
							aria-label={`Close ${tab.label}`}
							title="Close"
							onClick={tab.close}
						>
							<X size={13} />
						</button>
					</div>
				);
			})}
		</div>
	);
}

export interface TabSlotsProps {
	tabs: readonly PaneEntry[];
	active: Active;
}

/**
 * Where the panes opened as tabs are drawn: one element per tab, all of them in the page and the ones behind
 * hidden, so switching tabs never remounts a pane. Each pane's sheet portals into its element.
 */
export function TabSlots({ tabs, active }: TabSlotsProps): ReactNode {
	return tabs.map(tab => (
		<div
			key={tab.kind}
			ref={slotRef(tab.kind)}
			id={panelId(tab.kind)}
			className="sh-tab-slot"
			role="tabpanel"
			aria-labelledby={tabId(tab.kind)}
			data-pane="dock"
			hidden={active !== tab.kind}
		/>
	));
}
