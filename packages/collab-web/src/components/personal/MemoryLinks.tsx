import type { PersonalMemory } from "@oh-my-pi/pi-wire/personal";
import { History, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { usePersonal } from "../../lib/use-personal";
import { MemoryPeek } from "./MemoryMeta";
import { useAction } from "./shared";

/** "Replaced by a newer memory", with that memory loaded in place on request. */
export function ReplacedBy({ id }: { id: string }): ReactNode {
	const personal = usePersonal();
	const action = useAction();
	const [open, setOpen] = useState(false);
	const [newer, setNewer] = useState<PersonalMemory | null | undefined>(undefined);

	const toggle = async (): Promise<void> => {
		if (open) {
			setOpen(false);
			return;
		}
		const ok = await action.run(async () => {
			const reply = await personal.call({ t: "personal-memory-get", id });
			setNewer(reply.memory);
		});
		if (ok) setOpen(true);
	};

	return (
		<div className="pa-mem-link">
			<div className="pa-mem-link-line">
				<span>Replaced by a newer memory</span>
				<button
					type="button"
					className="pa-linkbtn"
					aria-expanded={open}
					disabled={action.busy}
					onClick={() => void toggle()}
				>
					{action.busy && <LoaderCircle size={12} className="sh-spin" aria-hidden="true" />}
					{open ? "Hide" : "View"}
				</button>
			</div>
			{action.error !== null && <div className="sh-connect-error">{action.error}</div>}
			{open &&
				(newer === null || newer === undefined ? (
					<div className="sh-field-hint">That memory is no longer available.</div>
				) : (
					<MemoryPeek memory={newer} />
				))}
		</div>
	);
}

/** What a memory replaced; shown only for a memory that reports it replaced something. */
export function Replaces({ id, count }: { id: string; count: number }): ReactNode {
	const personal = usePersonal();
	const action = useAction();
	const [open, setOpen] = useState(false);
	const [earlier, setEarlier] = useState<readonly PersonalMemory[] | null>(null);

	const toggle = async (): Promise<void> => {
		if (open) {
			setOpen(false);
			return;
		}
		const ok = await action.run(async () => {
			const reply = await personal.call({ t: "personal-memory-get", id });
			setEarlier(reply.replaces);
		});
		if (ok) setOpen(true);
	};

	const label = `Replaces ${earlier?.length ?? count} earlier`;
	return (
		<div className="pa-mem-link">
			<button
				type="button"
				className="pa-linkbtn"
				aria-expanded={open}
				disabled={action.busy}
				onClick={() => void toggle()}
			>
				{action.busy ? (
					<LoaderCircle size={12} className="sh-spin" aria-hidden="true" />
				) : (
					<History size={12} aria-hidden="true" />
				)}
				{label}
			</button>
			{action.error !== null && <div className="sh-connect-error">{action.error}</div>}
			{open && earlier !== null && (
				<div className="pa-peeks">
					{earlier.length === 0 ? (
						<div className="sh-field-hint">This memory did not replace another.</div>
					) : (
						earlier.map(memory => <MemoryPeek key={memory.id} memory={memory} />)
					)}
				</div>
			)}
		</div>
	);
}
