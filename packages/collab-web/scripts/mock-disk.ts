/**
 * The mock companion's disk guard: a computer short on space (6.3 GB free of 500 GB) with five worktrees holding
 * build output — two the guard may clean, one a cargo build runs in, one used an hour ago, one whose size could not be
 * measured in time — and a short history of cleans. The settings are kept in a real file by the real parser; *Clean now* removes
 * what was picked from the canned list and gives its size back as free space, so the warning clears once enough went.
 * Nothing touches a real disk. See ./companion-disk for the real thing.
 */

import * as path from "node:path";
import {
	DISK_GB,
	type DiskArtifactKind,
	type DiskCandidate,
	type DiskClean,
	type DiskHealth,
	type DiskReply,
	type DiskRequest,
	type DiskState,
	diskMarginBytes,
} from "@oh-my-pi/pi-wire/disk";
import type { CompanionRequest } from "../src/lib/companion";
import { limitBytes, parseDiskSettings } from "./companion-disk-plan";
import { type DiskFile, loadDiskFile, saveDiskFile } from "./companion-disk";

const HOUR_MS = 3_600_000;
const ROUND_BYTES = 100_000_000;
const TOTAL_BYTES = 500 * DISK_GB;
const START_FREE_BYTES = 6.3 * DISK_GB;
const SCAN_DELAY_MS = 700;
const CLEAN_DELAY_MS = 900;

interface MockTree {
	candidate: Omit<DiskCandidate, "idleMs">;
	/** When it was last used. */
	usedAt: number;
}

export interface MockDisk {
	/** Fields of the mock companion's `hosts` frame: the capability, and the warning while a volume is low. */
	hostsFields(): { canDiskGuard: true; disk?: DiskHealth };
	handles(request: CompanionRequest): request is DiskRequest;
	answer(request: DiskRequest): Promise<DiskReply>;
}

export async function createMockDisk(options: {
	dir: string;
	onChange(): void;
	now?: () => number;
}): Promise<MockDisk> {
	const now = options.now ?? Date.now;
	const file = path.join(options.dir, "collab-companion-disk.json");
	let saved: DiskFile = await loadDiskFile(file);
	const home = "/Users/mock";
	const trees = new Map<string, MockTree>();
	const add = (
		repo: string,
		name: string,
		artifacts: { kind: DiskArtifactKind; gb: number | null }[],
		usedHoursAgo: number,
		skip: DiskCandidate["skip"] = null,
		why: string | null = null,
	): void => {
		const tree = `${home}/.omp/worktrees/${repo}/${name}`;
		const list = artifacts.map(artifact => ({
			path: `${tree}/${artifact.kind}`,
			kind: artifact.kind,
			bytes: artifact.gb === null ? null : Math.round(artifact.gb * DISK_GB),
		}));
		trees.set(tree, {
			usedAt: now() - usedHoursAgo * HOUR_MS,
			candidate: {
				path: tree,
				repo,
				name,
				artifacts: list,
				bytes: list.reduce((sum, artifact) => sum + (artifact.bytes ?? 0), 0),
				sized: list.every(artifact => artifact.bytes !== null),
				skip,
				why,
			},
		});
	};
	add("interfold", "refactor-ciphernode-builder", [{ kind: "target", gb: 18.4 }], 49);
	add(
		"web-app",
		"migrate-router",
		[
			{ kind: "node_modules", gb: 7.6 },
			{ kind: ".next", gb: 1.6 },
		],
		122,
	);
	add("interfold", "bench-prover", [{ kind: "target", gb: 22 }], 3, "busy", "cargo (pid 41207) runs in it");
	add("api-service", "fix-pagination", [{ kind: "target", gb: 8 }], 1.3, "recent", "used within the last 6 h");
	add("tools", "wasm-spike", [{ kind: "target", gb: null }], 31);

	let free = START_FREE_BYTES;
	let cleans: DiskClean[] = [
		{
			path: `${home}/.omp/worktrees/api-service/older-experiment`,
			repo: "api-service",
			name: "older-experiment",
			kinds: ["target", "node_modules"],
			bytes: Math.round(31.2 * DISK_GB),
			trigger: "auto",
			freeBeforeBytes: Math.round(9.8 * DISK_GB),
			limitBytes: 40 * DISK_GB,
			at: now() - 26 * HOUR_MS,
		},
		{
			path: `${home}/.omp/worktrees/web-app/old-landing`,
			repo: "web-app",
			name: "old-landing",
			kinds: ["node_modules", ".next"],
			bytes: Math.round(4.1 * DISK_GB),
			trigger: "manual",
			freeBeforeBytes: Math.round(12.4 * DISK_GB),
			limitBytes: 40 * DISK_GB,
			at: now() - 50 * HOUR_MS,
			error: "node_modules: rm failed (1)",
		},
	];
	const idleOf = (tree: MockTree): number => Math.max(0, now() - tree.usedAt);

	/** Recent and busy ones are skipped by the guard; the idle window of the settings decides what counts as recent. */
	const candidates = (): DiskCandidate[] =>
		[...trees.values()].map(tree => ({
			...tree.candidate,
			idleMs: idleOf(tree),
			skip:
				tree.candidate.skip === "busy"
					? "busy"
					: idleOf(tree) < saved.settings.idleHours * HOUR_MS
						? "recent"
						: null,
			why:
				tree.candidate.skip === "busy"
					? tree.candidate.why
					: idleOf(tree) < saved.settings.idleHours * HOUR_MS
						? `used within the last ${saved.settings.idleHours} h`
						: null,
		}));

	const volumes = (): DiskState["volumes"] => [
		{
			path: `${home}/.omp/worktrees`,
			holds: "worktrees-and-home",
			freeBytes: Math.round(free),
			totalBytes: TOTAL_BYTES,
			low: free < limitBytes(saved.settings),
		},
	];
	const state = (): DiskState => ({
		settings: saved.settings,
		volumes: volumes(),
		limitBytes: limitBytes(saved.settings),
		marginBytes: diskMarginBytes(limitBytes(saved.settings)),
		cleans,
		checkedAt: now(),
	});

	return {
		hostsFields() {
			const low = free < limitBytes(saved.settings);
			return {
				canDiskGuard: true,
				...(low
					? {
							disk: {
								path: `${home}/.omp/worktrees`,
								freeBytes: Math.floor(free / ROUND_BYTES) * ROUND_BYTES,
								limitBytes: limitBytes(saved.settings),
							},
						}
					: {}),
			};
		},
		handles: (request): request is DiskRequest =>
			request.t === "disk-guard" || request.t === "disk-scan" || request.t === "disk-clean",
		async answer(request) {
			if (request.t === "disk-guard") {
				if (request.settings !== undefined) {
					saved = { ...saved, settings: parseDiskSettings(request.settings, true) };
					await saveDiskFile(file, saved);
					options.onChange();
				}
				return { t: "disk-guard", reqId: request.reqId, ...state() };
			}
			if (request.t === "disk-scan") {
				await Bun.sleep(SCAN_DELAY_MS);
				const listed = candidates().sort((a, b) => b.bytes - a.bytes);
				return { t: "disk-scan", reqId: request.reqId, candidates: listed, volumes: volumes(), scannedAt: now() };
			}
			await Bun.sleep(CLEAN_DELAY_MS);
			const done: DiskClean[] = [];
			const refused: { path: string; reason: string }[] = [];
			for (const picked of request.paths) {
				const tree = trees.get(picked);
				const current = candidates().find(candidate => candidate.path === picked);
				if (tree === undefined || current === undefined)
					refused.push({ path: picked, reason: "not a worktree the companion made" });
				else if (current.skip === "busy") refused.push({ path: picked, reason: current.why ?? "busy" });
				else {
					const entry: DiskClean = {
						path: picked,
						repo: tree.candidate.repo,
						name: tree.candidate.name,
						kinds: tree.candidate.artifacts.map(artifact => artifact.kind),
						bytes: tree.candidate.bytes || Math.round(14.5 * DISK_GB),
						trigger: "manual",
						freeBeforeBytes: Math.round(free),
						limitBytes: limitBytes(saved.settings),
						at: now(),
					};
					free += entry.bytes;
					trees.delete(picked);
					cleans = [entry, ...cleans].slice(0, 100);
					done.push(entry);
				}
			}
			options.onChange();
			return { t: "disk-clean", reqId: request.reqId, cleans: done, refused, volumes: volumes() };
		},
	};
}
