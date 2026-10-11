import type { CollabApprovalChoiceKind, CollabUiApproval, HostFrame, SessionPermission } from "@oh-my-pi/pi-wire";

interface Choice {
	kind: CollabApprovalChoiceKind;
	label: string;
}

/** omp's prompt: its labels and the rules it can save. */
const OMP_CHOICES: Choice[] = [
	{ kind: "once", label: "Allow once" },
	{ kind: "session", label: "Always allow (this session)" },
	{ kind: "project", label: "Always allow (this project)" },
	{ kind: "deny", label: "Deny" },
	{ kind: "deny-project", label: "Deny always (this project)" },
];
/** A vendor agent's prompt: its tool permission request, answered once, for the session, or denied. */
const FOREIGN_CHOICES: Choice[] = [
	{ kind: "once", label: "Approve once" },
	{ kind: "session", label: "Approve for this session" },
	{ kind: "deny", label: "Deny" },
];
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
	/** A vendor agent's session: the prompt has its choices, and `full` access approves without asking. */
	foreign?: { permission(): SessionPermission };
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
	readonly #choices: Choice[];
	readonly #host: MockApprovalsHost;

	constructor(host: MockApprovalsHost) {
		this.#host = host;
		this.#choices = host.foreign ? FOREIGN_CHOICES : OMP_CHOICES;
	}

	/** Handles an `approve [command]` prompt; false for any other text. */
	prompt(text: string): boolean {
		const match = /^approve(?:\s+(.+))?$/iu.exec(text.trim());
		if (!match) return false;
		const command = match[1]?.trim() || DEFAULT_COMMAND;
		const pattern = patternOf(command);
		if (this.#host.foreign?.permission() === "full") {
			this.#host.notice("info", `mock: ${command} approved without asking (full access)`);
			return true;
		}
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
			guestProject: this.#host.foreign ? false : this.#host.guestsCanSaveProject,
			choices: this.#choices.map(({ kind, label }) => ({ label, kind })),
		};
		this.#host.sendWriters({
			t: "ui-request",
			request: {
				kind: "select",
				reqId,
				title: this.#host.foreign
					? `Allow tool: bash\nCommand: ${command}`
					: `Allow tool: bash\nCommand: ${command}\nRule saved by "always" choices: bash: ${pattern}`,
				options: this.#choices.map(choice => choice.label),
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
		let kind = this.#choices.find(choice => choice.label === value)?.kind ?? "deny";
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
