import { Bookmark, SquareSlash } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { GuestClient } from "../../lib/client";
import { loadQuickReplies } from "../../lib/quick-replies";
import { applySlash, matchSlash, type SlashItem, slashQuery } from "../../lib/slash-menu";
import "./slash-menu.css";

export interface SlashMenuOptions {
	client: GuestClient;
	/** The draft; the popup follows it. */
	text: string;
	/** This guest may type a prompt (never a view-only link). */
	enabled: boolean;
	/** Writes the chosen entry into the draft; nothing is sent. */
	onPick(text: string): void;
}

export interface SlashMenu {
	/** The popup, anchored above the composer field; null while closed. */
	menu: ReactNode;
	/** Offer a key to the popup first; true when it was used (the caller must not handle it again). */
	onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean;
}

function itemKey(item: SlashItem): string {
	return item.kind === "command" ? `c:${item.command.name}` : `s:${item.text}`;
}

/**
 * Typing `/` in the composer lists the host's slash commands (its `welcome.commands`) and
 * this device's saved prompts. Picking one only fills the draft: the host runs a command when
 * the prompt is sent, like any other message.
 */
export function useSlashMenu({ client, text, enabled, onPick }: SlashMenuOptions): SlashMenu {
	const listId = useId();
	const commands = useSyncExternalStore(
		useCallback(listener => client.subscribe(listener), [client]),
		() => client.getSnapshot().commands,
		() => client.getSnapshot().commands,
	);
	const query = enabled ? slashQuery(text) : null;
	const [dismissed, setDismissed] = useState<string | null>(null);
	// The highlighted row, for the query it was chosen under: a new query starts at the best match.
	const [cursor, setCursor] = useState({ query: "", at: 0 });
	const open = query !== null && dismissed !== text;
	// Saved prompts are re-read each time the popup opens: they are edited from the chip row.
	const saved = useMemo(() => (open ? loadQuickReplies() : []), [open]);
	const items = useMemo(
		() => (open && query !== null ? matchSlash(query, commands, saved) : []),
		[open, query, commands, saved],
	);
	const shown = items.length > 0;
	const index = cursor.query === query ? Math.min(cursor.at, Math.max(0, items.length - 1)) : 0;
	const activeRef = useRef<HTMLButtonElement | null>(null);

	useEffect(() => {
		activeRef.current?.scrollIntoView({ block: "nearest" });
	}, [index, shown]);

	const pick = (item: SlashItem): void => {
		onPick(applySlash(item));
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
		if (!shown || e.nativeEvent.isComposing) return false;
		const chosen = items[index];
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			const step = e.key === "ArrowDown" ? 1 : -1;
			setCursor({ query: query ?? "", at: (index + step + items.length) % items.length });
			return true;
		}
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			setDismissed(text);
			return true;
		}
		if (e.key === "Tab" && !e.shiftKey) {
			e.preventDefault();
			pick(chosen);
			return true;
		}
		// Enter on a command that is already fully typed sends it; on anything else it completes the entry.
		if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
			if (chosen.kind === "command" && chosen.command.name === query) return false;
			e.preventDefault();
			pick(chosen);
			return true;
		}
		return false;
	};

	const menu = shown ? (
		<div className="sh-slash">
			<div className="sh-slash-list" role="listbox" id={listId} aria-label="slash commands">
				{items.map((item, i) => {
					const on = i === index;
					return (
						<button
							key={itemKey(item)}
							ref={on ? activeRef : undefined}
							type="button"
							role="option"
							aria-selected={on}
							className={`sh-slash-item${on ? " sh-slash-item-on" : ""}`}
							// Keep the caret in the textarea so the keyboard stays up on phones.
							onMouseDown={e => e.preventDefault()}
							onClick={() => pick(item)}
						>
							{item.kind === "command" ? (
								<>
									<SquareSlash size={14} className="sh-slash-icon" />
									<span className="sh-slash-name">/{item.command.name}</span>
									{item.command.args && <span className="sh-slash-args">{item.command.args}</span>}
									{item.command.description && (
										<span className="sh-slash-desc">{item.command.description}</span>
									)}
								</>
							) : (
								<>
									<Bookmark size={14} className="sh-slash-icon" />
									<span className="sh-slash-saved">{item.text.replace(/\s+/g, " ").trim()}</span>
									<span className="sh-slash-tag">saved</span>
								</>
							)}
						</button>
					);
				})}
			</div>
		</div>
	) : null;

	return { menu, onKeyDown };
}
