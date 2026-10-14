import type { PersonalStatus } from "@oh-my-pi/pi-wire/personal";
import { LoaderCircle, Play, RotateCw, Square } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { relTime } from "../../lib/format";
import { runSummary } from "../../lib/personal";
import { countsLine, headline, runControls, whenLabel } from "../../lib/personal-settings";
import type { PersonalTab } from "../../lib/personal-ui";
import { usePersonal } from "../../lib/use-personal";
import { BackupsCard, Fact, PowerCard, ReviewCard, SpendCard } from "./AgentCards";
import { SetupChecklist } from "./SetupChecklist";
import { HomeGate, useAction } from "./shared";
import { StatusDot } from "./StatusDot";
import "./agent.css";

type ControlAction = "start" | "stop" | "restart";

function StatusCard({ status, goTo }: { status: PersonalStatus; goTo(tab: PersonalTab): void }): ReactNode {
	const personal = usePersonal();
	const control = useAction();
	const [pending, setPending] = useState<ControlAction | null>(null);
	const controls = status.enabled ? runControls(status.run) : { start: false, stop: false, restart: false };
	const summary = runSummary(status);
	const waiting = countsLine(status.counts);
	const failure = status.error ?? (status.run === "failed" ? "The last start failed." : null);

	const act = (action: ControlAction): void => {
		setPending(action);
		void control.run(async () => {
			const reply = await personal.call({ t: "personal-control", action });
			personal.adopt(status.homeComputer.computerId, reply.status);
		});
	};
	const icon = (action: ControlAction, idle: ReactNode): ReactNode =>
		control.busy && pending === action ? <LoaderCircle size={14} className="sh-spin" /> : idle;

	return (
		<section className="pa-card" aria-labelledby="pa-status-title">
			<div className="pa-card-head">
				<h3 id="pa-status-title" className="pa-card-title pa-status-title">
					<StatusDot tone={summary.tone} />
					{summary.label}
				</h3>
				<span className="sh-field-hint">on {status.homeComputer.machine}</span>
			</div>
			<p className="pa-headline">{headline(status)}</p>
			{failure !== null && <div className="pa-note pa-note-err">{failure}</div>}
			{status.enabled && (
				<dl className="pa-facts">
					<Fact label="Session">
						{status.session === null
							? "None running"
							: `Started ${relTime(status.session.startedAt)} · session ${status.session.generation} of the thread`}
					</Fact>
					<Fact label="Next rollover">
						{status.nextRolloverAt === null ? "Not scheduled" : whenLabel(status.nextRolloverAt)}
					</Fact>
				</dl>
			)}
			{(controls.start || controls.stop || controls.restart) && (
				<>
					<div className="pa-actions">
						{controls.start && (
							<button
								type="button"
								className="sh-btn sh-btn-primary"
								disabled={control.busy}
								onClick={() => act("start")}
							>
								{icon("start", <Play size={14} />)} Start
							</button>
						)}
						{controls.restart && (
							<button type="button" className="sh-btn" disabled={control.busy} onClick={() => act("restart")}>
								{icon("restart", <RotateCw size={14} />)} Restart
							</button>
						)}
						{controls.stop && (
							<button type="button" className="sh-btn" disabled={control.busy} onClick={() => act("stop")}>
								{icon("stop", <Square size={14} />)} Stop
							</button>
						)}
					</div>
					{(controls.stop || controls.restart) && (
						<div className="sh-field-hint">
							{controls.stop && "Stop retains and consolidates memory first. "}
							{controls.restart && "Restart rolls over to a fresh session now, with a handoff."}
						</div>
					)}
				</>
			)}
			{control.error !== null && <div className="sh-connect-error">{control.error}</div>}
			{status.enabled && (
				<div className="pa-waiting">
					<span>{waiting ?? "Nothing is waiting for you."}</span>
					{waiting !== null && (
						<button type="button" className="sh-btn" onClick={() => goTo("activity")}>
							Open Activity
						</button>
					)}
				</div>
			)}
		</section>
	);
}

function AgentBody({ goTo }: { goTo(tab: PersonalTab): void }): ReactNode {
	const status = usePersonal().home.status;
	// The checklist stays once shown, so "Login found" is not cut short when the login turns up.
	const [checklist, setChecklist] = useState(status?.login.state === "missing");
	if (status === null) {
		return (
			<div className="sh-companion-empty sh-file-status" role="status">
				<LoaderCircle size={14} className="sh-spin" /> Checking Personal…
			</div>
		);
	}
	if (!checklist && status.login.state === "missing") setChecklist(true);
	return (
		<>
			{checklist && <SetupChecklist status={status} goTo={goTo} />}
			{!status.enabled && <PowerCard status={status} />}
			<StatusCard status={status} goTo={goTo} />
			<SpendCard status={status} />
			<BackupsCard status={status} goTo={goTo} />
			<ReviewCard status={status} />
			{status.enabled && <PowerCard status={status} />}
		</>
	);
}

/** Settings → Personal agent → Agent: what the agent is doing, what it has spent, backups, the review, and the power switch. */
export function AgentTab({ goTo }: { goTo(tab: PersonalTab): void }): ReactNode {
	return (
		<HomeGate>
			<AgentBody goTo={goTo} />
		</HomeGate>
	);
}
