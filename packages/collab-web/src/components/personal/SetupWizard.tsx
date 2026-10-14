import { PERSONAL_DEFAULTS } from "@oh-my-pi/pi-wire/personal";
import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useId, useState } from "react";
import { fmtTokens } from "../../lib/format";
import { setupBlockedReason } from "../../lib/personal";
import { estimateTokens } from "../../lib/personal-settings";
import { usePersonal } from "../../lib/use-personal";
import { useAction } from "./shared";
import "./agent.css";

const ABOUT_PLACEHOLDER = "## Who I am\n\n## How I like to work\n\n## Hard rules";

/** Settings → Personal agent while there is no home computer: pick where it lives, optionally write About you, set up. */
export function SetupWizard(): ReactNode {
	const personal = usePersonal();
	const { hostable, home } = personal;
	const [chosen, setChosen] = useState<string | null>(null);
	const [about, setAbout] = useState("");
	const setup = useAction();
	const groupId = useId();
	const aboutId = useId();
	const computer = hostable.find(item => item.id === chosen) ?? (hostable.length === 1 ? hostable[0]! : null);
	const blocked = computer === null ? null : setupBlockedReason(home, computer);
	const tokens = estimateTokens(about);
	const tooLong = tokens > PERSONAL_DEFAULTS.aboutMaxTokens;

	const submit = (): void => {
		if (computer === null || blocked !== null) return;
		void setup.run(async () => {
			const reply = await personal.callOn(computer.id, {
				t: "personal-setup",
				about: about.trim() === "" ? undefined : about,
			});
			personal.adopt(computer.id, reply.status);
		});
	};

	return (
		<div className="pa-screen pa-wizard">
			<div className="pa-wizard-intro">
				<h2 className="pa-wizard-title">Set up Personal</h2>
				<p>
					Personal is one agent for one person. It remembers what you tell it and what it learns, and it never
					deletes a memory. It lives on one home computer, which holds the memory and keeps it running; your other
					devices reach it through this app.
				</p>
			</div>

			<section className="pa-card" aria-labelledby={groupId}>
				<h3 id={groupId} className="pa-card-title">
					1. Choose the home computer
				</h3>
				{hostable.length === 0 ? (
					<div className="pa-note" role="status">
						None of your computers can host Personal yet. Update omp on the computer you want to use (it must be
						paired and online).
					</div>
				) : (
					<div className="pa-computers" role="radiogroup" aria-labelledby={groupId}>
						{hostable.map(item => (
							<label key={item.id} className={`pa-computer${item.id === computer?.id ? " pa-computer-on" : ""}`}>
								<input
									type="radio"
									name={groupId}
									checked={item.id === computer?.id}
									onChange={() => setChosen(item.id)}
								/>
								<span className="pa-computer-text">
									<span className="pa-computer-name">{item.name}</span>
									{item.snap.machine !== null && item.snap.machine !== item.name && (
										<span className="sh-field-hint">{item.snap.machine}</span>
									)}
								</span>
							</label>
						))}
					</div>
				)}
			</section>

			<section className="pa-card">
				<h3 className="pa-card-title">2. About you (optional)</h3>
				<div className="sh-field">
					<label className="sh-field-label" htmlFor={aboutId}>
						A first draft
					</label>
					<textarea
						id={aboutId}
						className="sh-input pa-textarea"
						rows={7}
						value={about}
						placeholder={ABOUT_PLACEHOLDER}
						onChange={event => setAbout(event.currentTarget.value)}
						spellCheck
					/>
					<div className="pa-counter" role="status">
						<span className={tooLong ? "pa-counter-over" : undefined}>
							{fmtTokens(tokens)} of about {fmtTokens(PERSONAL_DEFAULTS.aboutMaxTokens)} tokens
						</span>
						{tooLong && <span> · It is loaded into every session, so shorter is better.</span>}
					</div>
					<div className="sh-field-hint">
						Who you are, how you like to work, and any hard rules. You can change it later; the agent can only
						propose changes, and nothing changes until you accept.
					</div>
				</div>
			</section>

			<section className="pa-card">
				<h3 className="pa-card-title">3. Set up</h3>
				<ul className="pa-list">
					<li>
						Creates a separate profile called <code>personal</code> on {computer?.name ?? "the home computer"}{" "}
						with its own config, sessions, memory and About-you file.
					</li>
					<li>Nothing runs until you log in.</li>
					<li>Turning it off later keeps all memory.</li>
				</ul>
				{blocked !== null && <div className="pa-note pa-note-warn">{blocked}</div>}
				{setup.error !== null && (
					<div className="sh-connect-error" role="alert">
						{setup.error}
					</div>
				)}
				<div className="pa-actions">
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						disabled={computer === null || blocked !== null || setup.busy}
						onClick={submit}
					>
						{setup.busy && <LoaderCircle size={14} className="sh-spin" />} Set up Personal
					</button>
				</div>
			</section>
		</div>
	);
}
