import { ArrowRight, ClipboardPaste, Eye, Lock, ScanLine, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { extractPairing } from "../../lib/companion";
import { relTime, shortenPath } from "../../lib/format";
import type { PushControl } from "../../lib/push";
import { extractLink, type RecentRoom } from "../../lib/rooms";
import type { CompanionHandle } from "../../lib/use-companion";
import { CompanionCard } from "./CompanionCard";
import { OmpMark } from "./OmpMark";
import { QrScanner } from "./QrScanner";
import { ThemeToggle } from "./ThemeToggle";

export interface ConnectScreenProps {
	defaultName: string;
	error: string | null;
	/** Recently joined rooms, newest first. */
	rooms: readonly RecentRoom[];
	/** The paired computer's companion, if any. */
	companion: CompanionHandle | null;
	push: PushControl;
	onConnect(link: string, name: string): void;
	onForget(roomId: string): void;
	onPair(link: string): void;
	onUnpair(): void;
}

export function ConnectScreen({
	defaultName,
	error,
	rooms,
	companion,
	push,
	onConnect,
	onForget,
	onPair,
	onUnpair,
}: ConnectScreenProps): ReactNode {
	const [link, setLink] = useState("");
	const [name, setName] = useState(defaultName);
	const [localError, setLocalError] = useState<string | null>(null);
	const [scanning, setScanning] = useState(false);

	/** Joins a session link, or pairs when handed a companion pairing link. */
	const join = (raw: string): void => {
		const trimmed = raw.trim();
		if (!trimmed) {
			setLocalError("Paste a join link first.");
			return;
		}
		setLocalError(null);
		const companion = extractPairing(trimmed);
		if (companion) {
			setLink("");
			onPair(companion);
			return;
		}
		onConnect(extractLink(trimmed) ?? trimmed, name.trim() || "guest");
	};

	const submit = (e: FormEvent<HTMLFormElement>): void => {
		e.preventDefault();
		join(link);
	};

	// One tap from "copied on the Mac" (Universal Clipboard) to joined. A clipboard
	// without a collab link only fills the field, so the user can see what was pasted.
	const paste = async (): Promise<void> => {
		let text: string;
		try {
			text = await navigator.clipboard.readText();
		} catch {
			setLocalError("Clipboard access was blocked. Long-press the field and paste instead.");
			return;
		}
		if (extractPairing(text) || extractLink(text)) join(text);
		else {
			setLink(text.trim());
			setLocalError("The clipboard does not hold an omp collab link.");
		}
	};

	const shown = localError ?? error;
	const canPaste = typeof navigator !== "undefined" && typeof navigator.clipboard?.readText === "function";

	return (
		<div className="sh-connect">
			<div className="sh-ambient" />
			<div className="sh-connect-top">
				<div className="sh-brand">
					<OmpMark />
					<span>omp</span>
					<span className="sh-brand-slash">/</span>
					<span className="sh-brand-app">collab</span>
				</div>
				<ThemeToggle />
			</div>
			<div className="sh-connect-stack">
				{companion && (
					<CompanionCard
						companion={companion}
						push={push}
						onJoin={next => {
							setLocalError(null);
							onConnect(next, name.trim() || "guest");
						}}
						onUnpair={onUnpair}
					/>
				)}
				{rooms.length > 0 && (
					<section className="sh-connect-card sh-recents" aria-label="recent sessions">
						<h2 className="sh-recents-title">Recent sessions</h2>
						<ul className="sh-recents-list">
							{rooms.map(room => (
								<li key={room.roomId} className="sh-recent">
									<button
										type="button"
										className="sh-recent-join"
										onClick={() => join(room.link)}
										title={room.cwd ?? room.title}
									>
										<span className="sh-recent-title">
											<span className="sh-recent-name">{room.title}</span>
											{room.readOnly && <Eye size={13} aria-label="view-only" />}
										</span>
										<span className="sh-recent-meta">
											{room.cwd && <span className="sh-recent-cwd">{shortenPath(room.cwd)}</span>}
											<span>{relTime(room.lastSeen)}</span>
										</span>
									</button>
									<button
										type="button"
										className="sh-btn sh-btn-icon"
										onClick={() => onForget(room.roomId)}
										aria-label={`forget ${room.title}`}
										title="forget"
									>
										<X size={15} />
									</button>
								</li>
							))}
						</ul>
					</section>
				)}
				<form className="sh-connect-card" onSubmit={submit}>
					<div className="sh-connect-head">
						<h1 className="sh-connect-title">Join a live session</h1>
						<p className="sh-connect-sub">
							Watch an omp agent work in real time — transcript, tool calls and subagents — and prompt it from
							here.
						</p>
					</div>
					<div className="sh-connect-quick">
						{canPaste && (
							<button type="button" className="sh-btn sh-btn-primary" onClick={() => void paste()}>
								<ClipboardPaste size={16} /> Paste link
							</button>
						)}
						<button type="button" className="sh-btn" onClick={() => setScanning(true)}>
							<ScanLine size={16} /> Scan QR
						</button>
					</div>
					<label className="sh-field">
						<span className="sh-field-label">Join link</span>
						<input
							className="sh-input sh-input-mono"
							type="text"
							inputMode="url"
							enterKeyHint="go"
							value={link}
							onChange={e => setLink(e.target.value)}
							placeholder="ws://host:port/r/room.key"
							spellCheck={false}
							autoComplete="off"
							autoCapitalize="off"
							autoCorrect="off"
						/>
						<span className="sh-field-hint">
							Run <code>/collab</code> in any omp session to get one.
						</span>
					</label>
					<label className="sh-field">
						<span className="sh-field-label">Display name</span>
						<input
							className="sh-input"
							type="text"
							value={name}
							onChange={e => setName(e.target.value)}
							placeholder="guest"
							spellCheck={false}
							autoComplete="off"
							maxLength={32}
						/>
					</label>
					{shown && <div className="sh-connect-error">{shown}</div>}
					<button className="sh-btn sh-connect-submit" type="submit">
						Connect <ArrowRight size={14} />
					</button>
					<div className="sh-connect-foot">
						<Lock size={12} />
						End-to-end encrypted. The room key stays in the link and never reaches the relay.
					</div>
				</form>
			</div>
			{scanning && (
				<QrScanner
					onLink={found => {
						setScanning(false);
						join(found);
					}}
					onClose={() => setScanning(false)}
				/>
			)}
		</div>
	);
}
