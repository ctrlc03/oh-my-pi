import type { PersonalDigest } from "@oh-my-pi/pi-wire/personal";
import { ChevronDown, ChevronRight, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { digestMeta } from "../../lib/personal-activity";
import { usePersonal } from "../../lib/use-personal";
import { Markdown } from "../transcript/Markdown";
import { useAction } from "./shared";
import "./activity.css";

export interface DigestViewProps {
	digest: PersonalDigest;
	/** Only the body and the read button, always open: the caller already shows the title (an inbox row). */
	bare?: boolean;
	defaultOpen?: boolean;
	onChanged?(digest: PersonalDigest): void;
}

/** "What I learned today": a header that opens the digest's text, and a way to mark it read (which opens it). */
export function DigestView({
	digest: given,
	bare = false,
	defaultOpen = false,
	onChanged,
}: DigestViewProps): ReactNode {
	const personal = usePersonal();
	const [answered, setAnswered] = useState<{ from: PersonalDigest; value: PersonalDigest } | null>(null);
	const digest = answered !== null && answered.from === given ? answered.value : given;
	const [open, setOpen] = useState(defaultOpen);
	const read = useAction();

	const markRead = (): void => {
		void read.run(async () => {
			const next = (await personal.call({ t: "personal-digest-read", id: digest.id })).digest;
			setAnswered({ from: given, value: next });
			setOpen(true);
			onChanged?.(next);
		});
	};
	const readButton = digest.read ? null : (
		<button type="button" className="sh-btn" disabled={read.busy} onClick={markRead}>
			{read.busy && <LoaderCircle size={14} className="sh-spin" />} Mark as read
		</button>
	);
	const body = (
		<>
			<div className="pa-dig-body">
				<Markdown text={digest.body} />
			</div>
			{read.error !== null && <div className="sh-connect-error">{read.error}</div>}
		</>
	);

	if (bare) {
		return (
			<div className="pa-dig pa-dig-bare">
				<div className="sh-field-hint">{digestMeta(digest)}</div>
				{body}
				{readButton !== null && <div className="pa-actions">{readButton}</div>}
			</div>
		);
	}
	return (
		<section className="pa-card pa-dig" aria-label={digest.title}>
			<div className="pa-dig-head">
				<button type="button" className="pa-dig-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
					{open ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
					<span className="pa-dig-text">
						<span className="pa-dig-title">
							{!digest.read && <span className="pa-act-unread" role="img" aria-label="Unread" />}
							{digest.title}
						</span>
						<span className="sh-field-hint">{digestMeta(digest)}</span>
					</span>
				</button>
				{readButton}
			</div>
			{open && body}
		</section>
	);
}
