import { ClipboardPaste, Plus, ScanLine, Server } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { extractPairing, type PairingLink } from "../../lib/companion";
import type { ComputerHandle } from "../../lib/computers";
import { QrScanner } from "./QrScanner";
import { VmCreate } from "./VmSettings";

export interface AddComputerProps {
	/** A pairing link was pasted or scanned; the app pairs with the computer it names (see `useComputers`). */
	onPair(link: PairingLink): void;
	/** After a link was taken: the settings sheet can say so. */
	onPaired?: () => void;
	/**
	 * The paired computers. When one can create virtual machines (`canVms`) a *New virtual machine* button asks it to;
	 * the new VM is paired as a computer when it is ready.
	 */
	computers?: readonly ComputerHandle[];
}

/** Scan a computer's pairing QR code, or paste its pairing link (`omp companion --pair` prints both); or create a VM on a computer that can. */
export function AddComputer({ onPair, onPaired, computers = [] }: AddComputerProps): ReactNode {
	const [text, setText] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [scanning, setScanning] = useState(false);
	const [vmOpen, setVmOpen] = useState(false);
	const [vmHost, setVmHost] = useState<string | null>(null);
	const vmHosts = computers.filter(
		computer => computer.snap.canVms && computer.snap.phase === "live" && computer.client !== null,
	);
	const vmComputer = vmHosts.find(computer => computer.id === vmHost) ?? vmHosts[0];
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
		<div className="sh-add-computer">
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
			{vmComputer !== undefined && vmComputer.client !== null && (
				<div className="sh-add-computer sh-add-vm">
					<button type="button" className="sh-btn" onClick={() => setVmOpen(open => !open)} aria-expanded={vmOpen}>
						<Server size={15} /> New virtual machine
					</button>
					{vmOpen && (
						<>
							{vmHosts.length > 1 && (
								<label className="sh-field">
									<span className="sh-field-label">Create it on</span>
									<select
										className="sh-input"
										value={vmComputer.id}
										onChange={e => setVmHost(e.currentTarget.value)}
									>
										{vmHosts.map(computer => (
											<option key={computer.id} value={computer.id}>
												{computer.name}
											</option>
										))}
									</select>
								</label>
							)}
							<VmCreate
								key={vmComputer.id}
								client={vmComputer.client}
								computerName={vmHosts.length > 1 ? vmComputer.name : undefined}
								onPair={link => {
									onPair(link);
									onPaired?.();
								}}
							/>
						</>
					)}
				</div>
			)}
		</div>
	);
}
