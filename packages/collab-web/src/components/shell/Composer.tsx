import type { CollabUiRequest, ImageContent, SessionCommand, WireModel } from "@oh-my-pi/pi-wire";
import { File as FileIcon, FileText, ListEnd, LoaderCircle, Paperclip, SendHorizontal, Square, X } from "lucide-react";
import type { ClipboardEvent, KeyboardEvent, ReactNode, Ref, RefObject } from "react";
import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { ConnectionPhase, GuestClient } from "../../lib/client";
import {
	type AttachedFile,
	composePrompt,
	decodeText,
	formatSize,
	isImageFile,
	MAX_FILES,
	NEEDS_COMPANION,
	planFile,
	planUpload,
} from "../../lib/files";
import { MAX_ATTACHMENTS, toImageContent } from "../../lib/images";
import { loadDraft, saveDraft } from "../../lib/rooms";
import { insertAtCaret } from "../../lib/voice";
import { ModelControls } from "./ModelControls";
import { QuickReplies } from "./QuickReplies";
import { useSlashMenu } from "./SlashMenu";
import { useVoiceInput, VoiceButton, type VoiceSource, VoiceStatus } from "./VoiceInput";
import { useHandsFree } from "./VoiceMode";

export interface ComposerProps {
	client: GuestClient;
	phase: ConnectionPhase;
	readOnly: boolean;
	/** Pending host-side UI request this guest can answer. */
	uiRequest: CollabUiRequest | null;
	/** Host agent turn in flight. */
	working: boolean;
	/** Prompts queued behind the running turn. */
	queuedMessageCount: number;
	/** The host delivers a prompt after the running turn ends, and this guest may prompt: offers "After turn". */
	followUp: boolean;
	/** Texts of the host's queued follow-ups, oldest first. */
	followUps: readonly string[];
	/** Saves a file on the paired computer and resolves with its absolute path; null without a companion for this session. */
	upload: ((file: File) => Promise<string>) | null;
	/** Room the unsent draft is saved under; null keeps it in memory only. */
	draftKey: string | null;
	/** Voice input through the paired computer; null when it is unavailable. */
	voice: VoiceSource | null;
	/** Models this writer may switch to; null when the host predates session controls. */
	models: readonly WireModel[] | null;
	model: WireModel | undefined;
	thinkingLevel: string | undefined;
	/** Levels the current model accepts; absent on hosts without session controls. */
	thinkingLevels: readonly string[] | undefined;
	onSessionCommand(cmd: SessionCommand, arg?: string): void;
	ref?: Ref<ComposerHandle>;
}

export interface ComposerHandle {
	/** Add `prompt` to the draft (after a blank line when there is one) and focus it; nothing is sent. */
	insert(prompt: string): void;
	/** Replace the draft text and attachments (an edited earlier prompt), put the caret at the end and focus. */
	replace(text: string, images?: readonly ImageContent[]): void;
}

/** Textarea metrics: line-height 20px + 8px vertical padding × 2 (kept in sync with shell.css). */
const LINE_PX = 20;
const PAD_Y = 16;
const MAX_ROWS = 8;

function autosize(el: HTMLTextAreaElement | null): void {
	if (!el) return;
	el.style.height = "0px";
	const max = MAX_ROWS * LINE_PX + PAD_Y;
	el.style.height = `${Math.max(LINE_PX + PAD_Y, Math.min(el.scrollHeight, max))}px`;
	el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
}

/**
 * Decides whether an Enter keydown should commit the composer. Returns `false` while an IME
 * composition is active so the keystroke confirms the composition instead of submitting.
 * `nativeEvent.isComposing` covers most browsers; `composing` bridges WebKit, which fires the
 * confirming Enter keydown *after* `compositionend`. On touch keyboards (`touch`) the return key
 * inserts a newline: there is no Shift+Enter, and the send button is in thumb reach.
 */
export function shouldSubmitOnEnter(e: KeyboardEvent<HTMLTextAreaElement>, composing: boolean, touch = false): boolean {
	if (e.key !== "Enter" || e.shiftKey || touch) return false;
	return !(e.nativeEvent.isComposing || composing);
}

/** Primary input is a finger: a phone or tablet without a trackpad. */
const TOUCH_QUERY = "(hover: none) and (pointer: coarse)";
const isTouch = (): boolean => typeof matchMedia === "function" && matchMedia(TOUCH_QUERY).matches;

/**
 * Tracks IME composition state via a ref the keydown handler reads synchronously. The
 * `compositionend` reset is deferred a tick because WebKit dispatches the confirming Enter
 * keydown after `compositionend`, when `nativeEvent.isComposing` is already `false`.
 */
function useCompositionGuard(): {
	composingRef: RefObject<boolean>;
	onCompositionStart(): void;
	onCompositionEnd(): void;
} {
	const composingRef = useRef(false);
	const onCompositionStart = useCallback((): void => {
		composingRef.current = true;
	}, []);
	const onCompositionEnd = useCallback((): void => {
		setTimeout(() => {
			composingRef.current = false;
		}, 0);
	}, []);
	return { composingRef, onCompositionStart, onCompositionEnd };
}

interface AskEditorProps {
	prefill: string | undefined;
	onSubmit(value: string): void;
}

/**
 * Editor ask input. Rendered with `key={reqId}` so a new request remounts it with a fresh
 * draft seeded from `prefill`, while re-sends of the same request never clobber a half-typed
 * draft. Submits verbatim — whitespace-only responses are intentional.
 */
function AskEditor({ prefill, onSubmit }: AskEditorProps): ReactNode {
	const [draft, setDraft] = useState(prefill ?? "");
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [draft]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (shouldSubmitOnEnter(e, composingRef.current, isTouch())) {
			e.preventDefault();
			onSubmit(draft);
		}
	};

	return (
		<div className="sh-composer-inner">
			<textarea
				ref={taRef}
				className="sh-composer-input"
				value={draft}
				onChange={e => setDraft(e.target.value)}
				onKeyDown={onKeyDown}
				onCompositionStart={onCompositionStart}
				onCompositionEnd={onCompositionEnd}
				placeholder="type your response…"
				rows={1}
				spellCheck={false}
			/>
			<div className="sh-composer-actions">
				<button
					type="button"
					className="sh-btn sh-btn-primary"
					onClick={() => onSubmit(draft)}
					title="submit response"
				>
					<SendHorizontal size={16} /> <span className="sh-btn-label">Submit</span>
				</button>
			</div>
		</div>
	);
}

/** Memoized on its snapshot fields, so streaming frames that leave them untouched skip it. */
export const Composer = memo(function Composer({
	client,
	phase,
	readOnly,
	uiRequest,
	working,
	queuedMessageCount,
	followUp,
	followUps,
	upload,
	draftKey,
	voice,
	models,
	model,
	thinkingLevel,
	thinkingLevels,
	onSessionCommand,
	ref,
}: ComposerProps): ReactNode {
	const [text, setText] = useState(() => (draftKey ? loadDraft(draftKey) : ""));
	const [images, setImages] = useState<ImageContent[]>([]);
	const [files, setFiles] = useState<AttachedFile[]>([]);
	const fileIdRef = useRef(0);
	const [attachError, setAttachError] = useState<string | null>(null);
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	// Where the caret last was in the textarea; null until the user places it.
	const caretRef = useRef<{ start: number; end: number } | null>(null);
	const pendingCaretRef = useRef<number | null>(null);
	// Bumped by `replace` so the caret/focus effect also runs when the new text equals the old.
	const [caretTick, setCaretTick] = useState(0);
	const fileRef = useRef<HTMLInputElement | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	const live = phase === "live";
	// Host-driven controls (ask answers, quick replies, stop) need the live session; typed
	// prompts do not: while not live the client queues them and sends them in order on reconnect.
	const canPrompt = live && !readOnly;
	const canType = !readOnly && phase !== "ended";
	const busy = working;
	// The host counts steers and follow-ups together; follow-ups have their own chips, so the badge counts steers only.
	const queued = Math.max(0, queuedMessageCount - followUps.length);
	const uploading = files.some(f => f.kind === "upload" && f.path === null);
	const canFollowUp = followUp && busy && canPrompt;
	const canSend = canType && !uploading && (text.trim().length > 0 || files.length > 0);

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [text, uiRequest?.reqId]);

	useEffect(() => {
		if (draftKey) saveDraft(draftKey, text);
	}, [draftKey, text]);

	// After a voice insert: put the caret behind the new words and bring the textarea forward.
	useLayoutEffect(() => {
		const caret = pendingCaretRef.current;
		const ta = taRef.current;
		if (caret === null || !ta) return;
		pendingCaretRef.current = null;
		ta.focus();
		ta.setSelectionRange(caret, caret);
		caretRef.current = { start: caret, end: caret };
	}, [text, caretTick]);

	/** Transcribed speech goes into the draft at the caret (or the end) for the user to review; it is never sent. */
	const insertVoice = (spoken: string): void => {
		const at = caretRef.current ?? { start: text.length, end: text.length };
		const next = insertAtCaret(text, spoken, at.start, at.end);
		pendingCaretRef.current = next.caret;
		setText(next.text);
	};
	useImperativeHandle(
		ref,
		() => ({
			insert(prompt: string): void {
				const next = text.trim() ? `${text.trimEnd()}\n\n${prompt}` : prompt;
				pendingCaretRef.current = next.length;
				setText(next);
			},
			replace(next: string, nextImages: readonly ImageContent[] = []): void {
				pendingCaretRef.current = next.length;
				setText(next);
				setImages([...nextImages]);
				setFiles([]);
				setAttachError(null);
				setCaretTick(tick => tick + 1);
			},
		}),
		[text],
	);
	// Hands-free mode takes the transcription (to send it after a countdown) while it is on.
	const handsFreeRef = useRef<((spoken: string) => boolean) | null>(null);
	const voiceInput = useVoiceInput(voice, spoken => {
		if (!handsFreeRef.current?.(spoken)) insertVoice(spoken);
	});
	const showVoice = voice !== null && (canType || voiceInput.step !== "idle");

	/** Sends `override` (a quick reply) or the typed text with its attachments; `deliver` queues it behind the running turn. */
	const send = useCallback(
		(override?: string, deliver?: "follow-up"): void => {
			const prompt = override === undefined ? composePrompt(text, files) : override.trim();
			if (!prompt || !canType || uploading) return;
			client.sendPrompt(prompt, images, deliver);
			setImages([]);
			setFiles([]);
			setAttachError(null);
			if (override === undefined) {
				setText("");
				caretRef.current = null;
			}
		},
		[canType, client, files, images, text, uploading],
	);
	const handsFree = useHandsFree({
		client,
		input: voiceInput,
		enabled: showVoice && canType,
		uiRequest,
		working,
		interceptRef: handsFreeRef,
		onSend: spoken => send(spoken),
		onDraft: insertVoice,
	});
	// "/" in the draft lists the host's commands; picking one fills the draft, nothing is sent.
	const slash = useSlashMenu({
		client,
		text,
		enabled: canType,
		onPick: picked => {
			pendingCaretRef.current = picked.length;
			setText(picked);
		},
	});

	/** Reads or uploads one non-image file into a chip; resolves with the message to show when it is refused or fails. */
	const attachFile = async (file: File): Promise<string | null> => {
		let plan = planFile(file, upload !== null);
		let inlined: string | null = null;
		if (plan === "inline") {
			inlined = decodeText(new Uint8Array(await file.arrayBuffer()));
			// Binary despite its name or type.
			if (inlined === null) plan = planUpload(file, upload !== null);
		}
		if (typeof plan === "object") return plan.refuse;
		const id = fileIdRef.current++;
		const { name, size } = file;
		if (inlined !== null) {
			const text = inlined;
			setFiles(prev => [...prev, { id, kind: "inline", name, size, text }]);
			return null;
		}
		if (!upload) return NEEDS_COMPANION;
		setFiles(prev => [...prev, { id, kind: "upload", name, size, path: null }]);
		try {
			const path = await upload(file);
			setFiles(prev => prev.map(f => (f.id === id && f.kind === "upload" ? { ...f, path } : f)));
			return null;
		} catch (err) {
			setFiles(prev => prev.filter(f => f.id !== id));
			return `Could not upload ${name}: ${err instanceof Error ? err.message : String(err)}`;
		}
	};

	const attach = async (picked: readonly File[]): Promise<void> => {
		const pickedImages = picked.filter(isImageFile);
		const pickedFiles = picked.filter(f => !isImageFile(f));
		if (pickedImages.length === 0 && pickedFiles.length === 0) return;
		const imageRoom = Math.max(0, MAX_ATTACHMENTS - images.length);
		const fileRoom = Math.max(0, MAX_FILES - files.length);
		const errors: string[] = [];
		if (pickedImages.length > imageRoom) errors.push(`Up to ${MAX_ATTACHMENTS} images per prompt.`);
		if (pickedFiles.length > fileRoom) errors.push(`Up to ${MAX_FILES} files per prompt.`);
		setAttachError(errors.length > 0 ? errors.join(" ") : null);
		const results = await Promise.all([
			(async (): Promise<string | null> => {
				if (pickedImages.length === 0) return null;
				try {
					const converted = await Promise.all(pickedImages.slice(0, imageRoom).map(toImageContent));
					setImages(prev => [...prev, ...converted].slice(0, MAX_ATTACHMENTS));
					return null;
				} catch (err) {
					return `Could not attach the image: ${err instanceof Error ? err.message : String(err)}`;
				}
			})(),
			...pickedFiles.slice(0, fileRoom).map(attachFile),
		]);
		const failed = results.filter((message): message is string => message !== null);
		if (failed.length > 0) setAttachError([...errors, ...failed].join(" "));
	};

	// Screenshots and files pasted from the clipboard attach; plain text pastes as usual.
	const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
		const pasted = Array.from(e.clipboardData.files);
		if (pasted.length === 0) return;
		e.preventDefault();
		void attach(pasted);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (slash.onKeyDown(e)) return;
		if (e.key === "Escape" && busy && canPrompt) {
			e.preventDefault();
			e.stopPropagation();
			client.sendAbort();
			return;
		}
		if (shouldSubmitOnEnter(e, composingRef.current, isTouch())) {
			e.preventDefault();
			send(undefined, e.altKey && canFollowUp ? "follow-up" : undefined);
		}
	};

	if (uiRequest && canPrompt) {
		return (
			<div className="sh-composer sh-composer-ask">
				{handsFree.status}
				<div className="sh-ask-title">{uiRequest.title}</div>
				{uiRequest.kind === "select" ? (
					<div className="sh-ask-options">
						{uiRequest.options.map((option, index) => {
							const label = typeof option === "string" ? option : option.label;
							const checked = uiRequest.checkedIndices?.includes(index) ?? false;
							return (
								<button
									key={`${uiRequest.reqId}-${index}-${label}`}
									type="button"
									className={`sh-ask-option${checked ? " sh-ask-option-checked" : ""}`}
									onClick={() => client.sendUiResponse(uiRequest.reqId, label)}
								>
									<span className="sh-ask-option-marker">
										{uiRequest.selectionMarker === "checkbox" ? (checked ? "☑" : "☐") : checked ? "◉" : "○"}
									</span>
									<span className="sh-ask-option-copy">
										<span className="sh-ask-option-label">{label}</span>
										{typeof option !== "string" && option.description && (
											<span className="sh-ask-option-description">{option.description}</span>
										)}
									</span>
								</button>
							);
						})}
					</div>
				) : (
					<AskEditor
						key={uiRequest.reqId}
						prefill={uiRequest.prefill}
						onSubmit={value => client.sendUiResponse(uiRequest.reqId, value)}
					/>
				)}
				<div className="sh-composer-actions sh-ask-actions">
					<button type="button" className="sh-btn" onClick={() => client.sendUiResponse(uiRequest.reqId)}>
						Cancel
					</button>
					{busy && (
						<button
							type="button"
							className="sh-btn sh-btn-stop"
							onClick={() => client.sendAbort()}
							disabled={!live}
							title="stop the current turn"
						>
							<Square size={11} /> <span className="sh-btn-label">Stop</span>
						</button>
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="sh-composer">
			{canPrompt && !text && <QuickReplies disabled={!live} onPick={reply => send(reply)} />}
			{followUps.length > 0 && (
				<div className="sh-followups">
					{followUps.map((queuedText, i) => (
						<div key={`${i}-${queuedText}`} className="sh-followup" title={queuedText}>
							<ListEnd size={14} />
							<span className="sh-followup-label">After this turn:</span>
							<span className="sh-followup-text">{queuedText.replace(/\s+/g, " ").trim()}</span>
							{!readOnly && (
								<button
									type="button"
									className="sh-followup-remove"
									onClick={() => client.sendSessionCommand("unqueue", queuedText)}
									disabled={!live}
									aria-label="remove queued follow-up"
									title="remove from the queue"
								>
									<X size={12} />
								</button>
							)}
						</div>
					))}
				</div>
			)}
			{(images.length > 0 || files.length > 0 || attachError) && (
				<div className="sh-attachments">
					{images.map((image, i) => (
						<div key={`${i}-${image.data.length}`} className="sh-attachment">
							<img src={`data:${image.mimeType};base64,${image.data}`} alt={`attachment ${i + 1}`} />
							<button
								type="button"
								className="sh-attachment-remove"
								onClick={() => setImages(prev => prev.filter((_, j) => j !== i))}
								aria-label={`remove attachment ${i + 1}`}
							>
								<X size={12} />
							</button>
						</div>
					))}
					{files.map(file => (
						<div key={file.id} className="sh-file-chip" title={file.name}>
							{file.kind === "upload" && file.path === null ? (
								<LoaderCircle size={14} className="sh-spin" />
							) : file.kind === "inline" ? (
								<FileText size={14} />
							) : (
								<FileIcon size={14} />
							)}
							<span className="sh-file-name">{file.name}</span>
							<span className="sh-file-size">{formatSize(file.size)}</span>
							<button
								type="button"
								className="sh-file-remove"
								onClick={() => setFiles(prev => prev.filter(f => f.id !== file.id))}
								aria-label={`remove ${file.name}`}
							>
								<X size={12} />
							</button>
						</div>
					))}
					{attachError && <span className="sh-attachments-error">{attachError}</span>}
				</div>
			)}
			{showVoice && <VoiceStatus voice={voice} input={voiceInput} />}
			{handsFree.status}
			{slash.menu}
			<div className="sh-composer-inner">
				{!readOnly && (
					<>
						<input
							ref={fileRef}
							type="file"
							multiple
							hidden
							onChange={e => {
								void attach(Array.from(e.target.files ?? []));
								e.target.value = "";
							}}
						/>
						<button
							type="button"
							className="sh-btn sh-btn-icon sh-attach"
							onClick={() => fileRef.current?.click()}
							disabled={!canType || (images.length >= MAX_ATTACHMENTS && files.length >= MAX_FILES)}
							aria-label="attach images or files"
							title="attach images or files"
						>
							<Paperclip size={16} />
						</button>
						{models !== null && (
							<ModelControls
								models={models}
								model={model}
								thinkingLevel={thinkingLevel}
								thinkingLevels={thinkingLevels}
								disabled={!live}
								onSessionCommand={onSessionCommand}
							/>
						)}
					</>
				)}
				<textarea
					ref={taRef}
					className="sh-composer-input"
					value={text}
					onChange={e => setText(e.target.value)}
					onSelect={e => {
						const { selectionStart, selectionEnd } = e.currentTarget;
						caretRef.current = { start: selectionStart, end: selectionEnd };
					}}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
					onCompositionStart={onCompositionStart}
					onCompositionEnd={onCompositionEnd}
					placeholder={
						readOnly
							? "Watching only"
							: !live
								? "Offline — sends when back"
								: images.length > 0 || files.length > 0
									? "Add a message…"
									: "Message the agent…"
					}
					disabled={!canType}
					rows={1}
					spellCheck={false}
					enterKeyHint={isTouch() ? "enter" : "send"}
				/>
				<div className="sh-composer-actions">
					{busy && queued > 0 && (
						<span className="sh-queued">
							<span className="sh-queued-label">queued </span>×{queued}
						</span>
					)}
					{showVoice && <VoiceButton input={voiceInput} />}
					{handsFree.button}
					{busy && !readOnly && (
						<button
							type="button"
							className="sh-btn sh-btn-stop"
							onClick={() => client.sendAbort()}
							disabled={!live}
							title="stop the current turn"
						>
							<Square size={11} /> <span className="sh-btn-label">Stop</span>
						</button>
					)}
					{canFollowUp && (
						<button
							type="button"
							className="sh-btn sh-btn-after"
							onClick={() => send(undefined, "follow-up")}
							disabled={!canSend}
							aria-label="send after this turn"
							title="send when this turn ends (Alt+Enter)"
						>
							<ListEnd size={15} /> <span className="sh-btn-label">After turn</span>
						</button>
					)}
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						onClick={() => send()}
						disabled={!canSend}
						title={
							!live
								? "queue until reconnected (Enter)"
								: canFollowUp
									? "send now, steering the running turn (Enter)"
									: "send (Enter)"
						}
					>
						<SendHorizontal size={16} /> <span className="sh-btn-label">Send</span>
					</button>
				</div>
			</div>
		</div>
	);
});
