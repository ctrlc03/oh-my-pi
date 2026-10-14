import { ClipboardPaste, Plus, ScanLine } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { extractPairing, type PairingLink } from "../../lib/companion";
import { QrScanner } from "./QrScanner";

export interface AddComputerProps {
	/** A pairing link was pasted or scanned; the app pairs with the computer it names (see `useComputers`). */
	onPair(link: PairingLink): void;
	/** After a link was taken: the settings sheet can say so. */
	onPaired?: () => void;
}

/** Scan a computer's pairing QR code, or paste its pairing link (`omp companion --pair` prints both). */
export function AddComputer({ onPair, onPaired }: AddComputerProps): ReactNode {
	const [text, setText] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [scanning, setScanning] = useState(false);
	const canPaste = typeof navigator !== "undefined" && typeof navigator.clipboard?.readText === "function";

	const take = (raw: string): void => {
		const link = extractPairing(raw);
		if (link === null) {
			setError("That is not a pairing link. Run `omp companion --pair` on the computer to get one.");
			return;
		}
		setError(null);
		setText("");
		onPair(link);
		onPaired?.();
	};

	const submit = (e: FormEvent<HTMLFormElement>): void => {
		e.preventDefault();
		take(text);
	};

	const paste = async (): Promise<void> => {
		try {
			take(await navigator.clipboard.readText());
		} catch {
			setError("Clipboard access was blocked. Long-press the field and paste instead.");
		}
	};

	return (
		<form className="sh-add-computer" onSubmit={submit}>
			<div className="sh-connect-quick">
				{canPaste && (
					<button type="button" className="sh-btn" onClick={() => void paste()}>
						<ClipboardPaste size={16} /> Paste link
					</button>
				)}
				<button type="button" className="sh-btn" onClick={() => setScanning(true)}>
					<ScanLine size={16} /> Scan QR
				</button>
			</div>
			<label className="sh-field">
				<span className="sh-field-label">Pairing link</span>
				<input
					className="sh-input sh-input-mono"
					type="text"
					inputMode="url"
					enterKeyHint="go"
					value={text}
					onChange={e => setText(e.target.value)}
					placeholder="https://…#pair:…"
					spellCheck={false}
					autoComplete="off"
					autoCapitalize="off"
					autoCorrect="off"
				/>
				<span className="sh-field-hint">
					On the other computer run <code>omp companion --pair</code>.
				</span>
			</label>
			{error && <div className="sh-connect-error">{error}</div>}
			<button type="submit" className="sh-btn" disabled={text.trim() === ""}>
				<Plus size={15} /> Add computer
			</button>
			{scanning && (
				<QrScanner
					onLink={found => {
						setScanning(false);
						take(found);
					}}
					onClose={() => setScanning(false)}
				/>
			)}
		</form>
	);
}
