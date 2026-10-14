import type { PersonalMemory } from "@oh-my-pi/pi-wire/personal";
import { EyeOff, LoaderCircle, Pin, PinOff } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { usePersonal } from "../../lib/use-personal";
import { Replaces, ReplacedBy } from "./MemoryLinks";
import { MemoryMeta } from "./MemoryMeta";
import { useAction } from "./shared";
import "./memory.css";

/** Long enough that the four-line clamp can hide something. */
const LONG_CHARS = 240;
const LONG_LINES = 4;

export function MemoryRow({
	memory,
	onChange,
}: {
	memory: PersonalMemory;
	onChange(memory: PersonalMemory): void;
}): ReactNode {
	const personal = usePersonal();
	const action = useAction();
	const [expanded, setExpanded] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const cancelRef = useRef<HTMLButtonElement>(null);
	const long = memory.content.length > LONG_CHARS || memory.content.split("\n").length > LONG_LINES;

	useEffect(() => {
		if (confirming) cancelRef.current?.focus();
	}, [confirming]);

	const change = (t: "personal-memory-pin" | "personal-memory-unpin" | "personal-memory-retract"): Promise<boolean> =>
		action.run(async () => {
			const reply = await personal.call({ t, id: memory.id });
			onChange(reply.memory);
			setConfirming(false);
		});

	return (
		<li className={memory.invalid ? "pa-mem pa-mem-invalid" : "pa-mem"}>
			<p className={long && !expanded ? "pa-mem-content pa-mem-clamp" : "pa-mem-content"}>{memory.content}</p>
			{long && (
				<button
					type="button"
					className="pa-linkbtn"
					aria-expanded={expanded}
					onClick={() => setExpanded(!expanded)}
				>
					{expanded ? "Show less" : "Show more"}
				</button>
			)}
			<MemoryMeta memory={memory} />
			{memory.replacedBy !== undefined && <ReplacedBy id={memory.replacedBy} />}
			{memory.replacesCount !== undefined && memory.replacesCount > 0 && (
				<Replaces id={memory.id} count={memory.replacesCount} />
			)}
			{!memory.invalid && (
				<div className="pa-mem-actions">
					<button
						type="button"
						className="sh-btn pa-mem-act"
						aria-label={memory.pinned ? "Unpin this memory" : "Pin this memory"}
						title={
							memory.pinned
								? "The agent stops seeing it every turn"
								: "The agent sees it every turn and cannot retract it"
						}
						disabled={action.busy}
						onClick={() => void change(memory.pinned ? "personal-memory-unpin" : "personal-memory-pin")}
					>
						{action.busy && !confirming ? (
							<LoaderCircle size={14} className="sh-spin" aria-hidden="true" />
						) : memory.pinned ? (
							<PinOff size={14} aria-hidden="true" />
						) : (
							<Pin size={14} aria-hidden="true" />
						)}
						{memory.pinned ? "Unpin" : "Pin"}
					</button>
					{memory.pinned ? (
						<span className="sh-field-hint">Unpin to retract</span>
					) : (
						!confirming && (
							<button
								type="button"
								className="sh-btn pa-mem-act"
								aria-label="Retract this memory"
								disabled={action.busy}
								onClick={() => setConfirming(true)}
							>
								<EyeOff size={14} aria-hidden="true" /> Retract
							</button>
						)
					)}
				</div>
			)}
			{confirming && (
				<div
					className="pa-note pa-note-warn pa-mem-confirm"
					role="group"
					aria-label="Retract this memory?"
					onKeyDown={e => {
						if (e.key === "Escape" && !action.busy) setConfirming(false);
					}}
				>
					<div>
						Retract this memory? The agent stops recalling it. It is kept, shown struck through, and the agent
						cannot undo it. You can't undo it from here either.
					</div>
					<div className="pa-actions">
						<button
							type="button"
							className="sh-btn sh-btn-stop"
							disabled={action.busy}
							onClick={() => void change("personal-memory-retract")}
						>
							{action.busy && <LoaderCircle size={14} className="sh-spin" aria-hidden="true" />} Retract
						</button>
						<button
							ref={cancelRef}
							type="button"
							className="sh-btn"
							disabled={action.busy}
							onClick={() => setConfirming(false)}
						>
							Cancel
						</button>
					</div>
				</div>
			)}
			{action.error !== null && <div className="sh-connect-error">{action.error}</div>}
		</li>
	);
}
