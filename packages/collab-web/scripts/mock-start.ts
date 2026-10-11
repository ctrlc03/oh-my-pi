/**
 * The `start` request for scripts/mock-companion.ts, so starting sessions can be tried in a browser without tmux or omp.
 * It runs the real folder code: `scratch` makes a real folder through ./companion-scratch under the mock's own config
 * dir (so the naming and the refusal inside a git checkout are the companion's), and `worktree` makes a real git worktree
 * of the folder. Only the session is fake: a host entry that works for a moment, then idles. `folders` lists the folders
 * of the base list plus the scratch folders made so far.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CompanionHost, CompanionReply, CompanionRequest, RecentFolder } from "../src/lib/companion";
import { createScratchFolder } from "./companion-scratch";
import { createWorktree } from "./companion-gitflow";
import { parseStartPrompt } from "./companion-start";

/** How long the fake omp "boots": long enough to see the starting row in the sheet. */
const BOOT_MS = 1_800;
const WORK_MS = 5_000;

export interface MockStart {
	/** Fields the mock companion's `hosts` frame needs for the app to offer these starts. */
	capabilities: { canStart: true; canSandbox: true; canScratch: true; canBackgroundStart: true };
	handles(request: CompanionRequest): boolean;
	answer(request: CompanionRequest): Promise<CompanionReply>;
}

export function createMockStart(options: {
	dir: string;
	/** The mock companion's live session list: started sessions are added to it. */
	hosts: CompanionHost[];
	/** The folders besides the scratch ones. */
	baseFolders(): Promise<RecentFolder[]>;
	onChange(): void;
}): MockStart {
	const configDir = path.join(options.dir, "config");
	const worktrees = path.join(options.dir, "worktrees");
	const scratch: RecentFolder[] = [];
	let started = 0;

	return {
		capabilities: { canStart: true, canSandbox: true, canScratch: true, canBackgroundStart: true },
		handles: request => request.t === "start" || request.t === "folders",
		async answer(request) {
			if (request.t === "folders") {
				const base = await options.baseFolders();
				return { t: "folders", reqId: request.reqId, folders: [...scratch, ...base] };
			}
			if (request.t !== "start") throw new Error(`the mock companion does not answer ${request.t}`);
			const prompt = parseStartPrompt(request.prompt);
			let cwd: string;
			let name: string;
			if (request.scratch) {
				cwd = await createScratchFolder({ configDir, hint: request.scratch.hint });
				name = request.scratch.hint?.trim().split("\n")[0]?.slice(0, 40) || "session";
				scratch.unshift({ cwd, lastActive: Date.now(), sessions: [] });
			} else if (request.worktree) {
				const created = await createWorktree(request.cwd, worktrees, request.worktree.branch);
				cwd = await fs.realpath(created.path);
				name = created.branch;
			} else {
				cwd = await fs.realpath(request.cwd);
				name = path.basename(cwd);
			}
			await Bun.sleep(BOOT_MS);
			const n = ++started;
			const instanceId = `start-${n}-${crypto.randomUUID().slice(0, 6)}`;
			options.hosts.push({
				instanceId,
				sessionId: instanceId,
				sessionName: prompt?.split("\n")[0]?.slice(0, 60) || name,
				cwd,
				model: "anthropic/claude-sonnet-5-5",
				startedAt: Date.now(),
				participants: 1,
				busy: prompt !== undefined,
				inputRequired: false,
				relayConnected: true,
				sandboxed: request.sandboxed === true ? true : undefined,
			});
			if (prompt !== undefined) {
				setTimeout(() => {
					const host = options.hosts.find(h => h.instanceId === instanceId);
					if (host) host.busy = false;
					options.onChange();
				}, WORK_MS);
			}
			options.onChange();
			return { t: "started", reqId: request.reqId, instanceId };
		},
	};
}
