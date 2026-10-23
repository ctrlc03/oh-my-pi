import type { VmAction, VmEntry, VmReadiness, VmStatus } from "@oh-my-pi/pi-wire/vm";
import {
	LoaderCircle,
	Link2,
	Play,
	Plus,
	RefreshCw,
	RotateCcw,
	Server,
	Square,
	Trash2,
	TriangleAlert,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { extractPairing, type CompanionClient, type PairingLink } from "../../lib/companion";
import { VmCreateForm } from "./VmCreateForm";
import "./vm.css";

/** While a VM has a job running the list is read this often. */
export const VM_POLL_MS = 3_000;

const STATUS_LABEL: Record<VmStatus, string> = {
	creating: "Creating",
	running: "Running",
	stopped: "Stopped",
	failed: "Failed",
	missing: "Missing",
};

/** The actions offered for a VM that has no job running. */
export function vmActionsFor(status: VmStatus): { start: boolean; stop: boolean; pair: boolean; reset: boolean } {
	return {
		start: status === "stopped",
		stop: status === "running",
		pair: status === "running",
		reset: status !== "creating",
	};
}

interface VmListState {
	status: "loading" | "ready" | "error";
	ready: VmReadiness | null;
	vms: VmEntry[];
	error: string | null;
}

/**
 * The computer's VMs, read now and again every few seconds while one has a job running. A VM this view saw working (or
 * was asked to start working) that finishes with a `pairUrl` is paired at once through `onPair`; `added` lists those.
 */
export function useVmList(
	client: CompanionClient,
	onPair?: (link: PairingLink) => void,
): VmListState & { added: string[]; refresh(): Promise<void>; watch(name: string): void } {
	const [state, setState] = useState<VmListState>({ status: "loading", ready: null, vms: [], error: null });
	const [added, setAdded] = useState<string[]>([]);
	const watched = useRef(new Set<string>());
	const paired = useRef(new Set<string>());
	const onPairRef = useRef(onPair);
	onPairRef.current = onPair;
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	const refresh = useCallback(async (): Promise<void> => {
		try {
			const reply = await client.vmList();
			if (!alive.current) return;
			setState({ status: "ready", ready: reply.ready, vms: reply.vms, error: null });
			for (const vm of reply.vms) {
				if (vm.busy !== undefined) watched.current.add(vm.name);
				else if (vm.pairUrl !== undefined && watched.current.has(vm.name) && !paired.current.has(vm.pairUrl)) {
					paired.current.add(vm.pairUrl);
					const link = extractPairing(vm.pairUrl);
					if (link !== null && onPairRef.current !== undefined) {
						onPairRef.current(link);
						setAdded(names => [...names.filter(name => name !== vm.name), vm.name]);
					}
				}
			}
		} catch (err) {
			if (!alive.current) return;
			const message = err instanceof Error ? err.message : String(err);
			setState(prev => ({ ...prev, status: prev.status === "ready" ? "ready" : "error", error: message }));
		}
	}, [client]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const anyBusy = state.vms.some(vm => vm.busy !== undefined);
	useEffect(() => {
		if (!anyBusy) return;
		const timer = setInterval(() => void refresh(), VM_POLL_MS);
		return () => clearInterval(timer);
	}, [anyBusy, refresh]);

	const watch = useCallback((name: string): void => {
		watched.current.add(name);
	}, []);
	return { ...state, added, refresh, watch };
}

/** Why a VM cannot be created on the computer yet, and the command that fixes it; nothing when it can. */
export function VmReadinessNote({ ready, computerName }: { ready: VmReadiness; computerName?: string }): ReactNode {
	if (ready.ok) return null;
	return (
		<div className="sh-vm-problem" role="alert">
			<TriangleAlert size={15} aria-hidden="true" />
			<div>
				<div>{ready.reason ?? "Virtual machines cannot be created on this computer yet."}</div>
				{!ready.github.configured && (
					<div className="sh-field-hint">
						Set up the GitHub App VMs use: run <code>omp vm github setup</code> on{" "}
						{computerName ?? "the computer"}.
					</div>
				)}
			</div>
		</div>
	);
}

function repoSummary(vm: VmEntry): string {
	if (vm.repos.length === 0) return "No repositories";
	return vm.repos.length > 2 ? `${vm.repos.slice(0, 2).join(", ")} +${vm.repos.length - 2}` : vm.repos.join(", ");
}

const CONFIRM_TEXT: Record<"reset" | "delete", string> = {
	reset: "Reset recreates the VM from its template and repositories. Anything else on its disk is lost, and it is paired again as a new computer: remove the old one from Paired computers.",
	delete: "Delete removes the VM and its disk, and revokes its access. Paired devices then show the computer offline.",
};

/** One VM: its name, repositories, size and status (and what its job is doing), and what can be done to it. */
export function VmRow({
	vm,
	pending,
	confirming,
	error,
	onAction,
	onConfirm,
	onPair,
}: {
	vm: VmEntry;
	/** A request about this VM is on its way. */
	pending: boolean;
	/** Reset or Delete is waiting for its confirmation. */
	confirming: "reset" | "delete" | null;
	error: string | null;
	onAction(action: VmAction): void;
	onConfirm(action: "reset" | "delete" | null): void;
	onPair(): void;
}): ReactNode {
	const can = vmActionsFor(vm.status);
	const working = vm.busy !== undefined;
	const idle = !working && !pending;
	return (
		<li className="sh-vm">
			<div className="sh-vm-main">
				<Server size={16} aria-hidden="true" />
				<div className="sh-vm-text">
					<div className="sh-vm-name">
						{vm.name}
						<span className={`sh-chip sh-vm-status sh-vm-status-${vm.status}`}>{STATUS_LABEL[vm.status]}</span>
					</div>
					<div className="sh-field-hint">
						{repoSummary(vm)} · {vm.cpus} CPUs · {vm.memoryGiB} GiB · {vm.diskGiB} GiB disk ·{" "}
						{vm.network === "open" ? "open network" : "allowlist network"}
					</div>
					{vm.busy !== undefined && (
						<div className="sh-field-hint sh-vm-busy" role="status">
							<LoaderCircle size={12} className="sh-spin" aria-hidden="true" /> {vm.busy.message}
							{vm.busy.step !== "" && <code>{vm.busy.step}</code>}
						</div>
					)}
					{vm.error !== undefined && vm.busy === undefined && <div className="sh-connect-error">{vm.error}</div>}
				</div>
			</div>
			{confirming !== null ? (
				<div className="sh-vm-confirm" role="alertdialog" aria-label={`Confirm ${confirming} ${vm.name}`}>
					<div className="sh-field-hint">{CONFIRM_TEXT[confirming]}</div>
					<div className="sh-review-confirm-actions">
						<button type="button" className="sh-btn" onClick={() => onConfirm(null)}>
							Cancel
						</button>
						<button type="button" className="sh-btn sh-btn-primary" onClick={() => onAction(confirming)}>
							{confirming === "reset" ? "Reset" : "Delete"} {vm.name}
						</button>
					</div>
				</div>
			) : (
				<div className="sh-vm-actions">
					{can.pair && (
						<button
							type="button"
							className="sh-btn"
							onClick={onPair}
							disabled={!idle}
							aria-label={`Pair ${vm.name}`}
						>
							<Link2 size={14} /> Pair
						</button>
					)}
					{can.start && (
						<button
							type="button"
							className="sh-btn"
							onClick={() => onAction("start")}
							disabled={!idle}
							aria-label={`Start ${vm.name}`}
						>
							<Play size={14} /> Start
						</button>
					)}
					{can.stop && (
						<button
							type="button"
							className="sh-btn"
							onClick={() => onAction("stop")}
							disabled={!idle}
							aria-label={`Stop ${vm.name}`}
						>
							<Square size={14} /> Stop
						</button>
					)}
					{can.reset && (
						<button
							type="button"
							className="sh-btn"
							onClick={() => onConfirm("reset")}
							disabled={!idle}
							aria-label={`Reset ${vm.name}`}
						>
							<RotateCcw size={14} /> Reset
						</button>
					)}
					<button
						type="button"
						className="sh-btn"
						onClick={() => onConfirm("delete")}
						disabled={!idle}
						aria-label={`Delete ${vm.name}`}
					>
						<Trash2 size={14} /> Delete
					</button>
				</div>
			)}
			{error && <div className="sh-connect-error">{error}</div>}
		</li>
	);
}

/** A computer's VMs with their actions. `onPair` takes the link a VM's companion pairs with. */
export function VmRows({
	vms,
	onAction,
	onPair,
}: {
	vms: readonly VmEntry[];
	onAction(name: string, action: VmAction): Promise<void>;
	onPair(name: string): Promise<void>;
}): ReactNode {
	const [confirming, setConfirming] = useState<{ name: string; action: "reset" | "delete" } | null>(null);
	const [pending, setPending] = useState<string | null>(null);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const run = async (name: string, work: () => Promise<void>): Promise<void> => {
		setPending(name);
		setConfirming(null);
		setErrors(prev => Object.fromEntries(Object.entries(prev).filter(([key]) => key !== name)));
		try {
			await work();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setErrors(prev => ({ ...prev, [name]: message }));
		} finally {
			setPending(null);
		}
	};
	return (
		<ul className="sh-vms" aria-label="Virtual machines">
			{vms.map(vm => (
				<VmRow
					key={vm.name}
					vm={vm}
					pending={pending === vm.name}
					confirming={confirming?.name === vm.name ? confirming.action : null}
					error={errors[vm.name] ?? null}
					onAction={action => void run(vm.name, () => onAction(vm.name, action))}
					onConfirm={action => setConfirming(action === null ? null : { name: vm.name, action })}
					onPair={() => void run(vm.name, () => onPair(vm.name))}
				/>
			))}
		</ul>
	);
}

/**
 * The computer's virtual machines (needs `canVms`): why one cannot be created, the VMs with Start, Stop, Reset, Delete and
 * Pair, and the New VM form. A VM that finishes creating is paired as a computer by itself.
 */
export function VmSettings({
	client,
	computerName,
	onPair,
}: {
	client: CompanionClient;
	/** The computer's name, given when several are paired so the text can say which one; undefined: "the computer". */
	computerName?: string;
	onPair(link: PairingLink): void;
}): ReactNode {
	const list = useVmList(client, onPair);
	const [creating, setCreating] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const { refresh, watch } = list;

	const act = useCallback(
		async (name: string, action: VmAction): Promise<void> => {
			await client.vmAction(name, action);
			watch(name);
			await refresh();
		},
		[client, refresh, watch],
	);
	const pair = useCallback(
		async (name: string): Promise<void> => {
			const { url } = await client.vmPair(name);
			const link = extractPairing(url);
			if (link === null) throw new Error("The computer did not return a pairing link.");
			onPair(link);
			setNotice(`${name} was added as a computer; it appears under Paired computers once it connects.`);
		},
		[client, onPair],
	);

	if (list.status === "loading") {
		return (
			<div className="sh-companion-empty sh-file-status">
				<LoaderCircle size={14} className="sh-spin" /> Loading…
			</div>
		);
	}
	if (list.status === "error" || list.ready === null) {
		return (
			<div className="sh-tree-error">
				<div className="sh-connect-error">{list.error}</div>
				<button type="button" className="sh-btn" onClick={() => void refresh()}>
					<RefreshCw size={14} /> Retry
				</button>
			</div>
		);
	}
	const { ready, vms, added } = list;
	return (
		<div className="sh-spend sh-vm-panel">
			<VmReadinessNote ready={ready} computerName={computerName} />
			{vms.length === 0 ? (
				<span className="sh-field-hint">{computerName ?? "The computer"} has no virtual machines yet.</span>
			) : (
				<VmRows vms={vms} onAction={act} onPair={pair} />
			)}
			{added.map(name => (
				<div key={name} className="sh-field-hint" role="status">
					{name} is ready and was added as a computer; it appears under Paired computers once it connects.
				</div>
			))}
			{notice && (
				<div className="sh-field-hint" role="status">
					{notice}
				</div>
			)}
			{list.error && <div className="sh-connect-error">{list.error}</div>}
			{creating ? (
				<VmCreateForm
					client={client}
					disabledReason={
						ready.ok ? null : (ready.reason ?? "Virtual machines cannot be created on this computer yet.")
					}
					onCreated={name => {
						watch(name);
						setCreating(false);
						void refresh();
					}}
					onCancel={() => setCreating(false)}
				/>
			) : (
				<div className="sh-review-confirm-actions">
					<button type="button" className="sh-btn" onClick={() => setCreating(true)}>
						<Plus size={14} /> New VM
					</button>
				</div>
			)}
		</div>
	);
}

/**
 * The New virtual machine panel of Add a computer: the form for the computer that can run VMs and, once it was accepted,
 * how the new VM is coming along; when it is ready the app pairs with it.
 */
export function VmCreate({
	client,
	computerName,
	onPair,
}: {
	client: CompanionClient;
	computerName?: string;
	onPair(link: PairingLink): void;
}): ReactNode {
	const list = useVmList(client, onPair);
	const [creating, setCreating] = useState<string | null>(null);
	const { refresh, watch } = list;
	const vm = creating === null ? undefined : list.vms.find(entry => entry.name === creating);
	return (
		<div className="sh-vm-panel">
			{list.ready !== null && <VmReadinessNote ready={list.ready} computerName={computerName} />}
			{list.error && <div className="sh-connect-error">{list.error}</div>}
			<VmCreateForm
				client={client}
				disabledReason={
					list.ready === null || list.ready.ok
						? null
						: (list.ready.reason ?? "Virtual machines cannot be created on this computer yet.")
				}
				onCreated={name => {
					watch(name);
					setCreating(name);
					void refresh();
				}}
			/>
			{creating !== null && vm?.busy !== undefined && (
				<div className="sh-field-hint sh-vm-busy" role="status">
					<LoaderCircle size={12} className="sh-spin" aria-hidden="true" /> {creating}: {vm.busy.message}
				</div>
			)}
			{creating !== null && vm?.busy === undefined && vm?.error !== undefined && (
				<div className="sh-connect-error">{vm.error}</div>
			)}
			{creating !== null && list.added.includes(creating) && (
				<div className="sh-field-hint" role="status">
					{creating} is ready and was added as a computer.
				</div>
			)}
		</div>
	);
}
