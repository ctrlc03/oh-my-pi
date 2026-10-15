import { describe, expect, it } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DeleteConfirm, DeleteHost, DeleteToast } from "../src/components/shell/DeleteSessions";
import { OrgMenuBody } from "../src/components/shell/OrgMenu";
import { OrgSessions } from "../src/components/shell/OrgSessions";
import { SessionRow } from "../src/components/shell/SessionsSheet";
import { SessionsSidebar } from "../src/components/shell/SessionsSidebar";
import {
	type CompanionHost,
	type CompanionIdleSession,
	type CompanionSnapshot,
	INITIAL_SNAPSHOT,
	type SessionOverview,
} from "../src/lib/companion";
import type { ComputerHandle } from "../src/lib/computers";
import { summarizePlan } from "../src/lib/session-delete";
import { applyMany, applyOrg, emptyOrg, type OrgDoc } from "../src/lib/session-org";
import type { SessionOrgControl, SessionOrgs } from "../src/lib/use-session-org";

const NOW = 1_800_000_000_000;
const CLAUDE = { id: "claude", name: "Claude Code" };

function host(n: number, over: Partial<CompanionHost> = {}): CompanionHost {
	return {
		instanceId: `inst-${n}`,
		sessionId: `s-${n}`,
		sessionName: `session-${n}`,
		cwd: `/work/session-${n}`,
		model: null,
		startedAt: NOW,
		participants: 1,
		busy: false,
		inputRequired: false,
		relayConnected: true,
		...over,
	};
}

function idle(n: number, over: Partial<CompanionIdleSession> = {}): CompanionIdleSession {
	return {
		instanceId: `inst-${n}`,
		sessionId: `s-${n}`,
		sessionName: `session-${n}`,
		cwd: `/work/session-${n}`,
		model: null,
		startedAt: NOW,
		busy: false,
		...over,
	};
}

function overview(n: number, over: Partial<SessionOverview> = {}): SessionOverview {
	return {
		sessionId: `s-${n}`,
		title: `session-${n}`,
		folder: `/work/session-${n}`,
		startedAt: NOW,
		endedAt: NOW,
		requests: 1,
		toolCalls: 1,
		subagents: 0,
		tokens: 1,
		cost: 0,
		models: [],
		...over,
	};
}

function computer(over: Partial<CompanionSnapshot>): ComputerHandle {
	const snap: CompanionSnapshot = { ...INITIAL_SNAPSHOT, phase: "live", machine: "mac", ...over };
	return { id: "mac", name: "mac", client: null, snap, error: null };
}

function control(doc: OrgDoc): SessionOrgControl {
	return {
		doc,
		now: NOW,
		synced: false,
		act: () => {},
		edit: () => ({}),
		restore: () => {},
		extras: true,
		canEndOnSettle: false,
		setSettings: () => {},
	};
}

const settle = (doc: OrgDoc, ...keys: string[]): OrgDoc => applyMany(doc, keys, { type: "settle" }, NOW);

const noop = (): void => {};

describe("the confirm dialog", () => {
	const target = (sessionId: string, title = sessionId) => ({ sessionId, title });
	const ready = (ids: string[], plans: Parameters<typeof summarizePlan>[1]) => {
		const targets = ids.map(id => target(id));
		return { targets, plan: { status: "ready" as const, summary: summarizePlan(targets, plans) } };
	};
	const dialog = (over: Partial<Parameters<typeof DeleteConfirm>[0]> & { targets: ReturnType<typeof target>[] }) =>
		renderToStaticMarkup(
			<DeleteConfirm
				plan={{ status: "loading" }}
				removeWorktree={false}
				deleting={false}
				error={null}
				onWorktree={noop}
				onCancel={noop}
				onConfirm={noop}
				{...over}
			/>,
		);

	it("names what goes: the conversation with its subagents and artifacts, the sidebar entry, the hidden-message marks", () => {
		const html = dialog(ready(["a"], [{ sessionId: "a" }]));
		expect(html).toContain("Delete a?");
		expect(html).toContain("The conversation, with its subagents and artifacts");
		expect(html).toContain("The sidebar entry");
		expect(html).toContain("The hidden-message marks");
		expect(html).toContain("Cancel");
	});

	it("offers the worktree checkbox only when a plan has a worktree, and says it is not undoable", () => {
		const plain = dialog(ready(["a"], [{ sessionId: "a" }]));
		expect(plain).not.toContain("checkbox");
		expect(plain).not.toContain("worktree");
		const withTree = dialog(ready(["a"], [{ sessionId: "a", worktree: "/work/.wt/a" }]));
		expect(withTree).toContain('type="checkbox"');
		expect(withTree).toContain("Also remove its worktree");
		expect(withTree).toContain("The worktree folder stays unless you tick this.");
		expect(withTree).toContain("git worktree remove without force");
		expect(withTree).toContain("uncommitted changes is reported and kept");
		expect(withTree).toContain("can&#x27;t be undone");
		expect(withTree).toContain("/work/.wt/a");
		expect(withTree).not.toContain("checked");
		expect(
			dialog({ ...ready(["a"], [{ sessionId: "a", worktree: "/work/.wt/a" }]), removeWorktree: true }),
		).toContain('checked=""');
	});

	it("has no checkbox for a session whose worktree is refused or gone", () => {
		expect(dialog(ready(["a"], [{ sessionId: "a", refused: "No.", worktree: "/work/.wt/a" }]))).not.toContain(
			"checkbox",
		);
	});

	it("says a running session is ended first", () => {
		expect(dialog(ready(["a"], [{ sessionId: "a", running: true }]))).toContain(
			"It is running; it will be ended first.",
		);
		const several = dialog(ready(["a", "b"], [{ sessionId: "a", running: true }, { sessionId: "b" }]));
		expect(several).toContain("a is running; it will be ended first.");
		expect(several).not.toContain("b is running");
	});

	it("shows each refusal plainly, deletes the rest, and disables Delete when every session is refused", () => {
		const mixed = dialog(
			ready(
				["a", "b"],
				[{ sessionId: "a", refused: "It is running in a terminal. End it there first." }, { sessionId: "b" }],
			),
		);
		expect(mixed).toContain("a: It is running in a terminal. End it there first.");
		expect(mixed).toMatch(/class="sh-btn sh-btn-stop"[^>]*>(<svg.*?<\/svg>)? ?Delete<\/button>/);
		expect(mixed.match(/class="sh-btn sh-btn-stop"[^>]*disabled/)).toBeNull();
		const alone = dialog(
			ready(["a"], [{ sessionId: "a", refused: "The Personal agent's session can't be deleted here." }]),
		);
		expect(alone).toContain("The Personal agent&#x27;s session can&#x27;t be deleted here.");
		expect(alone).not.toContain("This deletes");
		expect(alone.match(/class="sh-btn sh-btn-stop"[^>]*disabled/)).not.toBeNull();
	});

	it("counts the sessions Delete takes, and waits for the plan before it can be pressed", () => {
		const many = dialog(
			ready(["a", "b", "c"], [{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c", refused: "No." }]),
		);
		expect(many).toContain("Delete 2 sessions");
		const loading = dialog({ targets: [target("a")] });
		expect(loading).toContain("Asking your computer");
		expect(loading.match(/class="sh-btn sh-btn-stop"[^>]*disabled/)).not.toBeNull();
		const failed = dialog({
			targets: [target("a")],
			plan: { status: "error", message: "The computer is not answering." },
		});
		expect(failed).toContain("The computer is not answering.");
		expect(failed.match(/class="sh-btn sh-btn-stop"[^>]*disabled/)).not.toBeNull();
	});

	it("shows an error from the delete itself and keeps the dialog usable", () => {
		const html = dialog({ ...ready(["a"], [{ sessionId: "a" }]), error: "Timed out." });
		expect(html).toContain("Timed out.");
		expect(html.match(/class="sh-btn sh-btn-stop"[^>]*disabled/)).toBeNull();
	});
});

describe("the toast", () => {
	const toast = (over: Partial<Parameters<typeof DeleteToast>[0]>) =>
		renderToStaticMarkup(
			<DeleteToast
				message="Deleted alpha"
				notes={[]}
				canUndo
				undoing={false}
				onUndo={noop}
				onDismiss={noop}
				{...over}
			/>,
		);

	it("offers Undo beside what was deleted", () => {
		const html = toast({});
		expect(html).toContain("Deleted alpha");
		expect(html).toContain("Undo");
		expect(html).not.toContain("Dismiss");
	});

	it("shows what did not go as asked, with a way to dismiss it", () => {
		const html = toast({ notes: ["Its worktree was kept: the worktree has uncommitted changes"] });
		expect(html).toContain("Its worktree was kept: the worktree has uncommitted changes");
		expect(html).toContain('aria-label="Dismiss"');
	});

	it("leads with the first note when nothing was deleted, and offers no Undo", () => {
		const html = toast({
			message: "",
			canUndo: false,
			notes: ["alpha: It is running in a terminal. End it there first.", "beta: Not found."],
		});
		expect(html).toContain("alpha: It is running in a terminal. End it there first.");
		expect(html).toContain("beta: Not found.");
		expect(html).not.toContain("Undo");
	});
});

describe("Delete in a row's menu", () => {
	const menu = (over: { ended?: boolean; onDelete: (() => void) | null }) =>
		renderToStaticMarkup(
			<OrgMenuBody
				title="docs-pass"
				status="active"
				place={null}
				autoSettle={null}
				limitResetAt={null}
				ended={over.ended ?? false}
				now={NOW}
				onAct={noop}
				onMove={noop}
				onArrange={noop}
				onSelect={noop}
				onClose={noop}
				onDelete={over.onDelete}
			/>,
		);

	it("is there when the row can be deleted, an ended one's menu too", () => {
		expect(menu({ onDelete: noop })).toContain("Delete…");
		expect(menu({ onDelete: noop, ended: true })).toContain("Delete…");
	});

	it("is absent when it cannot", () => {
		expect(menu({ onDelete: null })).not.toContain("Delete…");
		expect(menu({ onDelete: null, ended: true })).not.toContain("Delete…");
	});
});

describe("Delete in All sessions", () => {
	const row = (onDelete?: () => void) =>
		renderToStaticMarkup(
			<ul>
				<SessionRow
					session={overview(1, { title: "docs-pass" })}
					current={false}
					busy={null}
					canStart
					onOpen={noop}
					onShare={noop}
					onResume={noop}
					onDelete={onDelete}
				/>
			</ul>,
		);

	it("is a button on the row when offered", () => {
		expect(row(noop)).toContain('aria-label="Delete docs-pass"');
	});

	it("is not drawn when it is not offered", () => {
		expect(row()).not.toContain("Delete docs-pass");
	});
});

describe("Delete settled sessions…", () => {
	function orgSessions(opts: {
		hosts?: CompanionHost[];
		idle?: CompanionIdleSession[];
		ended?: SessionOverview[];
		doc: OrgDoc;
		onDelete: (() => void) | null;
	}): string {
		return renderToStaticMarkup(
			<OrgSessions
				hosts={opts.hosts ?? []}
				idle={opts.idle ?? []}
				rooms={[]}
				twins={new Map()}
				org={control(opts.doc)}
				joining={null}
				disabled={false}
				currentSessionId={null}
				currentRoomId={null}
				limitResetAt={null}
				onJoinHost={noop}
				onShare={noop}
				onOpenRoom={noop}
				ended={opts.ended ?? []}
				canResume
				onResumeEnded={() => Promise.resolve(true)}
				onDelete={opts.onDelete}
			/>,
		);
	}
	const bulk = (html: string): string | null => /class="sh-org-bulk"[^>]*>([^<]*)</.exec(html)?.[1] ?? null;

	it("counts the settled omp sessions: live-settled and ended history rows alike", () => {
		const doc = settle(emptyOrg(), "s-1", "s-2", "s-3", "s-4");
		const html = orgSessions({
			hosts: [host(1)],
			idle: [idle(2)],
			ended: [overview(3), overview(4)],
			doc,
			onDelete: noop,
		});
		expect(bulk(html)).toBe("Delete 4 settled sessions…");
	});

	it("leaves out vendor agents' sessions, the Personal agent's and rooms", () => {
		const doc = settle(emptyOrg(), "s-1", "s-2", "s-3", "s-4", "s-5");
		const html = orgSessions({
			hosts: [host(1), host(2, { agent: CLAUDE }), host(5, { personal: true })],
			idle: [idle(3, { agent: CLAUDE })],
			ended: [overview(4, { agent: CLAUDE })],
			doc,
			onDelete: noop,
		});
		expect(bulk(html)).toBe("Delete 1 settled session…");
	});

	it("only counts settled sessions, not the active, pinned or snoozed ones", () => {
		let doc = settle(emptyOrg(), "s-1", "s-2");
		doc = applyOrg(doc, "s-3", { type: "pin" }, NOW);
		const html = orgSessions({ hosts: [host(1), host(2), host(3), host(4)], doc, onDelete: noop });
		expect(bulk(html)).toBe("Delete 2 settled sessions…");
	});

	it("is not drawn when the computer cannot delete, or nothing deletable is settled", () => {
		const doc = settle(emptyOrg(), "s-1");
		expect(bulk(orgSessions({ hosts: [host(1)], doc, onDelete: null }))).toBeNull();
		expect(bulk(orgSessions({ hosts: [host(1, { agent: CLAUDE })], doc, onDelete: noop }))).toBeNull();
		expect(bulk(orgSessions({ hosts: [host(1)], doc: emptyOrg(), onDelete: noop }))).toBeNull();
	});
});

describe("the sidebar offers Delete only where the computer can", () => {
	function sidebar(snap: Partial<CompanionSnapshot>, inHost: boolean): string {
		const doc = settle(emptyOrg(), "s-1", "s-2");
		const computers = [computer({ hosts: [host(1), host(2)], ...snap })];
		const orgs: SessionOrgs = { of: () => control(doc) };
		const tree: ReactNode = (
			<SessionsSidebar
				computers={computers}
				rooms={[]}
				orgs={orgs}
				currentSessionId={null}
				currentRoomId={null}
				onOpenHost={() => Promise.resolve()}
				onOpenLink={noop}
				onOpenUsage={null}
				onOpenSessions={null}
				onClose={noop}
			/>
		);
		return renderToStaticMarkup(
			inHost ? (
				<DeleteHost computers={computers} orgs={orgs} onDeleted={noop}>
					{tree}
				</DeleteHost>
			) : (
				tree
			),
		);
	}

	it("shows the bulk button when the computer advertises canDeleteSessions", () => {
		expect(sidebar({ canDeleteSessions: true }, true)).toContain("Delete 2 settled sessions…");
	});

	it("shows nothing for an older companion, and nothing when the computer is not live", () => {
		expect(sidebar({ canDeleteSessions: false }, true)).not.toContain("Delete 2 settled");
		expect(sidebar({ canDeleteSessions: true, phase: "offline" }, true)).not.toContain("Delete 2 settled");
	});

	it("shows nothing without the delete flow mounted", () => {
		expect(sidebar({ canDeleteSessions: true }, false)).not.toContain("Delete 2 settled");
	});
});
