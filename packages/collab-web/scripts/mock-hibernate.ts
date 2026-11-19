/**
 * Session hibernation for scripts/mock-companion.ts: the real organiser (./companion-hibernate) over the mock's session list, so the
 * decisions, the persisted file and the wake-on-open are the real ones, and only what needs omp or tmux is canned.
 *
 * What the app can try, with a fresh state directory:
 * - two hibernated sessions are listed (`nightly-report`, and `data-migration`, which ran sandboxed): opening one shows "resuming…" for a
 *   couple of seconds, then moves it to the live sessions; so does sending a notification reply or starting it from All sessions;
 * - *Hibernate now* in a live session's menu hibernates it, or refuses with the reason: `refactor-auth` is working, `docs-pass` waits for an
 *   answer, `release-notes` has a dev server running in the background, `perf-profiling` has a terminal attached, `i18n-strings` was started
 *   in a terminal, `ci-cache` watches a pull request, the vendor agents' sessions are not hibernated, and the session the `--session-link`
 *   room opens counts as open on a device (`participants` 2). The rest hibernate;
 * - the real idle timer runs too (Settings → Sessions → Hibernation): with 15 minutes picked, a quiet session hibernates 15 minutes after
 *   the mock saw it quiet. Nothing is stopped for real: a "process" is a row in the mock's list.
 *
 * Settings and hibernated sessions are kept in `<--dir>/collab-companion-hibernate.json` by the real reader and writer.
 */

import * as path from "node:path";
import type { HibernatedSession } from "@oh-my-pi/pi-wire/hibernate";
import type { CompanionHost, CompanionReply, CompanionRequest } from "../src/lib/companion";
import {
	createHibernation,
	type HibernateFile,
	type HibernateHost,
	loadHibernateFile,
	requireHibernateSettings,
	saveHibernateFile,
} from "./companion-hibernate";
import { createKeyedLock } from "./companion-start";

const MINUTE = 60_000;
/** How long a resume takes: omp booting and joining its room. */
const RESUME_MS = 2500;

/** Fixture sessions (by instance id) and what the real companion would find out about them. */
const HAS_BACKGROUND = new Set(["inst-8"]);
const TERMINAL_ATTACHED = new Set(["inst-9"]);
const STARTED_IN_TERMINAL = new Set(["inst-10"]);
const WATCHES_PR = new Set(["inst-11"]);

export interface MockHibernate {
	/** Fields of the mock companion's `hosts` frame. */
	hostsFields(): { canHibernate: true; hibernated: HibernatedSession[] };
	handles(request: CompanionRequest): boolean;
	answer(request: CompanionRequest): Promise<CompanionReply>;
	/** Run the idle check (the mock companion calls it on its poll). */
	tick(): Promise<void>;
}

export async function createMockHibernate(options: {
	dir: string;
	/** The mock companion's live session list: a hibernated session leaves it, a resumed one joins it. */
	hosts: CompanionHost[];
	/** The session id of the room `--session-link` opens: it counts as open on a device and is never hibernated. */
	openSessionId: string;
	/** What opening a session shows: the room `--session-link` names; without it a resume works but opening has no room to join. */
	sessionLink: string | undefined;
	/** Session id prefix of this computer (`--machine`), so two mock computers never share a session id. */
	prefix: string;
	samples: boolean;
	onChange(): void;
}): Promise<MockHibernate> {
	const file = path.join(options.dir, "collab-companion-hibernate.json");
	const existed = await Bun.file(file).exists();
	const loaded = await loadHibernateFile(file);
	const now = Date.now();
	const sample = (n: number, name: string, over: Partial<HibernatedSession> = {}): HibernatedSession => ({
		sessionId: `${options.prefix}session-h${n}`,
		instanceId: `inst-h${n}`,
		sessionName: name,
		cwd: `/work/${name}`,
		model: "anthropic/claude-sonnet-5-5",
		startedAt: now - (n + 2) * 60 * MINUTE,
		hibernatedAt: now - 40 * n * MINUTE,
		...over,
	});
	const initial: HibernateFile =
		existed || !options.samples
			? loaded
			: { ...loaded, sessions: [sample(1, "nightly-report"), sample(2, "data-migration", { sandboxed: true })] };
	// The fixture hosts come back on every start, but a session this state directory holds as hibernated stays asleep until opened.
	for (let at = options.hosts.length - 1; at >= 0; at--)
		if (initial.sessions.some(session => session.sessionId === options.hosts[at]?.sessionId)) options.hosts.splice(at, 1);
	let resumed = 0;

	const hibernation = createHibernation({
		now: Date.now,
		initial,
		save: contents => saveHibernateFile(file, contents),
		list: async () => {
			// The mock starts nothing itself, so what the real companion records at launch is recorded as it is first listed.
			for (const host of options.hosts)
				if (!STARTED_IN_TERMINAL.has(host.instanceId))
					hibernation.noteLaunch(host.sessionId, { sandboxed: host.sandboxed === true, restricted: false });
			return {
				hosts: options.hosts.map(
					(host): HibernateHost => ({
						...host,
						participants: host.sessionId === options.openSessionId ? 2 : host.participants,
						// A vendor agent does not report it, which the real decision reads as unknown.
						background: host.agent === undefined ? HAS_BACKGROUND.has(host.instanceId) : null,
					}),
				),
				idle: [],
			};
		},
		facts: async host => ({
			startedHere: !STARTED_IN_TERMINAL.has(host.instanceId),
			personal: host.personal !== undefined,
			watchingPr: WATCHES_PR.has(host.instanceId),
			attached: TERMINAL_ATTACHED.has(host.instanceId),
		}),
		touchedAt: async () => null,
		exists: async () => true,
		folderExists: async () => true,
		stop: async host => {
			const at = options.hosts.findIndex(candidate => candidate.instanceId === host.instanceId);
			if (at !== -1) options.hosts.splice(at, 1);
			return true;
		},
		resume: async session => {
			await Bun.sleep(RESUME_MS);
			const instanceId = `resumed-${++resumed}-${crypto.randomUUID().slice(0, 6)}`;
			options.hosts.push({
				instanceId,
				sessionId: session.sessionId,
				sessionName: session.sessionName,
				cwd: session.cwd,
				model: session.model,
				startedAt: Date.now(),
				participants: 1,
				busy: false,
				inputRequired: false,
				relayConnected: true,
				sandboxed: session.sandboxed,
			});
			return instanceId;
		},
		lock: createKeyedLock(),
		onChange: options.onChange,
		onError: err => console.error(`mock-companion: hibernation: ${err instanceof Error ? err.message : String(err)}`),
	});

	const isHibernatedInstance = (instanceId: string): boolean =>
		hibernation.list().some(session => session.instanceId === instanceId);

	return {
		hostsFields: () => ({ canHibernate: true, hibernated: hibernation.list() }),
		handles: request =>
			request.t === "hibernate-settings" ||
			request.t === "hibernate" ||
			(request.t === "link" && isHibernatedInstance(request.instanceId)) ||
			(request.t === "start" &&
				request.resume !== undefined &&
				hibernation.record(request.resume) !== undefined),
		async answer(request) {
			switch (request.t) {
				case "hibernate-settings":
					if (request.settings !== undefined) await hibernation.setSettings(requireHibernateSettings(request.settings));
					return { t: "hibernate-settings", reqId: request.reqId, settings: hibernation.settings() };
				case "hibernate":
					return { t: "hibernate", reqId: request.reqId, session: await hibernation.hibernate(request.instanceId) };
				case "link": {
					const instanceId = (await hibernation.wake(request.instanceId)) ?? request.instanceId;
					if (options.sessionLink === undefined)
						throw new Error(
							`${instanceId} is running again, but the mock has no room to open: start it with --session-link`,
						);
					return { t: "link", reqId: request.reqId, url: options.sessionLink };
				}
				case "start": {
					const asleep = request.resume === undefined ? undefined : hibernation.record(request.resume);
					const instanceId = asleep === undefined ? null : await hibernation.wake(asleep.instanceId);
					if (instanceId === null) throw new Error("that session is not hibernated");
					return { t: "started", reqId: request.reqId, instanceId };
				}
				default:
					throw new Error(`the mock companion does not answer ${request.t}`);
			}
		},
		tick: () => hibernation.tick(),
	};
}
