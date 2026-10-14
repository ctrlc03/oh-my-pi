import { SPAR_DEFAULT_MAX_COST_USD, SPAR_MAX_DOC_CHARS } from "@oh-my-pi/pi-wire/spar";
import { ChevronLeft, LoaderCircle, Play, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useId, useState } from "react";
import { type ComputerHandle, computerById, saveLastComputer } from "../../lib/computers";
import { useRequest } from "../../lib/use-request";
import { SubjectPicker, useSubjectPick } from "../shell/SubjectPicker";
import { createSpar } from "./spar-api";
import { buildSparCreate, type SparDocInput, type SparTarget } from "./spar-flow";

export interface NewSparFormProps {
	computers: readonly ComputerHandle[];
	target: SparTarget;
	onBack(): void;
	onStarted(computerId: string, id: string): void;
	onClose(): void;
}

const DEFAULT_LIMIT = String(SPAR_DEFAULT_MAX_COST_USD);

const EXTRA_CHOICES = [{ value: "doc", label: "A design document" }] as const;

/**
 * The form that confirms what to spar about and starts it: the session's changes, a branch, a pull request (with its
 * stack) or a design document, a design attached to a change, the spend limit and the models.
 */
export function NewSparForm({ computers, target, onBack, onStarted, onClose }: NewSparFormProps): ReactNode {
	const ids = useId();
	const client = computerById(computers, target.computerId)?.client ?? null;
	const startsOnDoc = target.subject.kind === "doc";
	const pick = useSubjectPick<"doc">({
		client,
		cwd: target.cwd,
		sessionId: target.sessionId,
		subject: target.subject.kind === "doc" ? { kind: "changes" } : target.subject,
		extra: ["doc"],
		startOn: startsOnDoc ? "doc" : undefined,
	});
	const { choice } = pick;
	const [attach, setAttach] = useState(target.doc !== undefined && !startsOnDoc);
	const [source, setSource] = useState<SparDocInput["source"]>(target.doc?.source ?? "paste");
	const [name, setName] = useState(target.doc?.source === "paste" ? target.doc.name : "");
	const [text, setText] = useState(target.doc?.source === "paste" ? target.doc.text : "");
	const [path, setPath] = useState(target.doc?.source === "file" ? target.doc.path : "");
	const [useConversation, setUseConversation] = useState(true);
	const [limit, setLimit] = useState(DEFAULT_LIMIT);
	const [model, setModel] = useState("");
	const [replyModel, setReplyModel] = useState("");
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// omp's own models (not other vendors' agents): suggestions for the two model fields; a computer that cannot list them still takes a typed name.
	const models = useRequest(
		useCallback(async () => {
			if (client === null) return [];
			return (await client.requestFanoutModels()).filter(entry => entry.agent === undefined);
		}, [client]),
	).state;

	const wantsDoc = choice === "doc" || attach;
	const overLimit = text.length > SPAR_MAX_DOC_CHARS;
	const conversationOffered = target.sessionId !== null && (choice === "changes" || choice === "doc");

	const submit = async (e: FormEvent): Promise<void> => {
		e.preventDefault();
		if (client === null) return setError("This computer is not connected.");
		const picked = choice === "doc" ? { kind: "doc" as const } : pick.picked;
		if (picked === null) return setError("Pick a pull request.");
		const made = buildSparCreate({
			cwd: target.cwd,
			subject: picked,
			sessionId: target.sessionId,
			useConversation,
			stack: pick.stack,
			scope: pick.scope,
			doc: !wantsDoc ? null : source === "file" ? { source, path } : { source, name, text },
			limit,
			model,
			replyModel,
		});
		if ("error" in made) return setError(made.error);
		setStarting(true);
		setError(null);
		try {
			const id = await createSpar(client, made.request);
			saveLastComputer(target.computerId);
			onStarted(target.computerId, id);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setStarting(false);
		}
	};

	return (
		<form className="sp-form" onSubmit={e => void submit(e)}>
			<div className="sh-sheet-head">
				<button type="button" className="sh-btn sh-gh-back" onClick={onBack}>
					<ChevronLeft size={16} /> Sparring
				</button>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
					<X size={16} />
				</button>
			</div>
			<h2 className="sp-form-title">New spar</h2>
			<div className="sp-form-body">
				<SubjectPicker
					pick={pick}
					label="What to challenge"
					summaryLabel="What the partner will challenge"
					used="challenged"
					extraChoices={EXTRA_CHOICES}
					onChoose={() => setError(null)}
				/>
				{choice !== "doc" && (
					<label className="sp-check">
						<input type="checkbox" checked={attach} onChange={e => setAttach(e.target.checked)} />
						<span>
							Attach a design
							<span className="sh-field-hint"> (the document says what this change should do)</span>
						</span>
					</label>
				)}
				{wantsDoc && (
					<div className="sh-field">
						<span className="sh-field-label" id={`${ids}-doc`}>
							{choice === "doc" ? "The design" : "The design to attach"}
						</span>
						<div className="sh-segmented" role="radiogroup" aria-labelledby={`${ids}-doc`}>
							<button
								type="button"
								role="radio"
								aria-checked={source === "paste"}
								className={source === "paste" ? "sh-segment sh-segment-on" : "sh-segment"}
								onClick={() => setSource("paste")}
							>
								Paste text
							</button>
							<button
								type="button"
								role="radio"
								aria-checked={source === "file"}
								className={source === "file" ? "sh-segment sh-segment-on" : "sh-segment"}
								onClick={() => setSource("file")}
							>
								File in the repository
							</button>
						</div>
						{source === "paste" ? (
							<>
								<input
									className="sh-input"
									type="text"
									aria-label="Name of the design"
									placeholder="Name (optional)"
									value={name}
									onChange={e => setName(e.target.value)}
								/>
								<textarea
									className="sh-input sp-doc"
									rows={8}
									aria-label="Design text"
									placeholder="Paste the design"
									spellCheck={false}
									value={text}
									onChange={e => setText(e.target.value)}
								/>
								<span className={overLimit ? "sh-field-hint sp-over" : "sh-field-hint"}>
									{text.length.toLocaleString("en-US")} / {SPAR_MAX_DOC_CHARS.toLocaleString("en-US")}{" "}
									characters
								</span>
							</>
						) : (
							<>
								<input
									className="sh-input sp-path"
									type="text"
									aria-label="Path of the design"
									autoCapitalize="none"
									autoCorrect="off"
									spellCheck={false}
									placeholder="docs/design.md"
									value={path}
									onChange={e => setPath(e.target.value)}
								/>
								<span className="sh-field-hint">A file of this repository, read as the change has it.</span>
							</>
						)}
					</div>
				)}
				{conversationOffered && (
					<label className="sp-check">
						<input
							type="checkbox"
							checked={useConversation}
							onChange={e => setUseConversation(e.target.checked)}
						/>
						<span>
							Include why it was done
							<span className="sh-field-hint"> (uses this session's conversation)</span>
						</span>
					</label>
				)}
				<label className="sh-field">
					<span className="sh-field-label">Cost limit (USD)</span>
					<input
						className="sh-input sp-limit"
						type="number"
						inputMode="decimal"
						min="0.1"
						step="any"
						value={limit}
						onChange={e => setLimit(e.target.value)}
					/>
					<span className="sh-field-hint">
						Covers writing the points and the partner's replies; the spar stops at this cost.
					</span>
				</label>
				<label className="sh-field">
					<span className="sh-field-label">Model for the points</span>
					<input
						className="sh-input"
						type="text"
						list={`${ids}-models`}
						autoCapitalize="none"
						autoCorrect="off"
						spellCheck={false}
						placeholder="The computer's default model"
						value={model}
						onChange={e => setModel(e.target.value)}
					/>
					<span className="sh-field-hint">Reads the code and writes the challenges.</span>
				</label>
				<label className="sh-field">
					<span className="sh-field-label">Model for the replies</span>
					<input
						className="sh-input"
						type="text"
						list={`${ids}-models`}
						autoCapitalize="none"
						autoCorrect="off"
						spellCheck={false}
						placeholder="@default"
						value={replyModel}
						onChange={e => setReplyModel(e.target.value)}
					/>
					<span className="sh-field-hint">Answers each defence; every reply costs a little.</span>
				</label>
				{models.status === "ready" && (
					<datalist id={`${ids}-models`}>
						{models.value.map(entry => (
							<option key={entry.selector} value={entry.selector}>
								{entry.name}
							</option>
						))}
					</datalist>
				)}
			</div>
			{error !== null && (
				<div className="sh-connect-error" role="alert">
					{error}
				</div>
			)}
			<div className="sp-form-actions">
				<button type="submit" className="sh-btn sh-btn-primary" disabled={starting || client === null}>
					{starting ? <LoaderCircle size={14} className="sh-spin" /> : <Play size={14} />} Start the spar
				</button>
			</div>
		</form>
	);
}
