/**
 * CLI handlers for local Collab discovery, explicit link retrieval, and
 * starting hosting in an idle omp session. Listing returns metadata only;
 * capabilities travel over authenticated IPC only when a caller requests a
 * link or starts a session.
 */
import { formatAge } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import {
	COLLAB_REGISTRY_VERSION,
	type CollabHostSnapshot,
	type CollabIdleSnapshot,
	type CollabListOptions,
	type CollabRemoteStartOptions,
	type CollabResolvedLink,
	listCollabSessions,
	resolveCollabHostLink,
	startCollabSession,
} from "../collab/registry";
import { sanitizeDisplayLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";

export interface CollabListCommandArgs {
	/** Emit deterministic machine-readable JSON. */
	json: boolean;
	/** Registry overrides (tests). */
	registry?: CollabListOptions;
}

export interface CollabLinkCommandArgs {
	selector: string;
	/** Request a view-only link instead of control access. */
	view: boolean;
	json: boolean;
	/** Registry overrides (tests). */
	registry?: CollabListOptions;
}

export interface CollabStartCommandArgs {
	selector: string;
	/** Start with view-only access instead of control. */
	view: boolean;
	json: boolean;
	/** Registry overrides (tests). */
	registry?: CollabRemoteStartOptions;
}

/** Versioned top-level JSON shape for `omp collab list --json`. */
export interface CollabListJsonOutput {
	version: number;
	hosts: CollabHostSnapshot[];
	/** Interactive omp processes that are not hosting and can be started with `omp collab start`. */
	idle: CollabIdleSnapshot[];
}

/** Versioned capability response for `omp collab link --json` and `omp collab start --json`. */
export interface CollabLinkJsonOutput extends CollabResolvedLink {
	version: number;
}

/** One session as two lines: identity, then dim details (`generation` only for hosts; `tail` after the shared ones). */
function printSession(
	print: (line: string) => void,
	session: Pick<
		CollabHostSnapshot,
		"instanceId" | "sessionId" | "sessionName" | "cwd" | "pid" | "model" | "startedAt"
	>,
	generation: number | null,
	tail: string[],
): void {
	// Session names and POSIX paths come from other processes and may carry
	// tabs, newlines, or escape bytes; keep each on one clean line.
	const name = session.sessionName ? sanitizeDisplayLine(session.sessionName) : "";
	const sessionId = sanitizeDisplayLine(session.sessionId);
	const label = name ? `${name} (${sessionId})` : sessionId;
	const cwd = sanitizeDisplayLine(shortenPath(session.cwd));
	const details = [
		`pid ${session.pid}`,
		...(generation === null ? [] : [`gen ${generation}`]),
		session.model ? sanitizeDisplayLine(`${session.model.provider}/${session.model.id}`) : "no model",
		`started ${formatAge(Math.round((Date.now() - session.startedAt) / 1000)) || "just now"}`,
		...tail,
	];
	print("");
	print(`${session.instanceId}  ${label}  ${chalk.dim(cwd)}`);
	print(`  ${chalk.dim(details.join(" · "))}`);
}

export async function runCollabListCommand(
	args: CollabListCommandArgs,
	print: (line: string) => void = line => console.log(line),
): Promise<void> {
	const { hosts, idle } = await listCollabSessions(args.registry);
	if (args.json) {
		const output: CollabListJsonOutput = { version: COLLAB_REGISTRY_VERSION, hosts, idle };
		print(JSON.stringify(output, null, 2));
		return;
	}

	if (hosts.length === 0 && idle.length === 0) {
		print(chalk.dim("No active Collab hosts."));
		return;
	}

	if (hosts.length === 0) {
		print(chalk.dim("No active Collab hosts."));
	} else {
		print(chalk.green(`${hosts.length} active Collab ${hosts.length === 1 ? "host" : "hosts"}`));
	}
	for (const host of hosts) {
		const guests = host.participants - 1;
		const tail = [
			`${guests} ${guests === 1 ? "guest" : "guests"}`,
			host.access,
			`relay ${host.relayConnected ? "connected" : "reconnecting"}`,
		];
		if (host.inputRequired) tail.push("input required");
		if (host.busy !== null) tail.push(host.busy ? "working" : "idle");
		printSession(print, host, host.generation, tail);
	}
	if (hosts.length > 0) print(chalk.dim("Get a link: omp collab link <instanceId|pid> [--view]"));

	if (idle.length === 0) return;
	if (hosts.length > 0) print("");
	print(chalk.green(`${idle.length} idle omp ${idle.length === 1 ? "session" : "sessions"} (not shared)`));
	for (const session of idle) printSession(print, session, null, [session.busy ? "working" : "idle"]);
	print(chalk.dim("Share one: omp collab start <instanceId|pid> [--view]"));
}

export async function runCollabLinkCommand(
	args: CollabLinkCommandArgs,
	print: (line: string) => void = line => console.log(line),
): Promise<void> {
	const link = await resolveCollabHostLink(args.selector, args.view ? "view" : "control", args.registry);
	if (args.json) {
		const output: CollabLinkJsonOutput = { version: COLLAB_REGISTRY_VERSION, ...link };
		print(JSON.stringify(output, null, 2));
		return;
	}
	print(link.url);
}

export async function runCollabStartCommand(
	args: CollabStartCommandArgs,
	print: (line: string) => void = line => console.log(line),
): Promise<void> {
	const link = await startCollabSession(args.selector, args.view ? "view" : "control", args.registry);
	if (args.json) {
		const output: CollabLinkJsonOutput = { version: COLLAB_REGISTRY_VERSION, ...link };
		print(JSON.stringify(output, null, 2));
		return;
	}
	print(link.url);
}
