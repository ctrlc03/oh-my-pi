import type { PersonalStatus } from "@oh-my-pi/pi-wire/personal";
import { LoaderCircle, Power } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { fmtCost, relTime } from "../../lib/format";
import type { PersonalTab } from "../../lib/personal-ui";
import { REVIEW_SKIPPED, whenLabel } from "../../lib/personal-settings";
import { usePersonal } from "../../lib/use-personal";
import { SpendMeter, useAction } from "./shared";
import "./agent.css";

/** One labelled fact of a card. */
export function Fact({ label, children }: { label: string; children: ReactNode }): ReactNode {
	return (
		<div className="pa-fact">
			<dt className="pa-fact-label">{label}</dt>
			<dd className="pa-fact-value">{children}</dd>
		</div>
	);
}

/** An outcome in words as well as colour. */
function Outcome({ ok }: { ok: boolean | null }): ReactNode {
	if (ok === null) return null;
	return <span className={`pa-chip ${ok ? "pa-chip-ok" : "pa-chip-err"}`}>{ok ? "Succeeded" : "Failed"}</span>;
}

export function SpendCard({ status }: { status: PersonalStatus }): ReactNode {
	return (
		<section className="pa-card" aria-labelledby="pa-spend-title">
			<h3 id="pa-spend-title" className="pa-card-title">
				Spend
			</h3>
			<SpendMeter title="Today" window={status.spend.day} />
			<SpendMeter title="This month" window={status.spend.month} />
			<div className="sh-field-hint">
				Counted across every session of the Personal profile. A running session keeps the limits it started with
				until the next rollover.
			</div>
		</section>
	);
}

export function BackupsCard({ status, goTo }: { status: PersonalStatus; goTo(tab: PersonalTab): void }): ReactNode {
	const { backups } = status;
	return (
		<section className="pa-card" aria-labelledby="pa-backups-title">
			<h3 id="pa-backups-title" className="pa-card-title">
				Backups
			</h3>
			<dl className="pa-facts">
				<Fact label="Last backup">
					{backups.lastAt === null ? (
						"None yet"
					) : (
						<>
							{relTime(backups.lastAt)} <Outcome ok={backups.lastOk} />
						</>
					)}
				</Fact>
				<Fact label="Next backup">{backups.nextAt === null ? "Not scheduled" : whenLabel(backups.nextAt)}</Fact>
				<Fact label="Kept">
					{backups.dailyKept} daily and {backups.monthlyKept} monthly
				</Fact>
				<Fact label="Folder">
					<code className="pa-path">{backups.folder}</code>
				</Fact>
			</dl>
			{backups.lastError !== undefined && <div className="pa-note pa-note-err">{backups.lastError}</div>}
			{backups.sameDisk && (
				<div className="pa-note pa-note-warn">
					<p className="pa-note-text">
						This folder is on the same disk as the memory. Point it at another disk or a synced folder in
						Settings.
					</p>
					<button type="button" className="sh-btn" onClick={() => goTo("settings")}>
						Open Settings
					</button>
				</div>
			)}
		</section>
	);
}

export function ReviewCard({ status }: { status: PersonalStatus }): ReactNode {
	const { review } = status;
	return (
		<section className="pa-card" aria-labelledby="pa-review-title">
			<h3 id="pa-review-title" className="pa-card-title">
				Nightly review
			</h3>
			<dl className="pa-facts">
				<Fact label="Last review">
					{review.lastAt === null ? (
						"None yet"
					) : (
						<>
							{relTime(review.lastAt)} <Outcome ok={review.ok} />
							{review.costUsd !== null && <> · {fmtCost(review.costUsd)}</>}
							{review.ok === true && (
								<> · {review.proposals === 1 ? "1 proposal made" : `${review.proposals} proposals made`}</>
							)}
						</>
					)}
				</Fact>
				<Fact label="Next review">{review.nextAt === null ? "Not scheduled" : whenLabel(review.nextAt)}</Fact>
			</dl>
			{review.error !== undefined && <div className="pa-note pa-note-err">{review.error}</div>}
			{review.skipped !== undefined && <div className="sh-field-hint">{REVIEW_SKIPPED[review.skipped]}</div>}
		</section>
	);
}

/** Turn Personal off (after saying what that does) or, when it is off, back on. */
export function PowerCard({ status }: { status: PersonalStatus }): ReactNode {
	const personal = usePersonal();
	const [confirming, setConfirming] = useState(false);
	const action = useAction();
	const homeId = status.homeComputer.computerId;

	const switchTo = (type: "personal-enable" | "personal-disable"): void => {
		void action
			.run(async () => {
				const reply = await personal.call({ t: type });
				personal.adopt(homeId, reply.status);
			})
			.then(ok => {
				if (ok) setConfirming(false);
			});
	};

	if (!status.enabled) {
		return (
			<section className="pa-card pa-card-lead" aria-labelledby="pa-power-title">
				<h3 id="pa-power-title" className="pa-card-title">
					Personal is off
				</h3>
				<p className="pa-note-text">
					Nothing runs: no session, events, sources, review or backups. All memory, history and settings are kept.
					Turn it on to pick up where it left off.
				</p>
				{action.error !== null && <div className="sh-connect-error">{action.error}</div>}
				<div className="pa-actions">
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						disabled={action.busy}
						onClick={() => switchTo("personal-enable")}
					>
						{action.busy ? <LoaderCircle size={14} className="sh-spin" /> : <Power size={14} />} Turn on
					</button>
				</div>
			</section>
		);
	}

	return (
		<section className="pa-card" aria-labelledby="pa-power-title">
			<h3 id="pa-power-title" className="pa-card-title">
				Power
			</h3>
			{confirming ? (
				<div className="pa-confirm" role="group" aria-label="Confirm turning Personal off">
					<p className="pa-note-text">
						Turning Personal off stops the agent and its background jobs (events, sources, review, backups). All
						memory, history and settings are kept, and turning it on again picks up where it left off. Nothing is
						deleted.
					</p>
					{action.error !== null && <div className="sh-connect-error">{action.error}</div>}
					<div className="pa-actions">
						<button
							type="button"
							className="sh-btn sh-btn-stop"
							disabled={action.busy}
							onClick={() => switchTo("personal-disable")}
						>
							{action.busy && <LoaderCircle size={14} className="sh-spin" />} Confirm
						</button>
						<button
							type="button"
							className="sh-btn"
							disabled={action.busy}
							onClick={() => {
								setConfirming(false);
								action.clear();
							}}
						>
							Cancel
						</button>
					</div>
				</div>
			) : (
				<div className="pa-actions">
					<button type="button" className="sh-btn" onClick={() => setConfirming(true)}>
						<Power size={14} /> Turn off
					</button>
					<span className="sh-field-hint">Keeps all memory.</span>
				</div>
			)}
		</section>
	);
}
