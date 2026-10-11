import type { CollabUiRequest, ImageContent, SessionCommand, WireModel, WireProfile } from "@oh-my-pi/pi-wire";
import {
	File as FileIcon,
	FileText,
	ListEnd,
	LoaderCircle,
	Paperclip,
	PenLine,
	SendHorizontal,
	Square,
	X,
	Zap,
} from "lucide-react";
import type { ClipboardEvent, KeyboardEvent, ReactNode, Ref, RefObject } from "react";
import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { ConnectionPhase, GuestClient, PromptModelChoice } from "../../lib/client";
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
import { useEnterWhileRunning } from "../../lib/composer-prefs";
import { dropStashed, type StashedDraft, stashDraft, useStashedDrafts } from "../../lib/draft-stash";
import { MAX_ATTACHMENTS, toImageContent } from "../../lib/images";
import { isLargePaste, pastedTextFile } from "../../lib/large-paste";
import { NOT_RECALLING, promptHistory, type RecallState, recallStep } from "../../lib/recall";
import { IS_MAC, shortcutFires } from "../../lib/shortcuts";
import { openSketch } from "../../lib/diagram-store";
import { loadDraft, saveDraft } from "../../lib/rooms";
import { insertAtCaret } from "../../lib/voice";
import { DraftStash } from "./DraftStash";
import { FollowUps } from "./FollowUps";
import { type MentionSources, useMentionMenu } from "./MentionMenu";
import { ModelControls } from "./ModelControls";
import { FanoutPill, type FanoutTarget } from "./FanoutSheet";
import { ApprovalChoices } from "./ApprovalChoices";
import { modelOfChoice, PromptModelPicker } from "./PromptModelPicker";
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
	/** Ids of `followUps`, same order; used when `queueEdit` is on. */
	followUpIds?: readonly string[];
	/** The host edits, moves and steers queued follow-ups by id (`queue-edit`) and this guest may write. */
	queueEdit?: boolean;
	/** Where `#` (pull requests) and `@` (sessions) find what they name; null when the host does not expand mentions. */
	mentions?: MentionSources | null;
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
	/** Profiles the host offers this writer; the pill shows only when the host advertises `profiles` and the list is non-empty. */
	profiles?: readonly WireProfile[] | null;
	/** Active profile name. */
	profile?: string;
	/** A paired computer can follow this session to its next room, so slash commands that replace the session are offered. */
	followsRoom: boolean;
	/** The host runs a prompt on a model the writer picks for it alone: offers the per-message model pill. */
	promptModel: boolean;
	/** Where "try on several models" can start the draft (a paired computer that runs fan-outs); null hides the pill. */
	fanout?: FanoutTarget | null;
	/** The host advertises `approval-grants`: a tool-approval ask shows the always-allow / deny-always choices. */
	approvalGrants?: boolean;
	onSessionCommand(cmd: SessionCommand, arg?: string): void;
	ref?: Ref<ComposerHandle>;
}

export interface ComposerHandle {
	/** Add `prompt` to the draft (after a blank line when there is one) and focus it; nothing is sent. */
	insert(prompt: string): void;
	/** Replace the draft text and attachments (an edited earlier prompt), put the caret at the end and focus. */
	replace(text: string, images?: readonly ImageContent[]): void;
	/** Clear the draft and its images when the text is exactly `draft` (a prompt an undo handed back, untouched since). */
	discard(draft: string): void;
	/** Put the caret in the message box. */
	focus(): void;
	/** Set the draft text aside in the stash (what ⌘S does); nothing happens for a blank draft. */
	stash(): void;
	/** Attach files as the file picker would (a sketch's PNG and scene) and add `note` to the draft. */
	attach(picked: readonly File[], note: string): Promise<void>;
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
	followUpIds = [],
	queueEdit = false,
	mentions = null,
	upload,
	draftKey,
	voice,
	models,
	model,
	thinkingLevel,
	thinkingLevels,
	profiles,
	profile,
	followsRoom,
	promptModel,
	fanout = null,
	approvalGrants = false,
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
	// The model (and thinking level) the next message alone runs on; cleared once it is sent.
	const [promptChoice, setPromptChoice] = useState<PromptModelChoice | null>(null);
	const fileRef = useRef<HTMLInputElement | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();
	// The caret as state (the menus follow it), the ↑/↓ walk through earlier prompts, and the stash.
	const [caretPos, setCaretPos] = useState(0);
	const recallRef = useRef<RecallState>(NOT_RECALLING);
	const recallHistoryRef = useRef<readonly string[]>([]);
	const pasteSeqRef = useRef(0);
	const stashed = useStashedDrafts();
	const [stashNote, setStashNote] = useState<string | null>(null);
	const enterPref = useEnterWhileRunning();

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
	// With "queue" as the device's Enter, Enter holds the message until the turn ends and Alt+Enter steers.
	const queueFirst = canFollowUp && enterPref === "queue";
	const canSend = canType && !uploading && (text.trim().length > 0 || files.length > 0);

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [text, uiRequest?.reqId]);

	useEffect(() => {
		if (stashNote === null) return;
		const timer = setTimeout(() => setStashNote(null), 3000);
		return () => clearTimeout(timer);
	}, [stashNote]);

	/** Sets the draft text aside and empties the box; false (and nothing changes) for a blank draft. */
	const stashNow = (): boolean => {
		if (!stashDraft(text)) return false;
		setText("");
		caretRef.current = null;
		setCaretPos(0);
		recallRef.current = NOT_RECALLING;
		setStashNote("Draft stashed");
		return true;
	};
	/** Takes a stashed draft back; a draft already in the box is stashed in its place, so nothing is lost. */
	const restoreStashed = (draft: StashedDraft): void => {
		if (text.trim() !== "") stashDraft(text);
		dropStashed(draft.id);
		pendingCaretRef.current = draft.text.length;
		setText(draft.text);
		setCaretTick(tick => tick + 1);
		recallRef.current = NOT_RECALLING;
	};

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
	// The latest `attach`, for the handle below (declared further down).
	const attachRef = useRef<(picked: readonly File[]) => Promise<void>>(async () => {});
	useImperativeHandle(
		ref,
		() => ({
			insert(prompt: string): void {
				const next = text.trim() ? `${text.trimEnd()}\n\n${prompt}` : prompt;
				pendingCaretRef.current = next.length;
				setText(next);
			},
			focus(): void {
				taRef.current?.focus();
			},
			attach(picked: readonly File[], note: string): Promise<void> {
				const next = text.trim() ? `${text.trimEnd()}\n\n${note}` : note;
				pendingCaretRef.current = next.length;
				setText(next);
				return attachRef.current(picked);
			},
			stash(): void {
				if (canType) stashNow();
			},
			replace(next: string, nextImages: readonly ImageContent[] = []): void {
				pendingCaretRef.current = next.length;
				setText(next);
				setImages([...nextImages]);
				setFiles([]);
				setAttachError(null);
				setCaretTick(tick => tick + 1);
			},
			discard(draft: string): void {
				if (text !== draft) return;
				setText("");
				setImages([]);
				caretRef.current = null;
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

	// "#" in the draft lists pull requests, "@" other sessions; picking one writes its token, nothing is sent.
	const mention = useMentionMenu({
		client,
		text,
		caret: caretPos,
		enabled: canType,
		sources: mentions,
		onPick: (picked, caret) => {
			pendingCaretRef.current = caret;
			setText(picked);
			setCaretTick(tick => tick + 1);
		},
	});
	const resolveMentions = mention.resolve;

	/** Sends `override` (a quick reply) or the typed text with its attachments; `deliver` queues it behind the running turn. */
	const send = useCallback(
		(override?: string, deliver?: "follow-up"): void => {
			const prompt = override === undefined ? composePrompt(text, files) : override.trim();
			if (!prompt || !canType || uploading) return;
			// A choice for a model the host stopped offering is dropped rather than sent.
			const choice =
				promptModel && modelOfChoice(models ?? [], promptChoice) ? (promptChoice ?? undefined) : undefined;
			client.sendPrompt(prompt, images, deliver, choice, {
				mentions: mentions === null ? undefined : resolveMentions(override === undefined ? text : prompt),
			});
			recallRef.current = NOT_RECALLING;
			setPromptChoice(null);
			setImages([]);
			setFiles([]);
			setAttachError(null);
			if (override === undefined) {
				setText("");
				caretRef.current = null;
			}
		},
		[canType, client, files, images, mentions, models, promptChoice, promptModel, resolveMentions, text, uploading],
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
		models,
		thinkingLevels,
		followsRoom,
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
	attachRef.current = attach;

	// Screenshots and files pasted from the clipboard attach; so does text beyond 32 KiB; shorter text pastes as usual.
	const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
		const pasted = Array.from(e.clipboardData.files);
		if (pasted.length === 0) {
			// A long paste would flood the box: it becomes a text chip, unless no chip can hold it (then it is inserted as usual).
			const long = e.clipboardData.getData("text/plain");
			if (!isLargePaste(long) || files.length >= MAX_FILES) return;
			const file = pastedTextFile(long, pasteSeqRef.current + 1);
			if (typeof planFile(file, upload !== null) === "object") return;
			pasteSeqRef.current++;
			e.preventDefault();
			void attach([file]);
			return;
		}
		e.preventDefault();
		void attach(pasted);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (slash.onKeyDown(e) || mention.onKeyDown(e)) return;
		if (canType && !e.nativeEvent.isComposing && shortcutFires("stashDraft", e, e.target, IS_MAC)) {
			e.preventDefault();
			stashNow();
			return;
		}
		// ↑ in an empty box brings back the previous prompt of this session, ↓ walks forward again, like a shell.
		if (
			(e.key === "ArrowUp" || e.key === "ArrowDown") &&
			!e.shiftKey &&
			!e.altKey &&
			!e.ctrlKey &&
			!e.metaKey &&
			!e.nativeEvent.isComposing &&
			(text === "" || recallRef.current.index !== null)
		) {
			if (recallRef.current.index === null) recallHistoryRef.current = promptHistory(client.getSnapshot().entries);
			const { selectionStart, selectionEnd } = e.currentTarget;
			const recalled = recallStep(
				recallHistoryRef.current,
				recallRef.current,
				e.key === "ArrowUp" ? "older" : "newer",
				text,
				{ start: selectionStart, end: selectionEnd },
			);
			if (recalled !== null) {
				e.preventDefault();
				recallRef.current = recalled.state;
				pendingCaretRef.current = recalled.text.length;
				setText(recalled.text);
				setCaretTick(tick => tick + 1);
				return;
			}
		}
		if (e.key === "Escape" && busy && canPrompt) {
			e.preventDefault();
			e.stopPropagation();
			client.sendAbort();
			return;
		}
		if (shouldSubmitOnEnter(e, composingRef.current, isTouch())) {
			e.preventDefault();
			send(undefined, canFollowUp && e.altKey !== queueFirst ? "follow-up" : undefined);
		}
	};

	if (uiRequest && canPrompt) {
		return (
			<div className="sh-composer sh-composer-ask">
				{handsFree.status}
				<div className="sh-ask-title">{uiRequest.title}</div>
				{uiRequest.kind === "select" && approvalGrants && uiRequest.approval ? (
					<ApprovalChoices
						approval={uiRequest.approval}
						onChoose={label => client.sendUiResponse(uiRequest.reqId, label)}
					/>
				) : uiRequest.kind === "select" ? (
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
			<FollowUps
				client={client}
				followUps={followUps}
				ids={followUpIds}
				editable={queueEdit && followUpIds.length === followUps.length}
				readOnly={readOnly}
				live={live}
				resolveMentions={resolveMentions}
			/>
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
			{mention.menu}
			{stashNote !== null && (
				<div className="sh-stash-note" role="status">
					{stashNote}
				</div>
			)}
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
						<button
							type="button"
							className="sh-btn sh-btn-icon sh-sketch"
							onClick={openSketch}
							disabled={!canType || images.length >= MAX_ATTACHMENTS || files.length >= MAX_FILES}
							aria-label="sketch a drawing"
							title="sketch a drawing"
						>
							<PenLine size={16} />
						</button>
						<DraftStash
							drafts={stashed}
							canStash={text.trim() !== ""}
							disabled={!canType}
							onStash={() => void stashNow()}
							onRestore={restoreStashed}
							onDrop={dropStashed}
						/>
						{models !== null && (
							<ModelControls
								models={models}
								model={model}
								thinkingLevel={thinkingLevel}
								thinkingLevels={thinkingLevels}
								profiles={profiles}
								profile={profile}
								disabled={!live}
								onSessionCommand={onSessionCommand}
							>
								{promptModel && (
									<PromptModelPicker
										models={models}
										sessionModel={model}
										choice={promptChoice}
										onChoice={setPromptChoice}
										disabled={!canType}
									/>
								)}
							</ModelControls>
						)}
						{fanout && (
							<FanoutPill prompt={composePrompt(text, files)} target={fanout} disabled={!canType || uploading} />
						)}
					</>
				)}
				<textarea
					ref={taRef}
					className="sh-composer-input"
					value={text}
					onChange={e => {
						setText(e.target.value);
						setCaretPos(e.target.selectionStart);
					}}
					onSelect={e => {
						const { selectionStart, selectionEnd } = e.currentTarget;
						caretRef.current = { start: selectionStart, end: selectionEnd };
						setCaretPos(selectionEnd);
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
							onClick={() => send(undefined, queueFirst ? undefined : "follow-up")}
							disabled={!canSend}
							aria-label={queueFirst ? "send into the running turn" : "send after this turn"}
							title={
								queueFirst
									? "send now, steering the running turn (Alt+Enter)"
									: "send when this turn ends (Alt+Enter)"
							}
						>
							{queueFirst ? <Zap size={15} /> : <ListEnd size={15} />}{" "}
							<span className="sh-btn-label">{queueFirst ? "Steer" : "After turn"}</span>
						</button>
					)}
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						onClick={() => send(undefined, queueFirst ? "follow-up" : undefined)}
						disabled={!canSend}
						title={
							!live
								? "queue until reconnected (Enter)"
								: queueFirst
									? "send when this turn ends (Enter)"
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
