import type { CollabUiRequest, ImageContent } from "@oh-my-pi/pi-wire";
import { ImagePlus, SendHorizontal, Square, X } from "lucide-react";
import type { ClipboardEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ConnectionPhase, GuestClient } from "../../lib/client";
import { MAX_ATTACHMENTS, toImageContent } from "../../lib/images";
import { loadDraft, saveDraft } from "../../lib/rooms";
import { QuickReplies } from "./QuickReplies";

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
	/** Room the unsent draft is saved under; null keeps it in memory only. */
	draftKey: string | null;
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
					<SendHorizontal size={12} /> <span className="sh-btn-label">Submit</span>
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
	draftKey,
}: ComposerProps): ReactNode {
	const [text, setText] = useState(() => (draftKey ? loadDraft(draftKey) : ""));
	const [images, setImages] = useState<ImageContent[]>([]);
	const [attachError, setAttachError] = useState<string | null>(null);
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const fileRef = useRef<HTMLInputElement | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	const live = phase === "live";
	const canPrompt = live && !readOnly;
	const busy = working;
	const queued = queuedMessageCount;
	const canSend = canPrompt && text.trim().length > 0;

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [text, uiRequest?.reqId]);

	useEffect(() => {
		if (draftKey) saveDraft(draftKey, text);
	}, [draftKey, text]);

	/** Sends `override` (a quick reply) or the typed text, with any attached images. */
	const send = useCallback(
		(override?: string): void => {
			const trimmed = (override ?? text).trim();
			if (!trimmed || !live || readOnly) return;
			client.sendPrompt(trimmed, images);
			setImages([]);
			setAttachError(null);
			if (override === undefined) setText("");
		},
		[client, images, live, readOnly, text],
	);

	const attach = async (files: readonly File[]): Promise<void> => {
		const picked = files.filter(f => f.type.startsWith("image/"));
		if (picked.length === 0) return;
		const room = MAX_ATTACHMENTS - images.length;
		setAttachError(picked.length > room ? `Up to ${MAX_ATTACHMENTS} images per prompt.` : null);
		try {
			const converted = await Promise.all(picked.slice(0, Math.max(0, room)).map(toImageContent));
			setImages(prev => [...prev, ...converted].slice(0, MAX_ATTACHMENTS));
		} catch (err) {
			setAttachError(`Could not attach the image: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	// Screenshots pasted from the clipboard attach; plain text pastes as usual.
	const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
		const files = Array.from(e.clipboardData.files).filter(f => f.type.startsWith("image/"));
		if (files.length === 0) return;
		e.preventDefault();
		void attach(files);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (shouldSubmitOnEnter(e, composingRef.current, isTouch())) {
			e.preventDefault();
			send();
		}
	};

	if (uiRequest && canPrompt) {
		return (
			<div className="sh-composer sh-composer-ask">
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
			{canPrompt && !text && <QuickReplies disabled={!live} onPick={send} />}
			{(images.length > 0 || attachError) && (
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
					{attachError && <span className="sh-attachments-error">{attachError}</span>}
				</div>
			)}
			<div className="sh-composer-inner">
				{!readOnly && (
					<>
						<input
							ref={fileRef}
							type="file"
							accept="image/*"
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
							disabled={!canPrompt || images.length >= MAX_ATTACHMENTS}
							aria-label="attach images"
							title="attach images"
						>
							<ImagePlus size={16} />
						</button>
					</>
				)}
				<textarea
					ref={taRef}
					className="sh-composer-input"
					value={text}
					onChange={e => setText(e.target.value)}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
					onCompositionStart={onCompositionStart}
					onCompositionEnd={onCompositionEnd}
					placeholder={
						readOnly
							? "Read-only session — watching only"
							: !live
								? "Waiting for the session…"
								: images.length > 0
									? "Say something about the image…"
									: "Prompt the host agent…"
					}
					disabled={!canPrompt}
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
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						onClick={() => send()}
						disabled={!canSend}
						title="send (Enter)"
					>
						<SendHorizontal size={12} /> <span className="sh-btn-label">Send</span>
					</button>
				</div>
			</div>
		</div>
	);
});
