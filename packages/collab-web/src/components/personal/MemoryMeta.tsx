import type { PersonalMemory } from "@oh-my-pi/pi-wire/personal";
import { Pin } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { relTime } from "../../lib/format";
import { memoryState, originLabel } from "../../lib/personal";
import { importancePercent, memoryDate, recallText } from "../../lib/personal-memory";
import "./memory.css";

const STORE_LABELS: Record<PersonalMemory["store"], string> = {
	working: "Working memory",
	episodic: "Episodic memory",
};

/** Where a memory came from, when, how much it matters and how often it was used; and where it sits in its life. */
export function MemoryMeta({ memory }: { memory: PersonalMemory }): ReactNode {
	const origin = originLabel(memory);
	const created = Date.parse(memory.createdAt);
	const percent = importancePercent(memory.importance);
	const recalled = recallText(memory.recallCount);
	return (
		<div className="pa-mem-meta">
			<span className={`pa-badge pa-badge-${memory.origin}`} title={origin.hint}>
				{origin.source === null ? origin.label : `${origin.label} · ${origin.source}`}
			</span>
			<time
				dateTime={memory.createdAt}
				title={`${STORE_LABELS[memory.store]}, saved ${new Date(created).toLocaleString()} (${relTime(created)})`}
			>
				{memoryDate(memory.createdAt)}
			</time>
			{memory.eventDate !== undefined && (
				<time dateTime={memory.eventDate} title="The day this memory is about">
					about {memoryDate(memory.eventDate)}
				</time>
			)}
			<span className="pa-imp" role="img" aria-label={`Importance ${percent}%`} title={`Importance ${percent}%`}>
				<span className="pa-imp-fill" style={{ "--imp": `${percent}%` } as CSSProperties} />
			</span>
			{recalled !== "" && <span>{recalled}</span>}
			{memory.invalid ? (
				<span
					className="pa-chip-state pa-chip-invalid"
					title={
						memory.invalidAt === undefined ? undefined : `Since ${new Date(memory.invalidAt).toLocaleString()}`
					}
				>
					{memoryState(memory)}
				</span>
			) : (
				memory.pinned && (
					<span
						className="pa-chip-state pa-chip-pinned"
						title="Pinned: the agent sees it every turn and cannot retract it"
					>
						<Pin size={11} aria-hidden="true" /> Pinned
					</span>
				)
			)}
		</div>
	);
}

/** A memory shown inside another's row (the one that replaced it, or one it replaced): text and meta, no actions. */
export function MemoryPeek({ memory }: { memory: PersonalMemory }): ReactNode {
	return (
		<div className={memory.invalid ? "pa-peek pa-mem-invalid" : "pa-peek"}>
			<p className="pa-mem-content">{memory.content}</p>
			<MemoryMeta memory={memory} />
		</div>
	);
}
