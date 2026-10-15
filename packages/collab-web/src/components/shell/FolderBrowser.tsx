import { ArrowUp, Folder, FolderGit2, Home, LoaderCircle, RefreshCw } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanionClient, FolderListing, RecentFolder } from "../../lib/companion";
import { useRequest } from "../../lib/use-request";

/** Where a listing is asked for: `undefined` is the computer's home folder. A new object asks again, even for the same path. */
interface Target {
	path: string | undefined;
}

const ROW = "button.sh-recent-join";

/**
 * The folders of the computer, one level at a time, to start a session in any of them. The path field shows where the list is and
 * takes a path to jump to (Enter); a folder row opens that folder; *Use this folder* picks the one on screen. The companion lists
 * the folders: nothing here reads the computer's disk.
 */
export function FolderBrowser({
	client,
	onPick,
}: {
	client: CompanionClient;
	/** The folder on screen was chosen: continue as for a recent folder, which has no sessions. */
	onPick(folder: RecentFolder): void;
}): ReactNode {
	const [target, setTarget] = useState<Target>({ path: undefined });
	const [hidden, setHidden] = useState(false);
	const [typed, setTyped] = useState("");
	const load = useCallback(() => client.requestBrowseFolders(target.path, hidden), [client, target, hidden]);
	const { state } = useRequest(load);
	const listing: FolderListing | null = state.status === "ready" ? state.value : null;
	const input = useRef<HTMLInputElement>(null);
	const rows = useRef<HTMLUListElement>(null);
	/** The path of the row to focus once the next listing is on screen ("" for the first); null leaves focus alone. */
	const focusAfter = useRef<string | null>(null);

	// The field always shows the folder on screen, which may differ from what was typed (`~`, a trailing slash).
	useEffect(() => {
		if (listing !== null) setTyped(listing.path);
	}, [listing]);
	// A path wider than the field shows its end, the folder that matters, until the person edits it.
	useEffect(() => {
		const field = input.current;
		if (field !== null && document.activeElement !== field) field.scrollLeft = field.scrollWidth;
	}, [typed]);
	useEffect(() => {
		if (listing === null || focusAfter.current === null) return;
		const want = focusAfter.current;
		focusAfter.current = null;
		const buttons = Array.from(rows.current?.querySelectorAll<HTMLButtonElement>(ROW) ?? []);
		(buttons.find(button => button.dataset.path === want) ?? buttons[0] ?? input.current)?.focus();
	}, [listing]);

	const open = (path: string | undefined, focus: string | null): void => {
		focusAfter.current = focus;
		setTarget({ path });
	};
	const submit = (e: KeyboardEvent<HTMLInputElement>): void => {
		if (e.key === "Enter" && !e.nativeEvent.isComposing) {
			e.preventDefault();
			open(typed.trim() === "" ? undefined : typed, null);
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			rows.current?.querySelector<HTMLButtonElement>(ROW)?.focus();
		}
	};
	/** Arrow keys walk the rows; ArrowUp from the first goes back to the path field. */
	const walk = (e: KeyboardEvent<HTMLUListElement>): void => {
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>(ROW));
		const at = buttons.findIndex(button => button === document.activeElement);
		if (at < 0) return;
		e.preventDefault();
		if (e.key === "ArrowDown") buttons[at + 1]?.focus();
		else (buttons[at - 1] ?? input.current)?.focus();
	};

	return (
		<div className="sh-browse">
			<div className="sh-browse-bar">
				<button
					type="button"
					className="sh-btn sh-btn-icon"
					aria-label="Go to parent folder"
					disabled={listing === null || listing.parent === null}
					onClick={() => listing?.parent != null && open(listing.parent, listing.path)}
				>
					<ArrowUp size={16} />
				</button>
				<input
					ref={input}
					className="sh-input sh-input-mono sh-browse-path"
					value={typed}
					onChange={e => setTyped(e.currentTarget.value)}
					onKeyDown={submit}
					placeholder="~/code/project"
					aria-label="Folder path"
					enterKeyHint="go"
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
				/>
			</div>
			<div className="sh-browse-actions">
				<label className="sh-browse-hidden">
					<input type="checkbox" checked={hidden} onChange={e => setHidden(e.currentTarget.checked)} />
					<span>Show hidden folders</span>
				</label>
				<button
					type="button"
					className="sh-btn sh-btn-primary sh-browse-use"
					disabled={listing === null}
					onClick={() => listing !== null && onPick({ cwd: listing.path, lastActive: 0, sessions: [] })}
				>
					Use this folder
				</button>
			</div>
			{state.status === "loading" ? (
				<div className="sh-companion-empty sh-file-status" role="status">
					<LoaderCircle size={14} className="sh-spin" /> Loading folders…
				</div>
			) : state.status === "error" ? (
				<div className="sh-tree-error">
					<div className="sh-connect-error">{state.message}</div>
					<div className="sh-browse-recover">
						<button type="button" className="sh-btn" onClick={() => open(target.path, null)}>
							<RefreshCw size={14} /> Retry
						</button>
						<button type="button" className="sh-btn" onClick={() => open(undefined, null)}>
							<Home size={14} /> Home folder
						</button>
					</div>
				</div>
			) : state.value.folders.length === 0 ? (
				<div className="sh-companion-empty">No folders in here.</div>
			) : (
				<>
					<ul className="sh-recents-list sh-browse-list" ref={rows} onKeyDown={walk} aria-label="Folders">
						{state.value.folders.map(folder => (
							<li key={folder.path} className="sh-recent">
								<button
									type="button"
									className="sh-recent-join"
									data-path={folder.path}
									onClick={() => open(folder.path, "")}
								>
									<span className="sh-recent-title">
										{folder.git ? <FolderGit2 size={14} /> : <Folder size={14} />}
										<span className="sh-recent-name">{folder.name}</span>
									</span>
									{folder.git && (
										<span className="sh-recent-meta">
											<span>Git repository</span>
										</span>
									)}
								</button>
							</li>
						))}
					</ul>
					{state.value.truncated && (
						<div className="sh-field-hint">Showing the first {state.value.folders.length} folders.</div>
					)}
				</>
			)}
		</div>
	);
}
