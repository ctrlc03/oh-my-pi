/**
 * Session-replacing slash commands a collab writer may run: `/new`, `/resume`
 * and `/fork`. They run the host's own handlers (the ones its terminal calls), so
 * the effect is what typing the command on the host would have.
 *
 * The session changing identity ends the room that carried the command: the
 * controller retires it (guests get a goodbye) and, under `collab.autoStart:
 * control`, opens a successor for the new session. A guest keeps up only by
 * rejoining that successor, which the web app does through its paired computer.
 * Without auto-start no successor ever opens and the guest would simply be cut
 * off, so every command here is refused unless the host reopens a control room.
 *
 * Only the folder's own sessions are resumable: a guest cannot move the host
 * into another project, and the host's selectors are never opened for it.
 */
import type { CollabCommandChoice } from "@oh-my-pi/pi-wire";
import { logger } from "@oh-my-pi/pi-utils";
import type { InteractiveModeContext } from "../modes/types";
import { resolveResumableSession, sessionDisplayName } from "../session/session-listing";
import { SessionManager } from "../session/session-manager";

export type GuestSessionResult = { ok: true } | { ok: false; reason: string };

/** Sessions suggested for `/resume`; the picker on a phone is a short list, not the whole history. */
const MAX_RESUME_CHOICES = 20;
const MAX_CHOICE_LABEL_CHARS = 80;

const REFUSE_BUSY = "wait for the current response or command to finish (stop it first if needed)";

/** Whether this host reopens a control room after a session switch, so a guest can follow it. */
export function hostKeepsGuestsAcrossSwitch(ctx: InteractiveModeContext): boolean {
	return ctx.collabController.autoStartMode === "control";
}

/** Why a guest may not replace the session now, or undefined when it may. */
export function sessionSwitchRefusal(ctx: InteractiveModeContext): string | undefined {
	if (!hostKeepsGuestsAcrossSwitch(ctx)) {
		return 'the host does not reopen a control room after a session switch (collab.autoStart is not "control"), so you would be disconnected; run it on the host';
	}
	const { session } = ctx;
	if (session.isBusyForSnapshot || session.isSessionTransitioning) return REFUSE_BUSY;
	if (ctx.planModeEnabled || ctx.planModePaused || ctx.goalModeEnabled || ctx.goalModePaused || ctx.vibeModeEnabled) {
		return "exit plan, goal and vibe mode on the host first";
	}
	return undefined;
}

/** `Y-M-D H:M UTC`, to the minute: suggestions are read once, so a clock beats a relative age that goes stale. */
function formatModified(date: Date): string {
	const time = date.getTime();
	if (!Number.isFinite(time)) return "";
	return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Recent sessions of the host's current folder, newest (pinned first) as the
 * host's `/resume` picker orders them, minus the live one and sessions nothing
 * was ever said in. Empty, and never throwing, when the host would not follow a
 * switch or the listing fails: that just means no suggestions.
 */
export async function recentSessionChoices(ctx: InteractiveModeContext): Promise<CollabCommandChoice[]> {
	try {
		if (!hostKeepsGuestsAcrossSwitch(ctx)) return [];
		const manager = ctx.sessionManager;
		const currentId = manager.getSessionId();
		const sessions = await SessionManager.list(manager.getCwd(), manager.getSessionDir());
		const choices: CollabCommandChoice[] = [];
		for (const info of sessions) {
			if (choices.length >= MAX_RESUME_CHOICES) break;
			if (info.id === currentId || (info.messageCount === 0 && !info.title)) continue;
			const label = sessionDisplayName(info);
			const when = formatModified(info.modified);
			const count = `${info.messageCount} ${info.messageCount === 1 ? "message" : "messages"}`;
			choices.push({
				value: info.id,
				label: label.length > MAX_CHOICE_LABEL_CHARS ? `${label.slice(0, MAX_CHOICE_LABEL_CHARS - 1)}…` : label,
				description: when ? `${count} · ${when}` : count,
			});
		}
		return choices;
	} catch (err) {
		logger.debug("collab could not list recent sessions", { error: String(err) });
		return [];
	}
}

/** The switch handlers return nothing and report a refusal on the host terminal: judge them by the session left behind. */
function settled(ctx: InteractiveModeContext, idBefore: string, what: string): GuestSessionResult {
	return ctx.sessionManager.getSessionId() === idBefore
		? { ok: false, reason: `${what} did not happen; see the host terminal` }
		: { ok: true };
}

/** `/new`: the host's new-session flow. */
export async function startNewSessionForGuest(ctx: InteractiveModeContext): Promise<GuestSessionResult> {
	const refusal = sessionSwitchRefusal(ctx);
	if (refusal) return { ok: false, reason: refusal };
	const before = ctx.sessionManager.getSessionId();
	await ctx.handleClearCommand();
	return settled(ctx, before, "starting a new session");
}

/** `/fork`: the host's whole-session fork (never the pane/window variants, which spawn terminals). */
export async function forkSessionForGuest(ctx: InteractiveModeContext): Promise<GuestSessionResult> {
	const refusal = sessionSwitchRefusal(ctx);
	if (refusal) return { ok: false, reason: refusal };
	if (!ctx.sessionManager.isSessionOnDisk()) {
		return { ok: false, reason: "this session has not been saved yet, so there is nothing to fork" };
	}
	const before = ctx.sessionManager.getSessionId();
	await ctx.handleForkCommand();
	return settled(ctx, before, "the fork");
}

/** `/resume <session>`: a session of this folder named by id, an id prefix or its file name. */
export async function resumeSessionForGuest(ctx: InteractiveModeContext, session: string): Promise<GuestSessionResult> {
	const refusal = sessionSwitchRefusal(ctx);
	if (refusal) return { ok: false, reason: refusal };
	const manager = ctx.sessionManager;
	// No global fallback: the host's folder is the boundary of what a guest can reach.
	const match = await resolveResumableSession(session, manager.getCwd(), manager.getSessionDir());
	if (!match) return { ok: false, reason: `no session matching "${session}" in this folder` };
	if (match.session.id === manager.getSessionId()) return { ok: false, reason: "that is the current session" };
	// The wait for a hook or the resolver may have let the host start something.
	const late = sessionSwitchRefusal(ctx);
	if (late) return { ok: false, reason: late };
	try {
		await ctx.handleResumeSession(match.session.path);
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err) };
	}
	return manager.getSessionId() === match.session.id
		? { ok: true }
		: { ok: false, reason: "the host could not resume that session; see the host terminal" };
}

/** The session-replacing builtin `name` (`new`, `fork` or `resume`), with what followed it. */
export function replaceSessionForGuest(
	ctx: InteractiveModeContext,
	name: string,
	args: string,
): Promise<GuestSessionResult> {
	switch (name) {
		case "new":
			return startNewSessionForGuest(ctx);
		case "fork":
			return forkSessionForGuest(ctx);
		case "resume":
			return resumeSessionForGuest(ctx, args);
		default:
			return Promise.resolve({ ok: false, reason: "not a session command" });
	}
}
