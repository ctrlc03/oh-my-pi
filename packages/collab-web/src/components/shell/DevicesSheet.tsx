import { QrCode } from "@oh-my-pi/pi-tui/chrome/qrcode";
import { Check, Copy, LoaderCircle, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CompanionClient, CompanionDevice } from "../../lib/companion";
import { relTime } from "../../lib/format";
import { useRequest } from "../../lib/use-request";
import { Sheet } from "./Sheet";
import "./devices.css";

/** While an invite is on screen the list refreshes this often, so a device that just paired shows up. */
const INVITE_POLL_MS = 4_000;
/** Quiet zone around the QR code, in modules (the spec asks for four). */
const QR_QUIET_MODULES = 4;

export interface DevicesSheetProps {
	client: CompanionClient;
	onClose(): void;
}

interface Invite {
	url: string;
	/** Ms since epoch. */
	expiresAt: number;
	/** Devices listed when the invite was made: more than that means someone paired with it. */
	baseline: number;
}

/** Devices paired with the computer: rename or remove them, and add another with a one-time QR code. */
export function DevicesSheet({ client, onClose }: DevicesSheetProps): ReactNode {
	const load = useCallback(() => client.requestDevices(), [client]);
	const { state, reload } = useRequest(load);
	// Keep the last list on screen while it reloads.
	const shown = useRef<{ devices: CompanionDevice[]; self: string } | null>(null);
	if (state.status === "ready") shown.current = state.value;
	const list = shown.current;
	const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
	const [invite, setInvite] = useState<Invite | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const deviceCount = list?.devices.length ?? 0;

	useEffect(() => {
		if (invite === null) return;
		const timer = setInterval(reload, INVITE_POLL_MS);
		return () => clearInterval(timer);
	}, [invite, reload]);

	// The invite did its job once another device is listed.
	useEffect(() => {
		if (invite !== null && deviceCount > invite.baseline) setInvite(null);
	}, [invite, deviceCount]);

	const act = async (work: () => Promise<void>): Promise<void> => {
		setBusy(true);
		setError(null);
		try {
			await work();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const rename = (e: FormEvent<HTMLFormElement>): void => {
		e.preventDefault();
		if (editing === null) return;
		void act(async () => {
			await client.renameDevice(editing.id, editing.name);
			setEditing(null);
			reload();
		});
	};

	const remove = (device: CompanionDevice): void => {
		const self = device.id === list?.self;
		const warning = self
			? `Remove ${device.name}? This is the device you are using: it will be signed out and must pair again.`
			: `Remove ${device.name}? It will be signed out and stop getting notifications.`;
		if (!window.confirm(warning)) return;
		void act(async () => {
			await client.removeDevice(device.id);
			reload();
		});
	};

	const addDevice = (): void => {
		void act(async () => {
			const { url, expiresAt } = await client.createInvite();
			setInvite({ url, expiresAt, baseline: deviceCount });
		});
	};

	const loading = state.status === "loading";
	return (
		<Sheet label="devices" onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">Devices</div>
				<span className="sh-devices-head-actions">
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={reload}
						disabled={loading}
						aria-label="refresh"
						title="refresh"
					>
						{loading ? <LoaderCircle size={15} className="sh-spin" /> : <RefreshCw size={15} />}
					</button>
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close">
						<X size={16} />
					</button>
				</span>
			</div>
			{list === null ? (
				state.status === "loading" ? (
					<div className="sh-companion-empty sh-file-status">
						<LoaderCircle size={14} className="sh-spin" /> Reading devices…
					</div>
				) : null
			) : (
				<ul className="sh-devices-list" aria-label="paired devices">
					{list.devices.map(device => (
						<li key={device.id} className="sh-device">
							{editing?.id === device.id ? (
								<form className="sh-device-edit" onSubmit={rename}>
									<input
										className="sh-input"
										type="text"
										value={editing.name}
										onChange={e => setEditing({ id: device.id, name: e.target.value })}
										maxLength={40}
										aria-label="device name"
										autoComplete="off"
										spellCheck={false}
									/>
									<button
										type="submit"
										className="sh-btn sh-btn-icon"
										disabled={busy || editing.name.trim() === ""}
										aria-label="save name"
										title="save"
									>
										<Check size={15} />
									</button>
									<button
										type="button"
										className="sh-btn sh-btn-icon"
										onClick={() => setEditing(null)}
										aria-label="cancel"
										title="cancel"
									>
										<X size={15} />
									</button>
								</form>
							) : (
								<>
									<div className="sh-device-info">
										<span className="sh-recent-title">
											<span className="sh-recent-name">{device.name}</span>
											{device.id === list.self && <span className="sh-chip">this device</span>}
										</span>
										<span className="sh-recent-meta">
											<span>paired {relTime(device.pairedAt)}</span>
											<span>{device.online ? "online now" : `last seen ${relTime(device.lastSeen)}`}</span>
										</span>
									</div>
									<button
										type="button"
										className="sh-btn sh-btn-icon"
										onClick={() => setEditing({ id: device.id, name: device.name })}
										disabled={busy}
										aria-label={`rename ${device.name}`}
										title="rename"
									>
										<Pencil size={15} />
									</button>
									<button
										type="button"
										className="sh-btn sh-btn-icon"
										onClick={() => remove(device)}
										disabled={busy}
										aria-label={`remove ${device.name}`}
										title="remove"
									>
										<Trash2 size={15} />
									</button>
								</>
							)}
						</li>
					))}
				</ul>
			)}
			{invite === null ? (
				<button type="button" className="sh-btn sh-card-action" onClick={addDevice} disabled={busy}>
					<Plus size={15} /> Add a device
				</button>
			) : (
				<InvitePanel
					key={invite.url}
					invite={invite}
					busy={busy}
					onRenew={addDevice}
					onDone={() => setInvite(null)}
				/>
			)}
			{(error ?? (state.status === "error" ? state.message : null)) && (
				<div className="sh-connect-error">{error ?? (state.status === "error" ? state.message : null)}</div>
			)}
		</Sheet>
	);
}

function formatCountdown(ms: number): string {
	const seconds = Math.ceil(ms / 1000);
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

interface InvitePanelProps {
	invite: Invite;
	busy: boolean;
	onRenew(): void;
	onDone(): void;
}

/** The pairing code for one new device: scan it, or copy the link; it works once and expires. */
function InvitePanel({ invite, busy, onRenew, onDone }: InvitePanelProps): ReactNode {
	const [now, setNow] = useState(Date.now);
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(timer);
	}, []);
	const left = invite.expiresAt - now;
	const expired = left <= 0;

	const copy = (): void => {
		navigator.clipboard.writeText(invite.url).then(
			() => setCopied(true),
			() => setCopied(false),
		);
	};

	return (
		<section className="sh-invite" aria-label="pair a new device">
			{expired ? (
				<div className="sh-companion-empty">This code expired.</div>
			) : (
				<>
					<QrSvg text={invite.url} />
					<div className="sh-field-hint">
						Scan with the new device, or open the link there. It works once and expires in{" "}
						<strong>{formatCountdown(left)}</strong>.
					</div>
					<input
						className="sh-input sh-input-mono"
						type="text"
						readOnly
						value={invite.url}
						onFocus={e => e.currentTarget.select()}
						aria-label="pairing link"
					/>
				</>
			)}
			<div className="sh-invite-actions">
				{!expired && (
					<button type="button" className="sh-btn" onClick={copy}>
						{copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy link"}
					</button>
				)}
				{expired && (
					<button type="button" className="sh-btn" onClick={onRenew} disabled={busy}>
						<RefreshCw size={14} /> New code
					</button>
				)}
				<button type="button" className="sh-btn" onClick={onDone}>
					Done
				</button>
			</div>
		</section>
	);
}

/** The text as a QR code: dark modules as one path over a light square, scalable to any width. */
function QrSvg({ text }: { text: string }): ReactNode {
	const { size, path } = useMemo(() => {
		const qr = QrCode.encodeText(text, "M");
		let d = "";
		for (let y = 0; y < qr.size; y++) {
			for (let x = 0; x < qr.size; x++) {
				if (qr.module(x, y)) d += `M${x + QR_QUIET_MODULES} ${y + QR_QUIET_MODULES}h1v1h-1z`;
			}
		}
		return { size: qr.size + QR_QUIET_MODULES * 2, path: d };
	}, [text]);
	return (
		<svg
			className="sh-qr"
			viewBox={`0 0 ${size} ${size}`}
			shapeRendering="crispEdges"
			role="img"
			aria-label="pairing QR code"
		>
			<rect className="sh-qr-paper" width={size} height={size} />
			<path className="sh-qr-ink" d={path} />
		</svg>
	);
}
