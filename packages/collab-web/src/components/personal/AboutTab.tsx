import { PERSONAL_DEFAULTS, type PersonalAbout } from "@oh-my-pi/pi-wire/personal";
import { LoaderCircle, Save } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { relTime } from "../../lib/format";
import { aboutSize } from "../../lib/personal-about";
import { lineDiff } from "../../lib/personal-diff";
import { usePersonal, usePersonalQuery } from "../../lib/use-personal";
import { AboutHistory, DiffBlock } from "./AboutHistory";
import { HomeGate, QueryView, useAction } from "./shared";
import "./memory.css";

/** Settings → Personal agent → About you: the file the agent reads every turn, edited by the owner (the agent only proposes). */
export function AboutTab(): ReactNode {
	return (
		<HomeGate>
			<AboutScreen />
		</HomeGate>
	);
}

function AboutScreen(): ReactNode {
	const personal = usePersonal();
	const query = usePersonalQuery(personal, ["about"], call => call({ t: "personal-about-get" }));
	return (
		<QueryView query={query} what="About you">
			{({ about }) => <AboutEditor about={about} />}
		</QueryView>
	);
}

function AboutEditor({ about }: { about: PersonalAbout }): ReactNode {
	const personal = usePersonal();
	const save = useAction();
	const [current, setCurrent] = useState(about);
	const [base, setBase] = useState(about);
	const [draft, setDraft] = useState(about.text);
	const [restored, setRestored] = useState<number | null>(null);
	const [saved, setSaved] = useState(false);
	const field = useRef<HTMLTextAreaElement>(null);
	const proposals = personal.home.status?.counts.proposals ?? 0;

	useEffect(() => {
		setCurrent(prev => (about.rev >= prev.rev ? about : prev));
	}, [about]);

	// A draft nobody touched, or one that already equals the new text, simply follows the file.
	useEffect(() => {
		if (current.rev === base.rev) return;
		if (draft === base.text || draft === current.text) {
			setBase(current);
			setDraft(current.text);
		}
	}, [current, base, draft]);

	useLayoutEffect(() => {
		const el = field.current;
		if (el === null) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [draft]);

	const dirty = draft !== base.text;
	const conflict = current.rev !== base.rev && draft !== current.text && dirty;
	const size = aboutSize(draft);
	const share = Math.min(1, size.tokens / PERSONAL_DEFAULTS.aboutMaxTokens);

	const send = (baseRev: number): Promise<boolean> =>
		save.run(async () => {
			const reply = await personal.call({ t: "personal-about-set", text: draft, baseRev });
			setCurrent(reply.about);
			if (reply.saved) {
				setBase(reply.about);
				setDraft(reply.about.text);
				setRestored(null);
				setSaved(true);
			}
		});

	const adopt = (text: string): void => {
		setBase(current);
		setDraft(text);
		setRestored(null);
	};

	return (
		<div className="pa-about">
			<section className="pa-card" aria-labelledby="pa-about-title">
				<div className="pa-card-head">
					<h3 id="pa-about-title" className="pa-card-title">
						About you
					</h3>
					<span className="sh-field-hint" title={new Date(current.updatedAt).toLocaleString()}>
						rev {current.rev} · updated {relTime(current.updatedAt)}
					</span>
				</div>
				<div className="sh-field-hint">
					Always loaded into the agent's context: keep it short. The agent can only propose changes; nothing
					changes until you accept.
				</div>
				{proposals > 0 && (
					<div className="pa-note" role="status">
						{proposals === 1 ? "1 proposal is" : `${proposals} proposals are`} waiting in Activity.
					</div>
				)}
				<textarea
					ref={field}
					className="sh-input sh-input-mono pa-about-text"
					value={draft}
					readOnly={save.busy}
					aria-label="About you"
					aria-invalid={size.tooLong}
					spellCheck={false}
					onChange={e => {
						setDraft(e.currentTarget.value);
						setSaved(false);
					}}
				/>
				<div className="pa-meter">
					<div className="sh-limit-line">
						<span className="sh-limit-label">Size</span>
						<span className={size.over ? "sh-limit-pct sh-limit-low" : "sh-limit-pct"}>
							~{size.tokens.toLocaleString()} of ~{PERSONAL_DEFAULTS.aboutMaxTokens.toLocaleString()} tokens
						</span>
					</div>
					<div
						className="sh-limit-meter"
						role="meter"
						aria-label="About you size in tokens"
						aria-valuemin={0}
						aria-valuemax={PERSONAL_DEFAULTS.aboutMaxTokens}
						aria-valuenow={size.tokens}
					>
						<div
							className={size.over ? "sh-limit-fill sh-limit-low" : "sh-limit-fill"}
							style={{ "--used": `${Math.round(share * 100)}%` } as CSSProperties}
						/>
					</div>
					{size.over && (
						<div className="sh-field-hint">
							Longer than the agent's context budget for this. Trim what it does not need every turn.
						</div>
					)}
				</div>
				{size.tooLong && <div className="sh-connect-error">About you is too long.</div>}
				{conflict && (
					<div className="pa-note pa-note-warn pa-conflict" role="alert">
						<div>
							About you changed while you were editing (a proposal was accepted, or another device saved).
						</div>
						<DiffBlock lines={lineDiff(draft, current.text)} label="Your draft against the current text" />
						<div className="sh-field-hint">
							Removed lines are only in your draft. Added lines are only in the current text.
						</div>
						<div className="pa-actions">
							<button type="button" className="sh-btn" disabled={save.busy} onClick={() => adopt(current.text)}>
								Use the current text
							</button>
							<button
								type="button"
								className="sh-btn"
								disabled={save.busy || size.tooLong}
								onClick={() => void send(current.rev)}
							>
								Keep my draft and save over it
							</button>
						</div>
					</div>
				)}
				{restored !== null && dirty && (
					<div className="sh-field-hint" role="status">
						Revision {restored} is in the editor. It is not saved until you save.
					</div>
				)}
				{save.error !== null && <div className="sh-connect-error">{save.error}</div>}
				<div className="pa-actions pa-about-save">
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						disabled={!dirty || conflict || size.tooLong || save.busy}
						onClick={() => void send(base.rev)}
					>
						{save.busy ? (
							<LoaderCircle size={14} className="sh-spin" aria-hidden="true" />
						) : (
							<Save size={14} aria-hidden="true" />
						)}{" "}
						Save
					</button>
					{dirty && (
						<button type="button" className="sh-btn" disabled={save.busy} onClick={() => adopt(current.text)}>
							Discard changes
						</button>
					)}
					{saved && !dirty && (
						<span className="sh-field-hint" role="status">
							Saved.
						</span>
					)}
				</div>
			</section>
			<AboutHistory
				onRestore={(text, rev) => {
					setDraft(text);
					setRestored(rev);
					setSaved(false);
					field.current?.focus();
				}}
			/>
		</div>
	);
}
