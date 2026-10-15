/**
 * The `start` request for scripts/mock-companion.ts, so starting sessions can be tried in a browser without tmux or omp.
 * It runs the real folder code: `scratch` makes a real folder through ./companion-scratch under the mock's own config
 * dir (so the naming and the refusal inside a git checkout are the companion's), and `worktree` makes a real git worktree
 * of the folder. Only the session is fake: a host entry that works for a moment, then idles. `folders` lists the folders
 * of the base list plus the scratch folders made so far. `browse-folders` runs the real browsing code over a throw-away
 * home folder (`<dir>/home`, see {@link seedMockHome}), so "Choose another folder" can be tried; a `start` in a folder
 * that is missing or not a folder is refused the way the companion refuses it.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { browseFolders, checkStartFolder } from "./companion-browse";
import type { CompanionHost, CompanionReply, CompanionRequest, RecentFolder } from "../src/lib/companion";
import { createScratchFolder } from "./companion-scratch";
import { createWorktree } from "./companion-gitflow";
import { parseStartPrompt } from "./companion-start";
import type { MockForeign } from "./mock-foreign";

/**
 * A home folder to browse: a few projects (some git repositories), plain folders, hidden ones, a symlink, a file, and a
 * folder with more subfolders than one listing holds.
 */
async function seedMockHome(home: string): Promise<void> {
	const folders = [
		"code/api-server/.git",
		"code/api-server/src",
		"code/web-app/.git",
		"code/web-app/src",
		"code/notes",
		"code/Archive/2019",
		"Documents/Taxes",
		"Documents/Photos",
		"Downloads",
		"Desktop",
		"empty",
		".config/nvim",
		".cache",
	];
	for (const folder of folders) await fs.mkdir(path.join(home, folder), { recursive: true });
	await fs.mkdir(path.join(home, "big"), { recursive: true });
	for (let n = 1; n <= MOCK_BIG_FOLDER; n++)
		await fs.mkdir(path.join(home, "big", `folder-${String(n).padStart(3, "0")}`));
	await fs.writeFile(path.join(home, "README.txt"), "not a folder\n");
	await fs.symlink(path.join(home, "code"), path.join(home, "projects"));
}

/** Subfolders of the mock home's `big` folder: more than one listing holds (500). */
const MOCK_BIG_FOLDER = 520;

/** How long the fake omp "boots": long enough to see the starting row in the sheet. */
const BOOT_MS = 1_800;
const WORK_MS = 5_000;

export interface MockStart {
	/** Fields the mock companion's `hosts` frame needs for the app to offer these starts. */
	capabilities: {
		canStart: true;
		canSandbox: true;
		canScratch: true;
		canBackgroundStart: true;
		canBrowseFolders: true;
	};
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
	/** Vendor agents: a `start` with an `agent` (or resuming one of their ended sessions) runs one. */
	foreign: Pick<MockForeign, "plan">;
}): MockStart {
	const configDir = path.join(options.dir, "config");
	const worktrees = path.join(options.dir, "worktrees");
	const scratch: RecentFolder[] = [];
	let started = 0;
	const home = path.join(options.dir, "home");
	let seeded: Promise<void> | undefined;
	/** The mock home folder, made on first use. */
	const homeFolder = async (): Promise<string> => {
		seeded ??= seedMockHome(home);
		await seeded;
		return home;
	};

	return {
		capabilities: {
			canStart: true,
			canSandbox: true,
			canScratch: true,
			canBackgroundStart: true,
			canBrowseFolders: true,
		},
		handles: request => request.t === "start" || request.t === "folders" || request.t === "browse-folders",
		async answer(request) {
			if (request.t === "browse-folders") {
				return {
					t: "folder-listing",
					reqId: request.reqId,
					listing: await browseFolders(request, { home: await homeFolder() }),
				};
			}
			if (request.t === "folders") {
				const base = await options.baseFolders();
				return { t: "folders", reqId: request.reqId, folders: [...scratch, ...base] };
			}
			if (request.t !== "start") throw new Error(`the mock companion does not answer ${request.t}`);
			const prompt = parseStartPrompt(request.prompt);
			const foreign = options.foreign.plan(request);
			const open = foreign?.resumed && options.hosts.find(h => h.sessionId === foreign.resumed?.sessionId);
			if (open) return { t: "started", reqId: request.reqId, instanceId: open.instanceId };
			let cwd: string;
			let name: string;
			if (foreign?.resumed) {
				cwd = foreign.resumed.cwd;
				name = foreign.resumed.title;
			} else if (request.scratch) {
				cwd = await createScratchFolder({ configDir, hint: request.scratch.hint });
				name = request.scratch.hint?.trim().split("\n")[0]?.slice(0, 40) || "session";
				scratch.unshift({ cwd, lastActive: Date.now(), sessions: [] });
			} else if (request.worktree) {
				const created = await createWorktree(request.cwd, worktrees, request.worktree.branch);
				cwd = await fs.realpath(created.path);
				name = created.branch;
			} else {
				cwd = await fs.realpath(await checkStartFolder(request.cwd, await homeFolder()));
				name = path.basename(cwd);
			}
			await Bun.sleep(BOOT_MS);
			const n = ++started;
			const instanceId = `start-${n}-${crypto.randomUUID().slice(0, 6)}`;
			options.hosts.push({
				instanceId,
				sessionId: foreign?.resumed?.sessionId ?? instanceId,
				sessionName: prompt?.split("\n")[0]?.slice(0, 60) || name,
				cwd,
				model: foreign ? (foreign.model ?? null) : "anthropic/claude-sonnet-5-5",
				startedAt: Date.now(),
				participants: 1,
				busy: prompt !== undefined,
				inputRequired: false,
				relayConnected: true,
				sandboxed: request.sandboxed === true ? true : undefined,
				agent: foreign?.agent,
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
