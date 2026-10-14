import type { PersonalStatus } from "@oh-my-pi/pi-wire/personal";
import { Circle, CircleCheck } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect } from "react";
import type { PersonalTab } from "../../lib/personal-ui";
import { usePersonal, usePersonalQuery } from "../../lib/use-personal";
import { CopyLine } from "./shared";
import "./agent.css";

const LOGIN_POLL_MS = 5_000;

function Row({ done, title, children }: { done: boolean; title: string; children?: ReactNode }): ReactNode {
	const Icon = done ? CircleCheck : Circle;
	return (
		<li className={`pa-check-row${done ? " pa-check-done" : ""}`}>
			<Icon size={18} className="pa-check-icon" aria-hidden="true" />
			<div className="pa-check-body">
				<div className="pa-check-title">
					{title}
					<span className="pa-sr-only">{done ? " (done)" : " (to do)"}</span>
				</div>
				{children}
			</div>
		</li>
	);
}

/**
 * The second half of setup: what is left before the agent can run. While the profile has no login it asks the home
 * computer for its status every few seconds (not while the page is hidden), so the row turns by itself once the owner
 * has logged in on that computer. The parent keeps it mounted after that, so the success note is not cut short.
 */
export function SetupChecklist({ status, goTo }: { status: PersonalStatus; goTo(tab: PersonalTab): void }): ReactNode {
	const personal = usePersonal();
	const homeId = personal.home.computer?.id ?? null;
	const { call, adopt } = personal;
	const waiting = status.login.state === "missing";
	const about = usePersonalQuery(personal, ["about"], ask => ask({ t: "personal-about-get" }));
	const aboutDone = about.state.status === "ready" && about.state.value.about.rev > 1;
	const { login } = status;

	useEffect(() => {
		if (!waiting || homeId === null) return;
		let stopped = false;
		const poll = (): void => {
			if (document.hidden) return;
			call({ t: "personal-status" }).then(
				reply => {
					if (!stopped) adopt(homeId, reply.status);
				},
				() => {},
			);
		};
		const timer = setInterval(poll, LOGIN_POLL_MS);
		document.addEventListener("visibilitychange", poll);
		return () => {
			stopped = true;
			clearInterval(timer);
			document.removeEventListener("visibilitychange", poll);
		};
	}, [waiting, homeId, call, adopt]);

	return (
		<section className="pa-card" aria-labelledby="pa-checklist-title">
			<h3 id="pa-checklist-title" className="pa-card-title">
				Finish setting up
			</h3>
			<ol className="pa-checklist">
				<Row done title="Home computer">
					<div className="sh-field-hint">{status.homeComputer.machine}</div>
				</Row>
				<Row done title="Profile created" />
				<Row done={!waiting} title="Log in">
					<div className="pa-check-text">On {status.homeComputer.machine}, in a terminal, run:</div>
					<CopyLine text={login.command} label="Copy the login command" />
					<div className="sh-field-hint">
						Pick a provider. If you use a local model server instead, put it in the profile's{" "}
						<code>models.yml</code>.
					</div>
					<div aria-live="polite">
						{waiting ? (
							<span className="pa-chip pa-chip-warn">No login yet</span>
						) : (
							<span className="pa-chip pa-chip-ok">
								{login.providers.length > 0 ? `Login found: ${login.providers.join(", ")}` : "Login found"}
							</span>
						)}
					</div>
					{!waiting && (
						<div className="pa-note pa-note-ok" role="status">
							Login found. Personal is starting.
						</div>
					)}
				</Row>
				<Row done={aboutDone} title="About you">
					<div className="pa-actions">
						<button type="button" className="sh-btn" onClick={() => goTo("about")}>
							Write About you
						</button>
					</div>
				</Row>
				<Row done={false} title="Spend limits and backup folder">
					<div className="sh-field-hint">
						Check the limits, and point backups at another disk or a synced folder.
					</div>
					{status.backups.sameDisk && (
						<div className="pa-note pa-note-warn">
							This folder is on the same disk as the memory. Point it at another disk or a synced folder in
							Settings.
						</div>
					)}
					<div className="pa-actions">
						<button type="button" className="sh-btn" onClick={() => goTo("settings")}>
							Open Settings
						</button>
					</div>
				</Row>
			</ol>
		</section>
	);
}
