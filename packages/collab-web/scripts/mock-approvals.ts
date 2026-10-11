import type { CollabApprovalChoiceKind, CollabUiApproval, HostFrame } from "@oh-my-pi/pi-wire";

const LABELS: Record<CollabApprovalChoiceKind, string> = {
	once: "Allow once",
	session: "Always allow (this session)",
	project: "Always allow (this project)",
	deny: "Deny",
	"deny-project": "Deny always (this project)",
};
const KINDS = Object.keys(LABELS) as CollabApprovalChoiceKind[];
const DEFAULT_COMMAND = "bun test src/lib/client.test.ts";

interface PendingApproval {
	command: string;
	pattern: string;
}

interface MockApprovalsHost {
	/** Sends `frame` to every writer. */
	sendWriters(frame: HostFrame): void;
	notice(level: "info" | "warning" | "error", message: string): void;
	/** Whether a guest's project-scoped choice is honored, as `collab.guestsCanSaveApprovals`. */
	guestsCanSaveProject: boolean;
}

/** The pattern the real host derives for a simple command: program and subcommand, then a wildcard. */
function patternOf(command: string): string {
	const words = command.trim().split(/\s+/u);
	return words.length > 2 ? `${words.slice(0, 2).join(" ")} *` : words.join(" ");
}

function covers(pattern: string, command: string): boolean {
	return pattern.endsWith(" *")
		? command === pattern.slice(0, -2) || command.startsWith(pattern.slice(0, -1))
		: command === pattern;
}

/**
 * The tool-approval prompt of a real host with feature `approval-grants`, for a guest typing
 * `approve [command]`: the same options and labels, the guest-project refusal, and saved session /
 * project rules that stop (or forbid) the next prompt for the same command.
 */
export class MockApprovals {
	#seq = 0;
	#pending = new Map<number, PendingApproval>();
	#allow = { session: [] as string[], project: [] as string[] };
	#deny: string[] = [];
	readonly #host: MockApprovalsHost;

	constructor(host: MockApprovalsHost) {
		this.#host = host;
	}

	/** Handles an `approve [command]` prompt; false for any other text. */
	prompt(text: string): boolean {
		const match = /^approve(?:\s+(.+))?$/iu.exec(text.trim());
		if (!match) return false;
		const command = match[1]?.trim() || DEFAULT_COMMAND;
		const pattern = patternOf(command);
		if (this.#deny.some(rule => covers(rule, command))) {
			this.#host.notice("warning", `mock: ${command} refused by a saved deny rule`);
			return true;
		}
		if ([...this.#allow.session, ...this.#allow.project].some(rule => covers(rule, command))) {
			this.#host.notice("info", `mock: ${command} allowed by a saved rule, no prompt`);
			return true;
		}
		const reqId = 9000 + ++this.#seq;
		this.#pending.set(reqId, { command, pattern });
		const approval: CollabUiApproval = {
			tool: "bash",
			rule: `bash: ${pattern}`,
			guestProject: this.#host.guestsCanSaveProject,
			choices: KINDS.map(kind => ({ label: LABELS[kind], kind })),
		};
		this.#host.sendWriters({
			t: "ui-request",
			request: {
				kind: "select",
				reqId,
				title: `Allow tool: bash\nCommand: ${command}\nRule saved by "always" choices: bash: ${pattern}`,
				options: KINDS.map(kind => LABELS[kind]),
				approval,
			},
		});
		return true;
	}

	/** Applies a guest's `ui-response`; false when no approval prompt is waiting under `reqId`. */
	answer(reqId: number, value: string | undefined): boolean {
		const pending = this.#pending.get(reqId);
		if (!pending) return false;
		this.#pending.delete(reqId);
		this.#host.sendWriters({ t: "ui-request-end", reqId });
		let kind = KINDS.find(candidate => LABELS[candidate] === value) ?? "deny";
		if ((kind === "project" || kind === "deny-project") && !this.#host.guestsCanSaveProject) {
			this.#host.notice(
				"warning",
				"mock: a guest's project-wide choice applies to this call only: collab.guestsCanSaveApprovals is off",
			);
			kind = kind === "project" ? "once" : "deny";
		}
		if (kind === "session") this.#allow.session.push(pending.pattern);
		if (kind === "project") this.#allow.project.push(pending.pattern);
		if (kind === "deny-project") this.#deny.push(pending.pattern);
		const approved = kind === "once" || kind === "session" || kind === "project";
		this.#host.notice(
			approved ? "info" : "warning",
			`mock: ${pending.command} ${approved ? "approved" : "denied"} (${kind})`,
		);
		return true;
	}
}
