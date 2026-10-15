import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BAKEOFF_MAX_PATCH_BYTES, type Bakeoff, type BakeoffCreate } from "@oh-my-pi/pi-wire/bakeoff";
import type { FanoutGroup } from "../src/lib/fanout";
import { type Bakeoffs, createBakeoffs } from "../scripts/companion-bakeoff";
import type { BakeoffFanout } from "../scripts/companion-bakeoff-run";
import { fanoutBranch, parseFanoutRequest, startFanout } from "../scripts/companion-fanout";

let tmp: string;
let repo: string;
let notes: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
	return out.trim();
}

const STORE_BEFORE = "export class Store {\n\tget(key: string): string | undefined {\n\t\treturn undefined;\n\t}\n}\n";
const STORE_AFTER = `${STORE_BEFORE}\nexport class Writable extends Store {}\n`;
/** Not valid UTF-8 and not text: git calls it binary. */
const LOGO = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01, 0x02, 0x00, 0x80, 0x81]);
const PLAN = "# Plan for the cache\n\nResults are kept for an hour.\n\nA restart empties it.\n";

beforeAll(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bakeoff-export-")));
	repo = path.join(tmp, "demo");
	await fs.mkdir(path.join(repo, "src"), { recursive: true });
	await git(repo, "init", "-q", "-b", "main");
	await fs.writeFile(path.join(repo, "src/store.ts"), STORE_BEFORE);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-q", "-m", "init");
	await git(repo, "checkout", "-q", "-b", "feature/writable");
	await fs.writeFile(path.join(repo, "src/store.ts"), STORE_AFTER);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-q", "-m", "Make the store writable");

	notes = path.join(tmp, "notes");
	await fs.mkdir(path.join(notes, "src"), { recursive: true });
	await fs.writeFile(path.join(notes, "plan.md"), PLAN);
	await fs.writeFile(path.join(notes, "src/cache.ts"), "export const cache = new Map<string, string>();\n");
	await fs.writeFile(path.join(notes, "logo.png"), LOGO);
});

afterAll(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

const METRICS: BakeoffCreate["metrics"] = [{ id: "simplicity", label: "Simplicity", weight: 3 }];
const MODELS = ["anthropic/claude-a", "openai/gpt-b"];

function writeup(summary: string, refs: string[]): string {
	return JSON.stringify({
		summary,
		approach: "Keep results in a map.",
		tradeoffs: ["memory"],
		risks: ["stale answers"],
		migration: "None.",
		metrics: { simplicity: "one map" },
		refs,
	});
}

function review(labels: string[], file: string): string {
	const sorted = [...labels].sort();
	return JSON.stringify({
		ranking: sorted,
		entries: Object.fromEntries(
			sorted.map((label, index) => [
				label,
				{
					scores: { simplicity: 5 - index },
					strengths: [{ text: "It is small.", refs: [`${label}/${file}@1@Plan`] }],
					weaknesses: [],
				},
			]),
		),
		verdict: `Entry ${sorted[0]} is simplest: \`${sorted[0]}/${file}@1@Plan\` shows why.`,
		unsure: [],
	});
}

interface Seen {
	cwd: string;
	files: string[];
	prompt: string;
}

async function listing(dir: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (folder: string): Promise<void> => {
		for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
			const full = path.join(folder, entry.name);
			out.push(path.relative(dir, full));
			if (entry.isDirectory()) await walk(full);
		}
	};
	await walk(dir).catch(() => undefined);
	return out;
}

/** An agent that answers as the stub of the main bake-off tests does: one file per session, its `refs` into `file`. */
function stubAgent(
	file: string,
	seen: Seen[],
	hosts: Map<string, string>,
): NonNullable<Parameters<typeof createBakeoffs>[0]["agent"]> {
	let next = 0;
	return {
		start: async launch => {
			seen.push({ cwd: launch.cwd, files: await listing(launch.cwd), prompt: launch.prompt });
			const id = `agent-${next++}`;
			hosts.set(id, launch.model ?? "");
			const prompt = launch.prompt;
			const text =
				prompt.includes("You are writing a better design") || prompt.includes("neutral summary")
					? writeup("The results go in a map.", [`${file}@1@Plan`])
					: review(/entries \(([A-E, ]+)\)/.exec(prompt)![1]!.split(", "), file);
			await fs.writeFile(launch.outFile, text);
			return id;
		},
		hosts: async () =>
			[...hosts.entries()].map(([instanceId, model]) => ({
				instanceId,
				sessionId: `s-${instanceId}`,
				model: model || null,
				busy: false,
			})),
		stop: async instanceId => {
			hosts.delete(instanceId);
		},
		cost: async () => 0.02,
	};
}

const WATCH = { pollMs: 5, settleMs: 20, idleMs: 200, goneMs: 30, timeoutMs: 5_000 };

function engine(
	name: string,
	extra: Partial<Parameters<typeof createBakeoffs>[0]> & { file?: string; seen?: Seen[] } = {},
): Bakeoffs {
	const { file = "plan.md", seen = [], ...deps } = extra;
	return createBakeoffs({
		storeDir: path.join(tmp, name, "agent", "bakeoffs"),
		cacheDir: path.join(tmp, name, "cache", "bakeoffs"),
		sessionsDir: path.join(tmp, "sessions"),
		now: () => Date.now(),
		changed: () => undefined,
		agent: stubAgent(file, seen, new Map()),
		fanout: null,
		watch: WATCH,
		...deps,
	});
}

describe("a bake-off of a folder that is not a git repository", () => {
	const design = (extra: Partial<BakeoffCreate> = {}): BakeoffCreate => ({
		cwd: notes,
		mode: "design",
		doc: { path: "plan.md" },
		metrics: METRICS,
		models: MODELS,
		reviewer: "google/gemini-r",
		maxCostUsd: 3,
		...extra,
	});

	it("lists nothing, and no error, for a folder that has none", async () => {
		const bakeoffs = engine("folder-empty");
		expect(await bakeoffs.list(notes)).toEqual([]);
		expect(await bakeoffs.list(repo)).toEqual([]);
		expect(await bakeoffs.folder(notes)).toEqual({ git: false, files: 2, name: "notes" });
		expect(await bakeoffs.folder(repo)).toMatchObject({ git: true, name: "demo" });
	});

	it("runs a design bake-off end to end: entries read a copy of the files, citations are checked, cited files are stored", async () => {
		const seen: Seen[] = [];
		const bakeoffs = engine("folder-run", { seen });
		const { id } = await bakeoffs.create(design());
		await bakeoffs.idle();
		const bakeoff = await bakeoffs.get(id);

		expect(bakeoff).toMatchObject({ folder: true, mode: "design", stage: "done" });
		expect(bakeoff.repo.root).toBe(notes);
		expect(bakeoff.entries).toHaveLength(3);
		for (const entry of bakeoff.entries) expect(entry).toMatchObject({ status: "ready" });
		expect(bakeoff.entries.every(entry => entry.patch === undefined)).toBe(true);
		expect(bakeoff.result!.ranking.map(row => row.rank)).toEqual([1, 2, 3]);
		expect(bakeoff.result!.findings.some(finding => finding.verified)).toBe(true);
		for (const entry of bakeoff.entries) expect(entry.writeup!.refs.map(ref => ref.path)).toEqual(["plan.md"]);

		// Listed under the folder's real path, and under no other.
		expect((await bakeoffs.list(notes)).map(item => item.id)).toEqual([id]);
		expect(await bakeoffs.list(repo)).toEqual([]);

		// What the sessions read is a copy of the text files: no `.git`, no binary file, nothing of the folder itself.
		for (const read of seen) {
			expect(read.cwd.startsWith(notes)).toBe(false);
			expect(read.files.some(file => file.split("/").includes(".git"))).toBe(false);
		}
		const designer = seen.find(read => read.prompt.includes("You are writing a better design"))!;
		expect(designer.files).toEqual(expect.arrayContaining(["plan.md", "src", "src/cache.ts"]));
		expect(designer.files).not.toContain("logo.png");
		const reviewer = seen.find(read => read.prompt.includes("reviewer of a design bake-off"))!;
		expect(reviewer.files).toContain("code/plan.md");

		// The cited file is stored with the bake-off: an excerpt still reads after the folder is gone.
		const [hit, missing] = await (async () => {
			await fs.rename(notes, `${notes}-away`);
			try {
				return await bakeoffs.excerpt(id, "A", [
					{ path: "plan.md", line: 1, token: "Plan" },
					{ path: "src/cache.ts", line: 1, token: "cache" },
				]);
			} finally {
				await fs.rename(`${notes}-away`, notes);
			}
		})();
		expect(hit!.lines[hit!.line - hit!.start]).toContain("Plan for the cache");
		expect(hit!.commit).toBe("folder");
		// A file nothing cited is not kept.
		expect(missing).toBeNull();

		// Take is a design's: it marks the entry.
		await bakeoffs.take({ id, entry: "B" });
		expect((await bakeoffs.get(id)).result!.taken).toBe("B");
		await bakeoffs.remove(id);
		expect(await bakeoffs.list(notes)).toEqual([]);
	});

	it("reads the design document from a file of the folder, and refuses one that is not there", async () => {
		const bakeoffs = engine("folder-doc");
		const { id } = await bakeoffs.create(design({ doc: { path: "plan.md" }, goal: undefined }));
		await bakeoffs.idle();
		expect((await bakeoffs.get(id)).stage).toBe("done");
		const missing = await bakeoffs.create(design({ doc: { path: "nope.md" } }));
		await bakeoffs.idle();
		const [failed] = (await bakeoffs.list(notes)).filter(item => item.id === missing.id);
		expect(failed).toMatchObject({ status: "failed" });
		expect(failed!.error).toContain("There is no text file nope.md in the folder.");
	});

	it("refuses an implementation bake-off, a branch, a pull request and a missing design document, in plain words", async () => {
		const bakeoffs = engine("folder-refuse");
		await expect(bakeoffs.create(design({ mode: "implementation" }))).rejects.toThrow(
			"A folder that is not a git repository has no changes, branches, pull requests or worktrees",
		);
		await expect(bakeoffs.create(design({ ref: "main" }))).rejects.toThrow("not a git repository");
		await expect(bakeoffs.create(design({ pr: 3 }))).rejects.toThrow("not a git repository");
		await expect(bakeoffs.create(design({ doc: undefined }))).rejects.toThrow("Add a design document");
		await expect(bakeoffs.create(design({ doc: { path: "/etc/passwd" } }))).rejects.toThrow(
			"must be a text file inside the folder",
		);
		expect(await bakeoffs.list(notes)).toEqual([]);
	});
});

describe("an implementation entry's patch", () => {
	let bakeoffs: Bakeoffs;
	let bakeoff: Bakeoff;
	let id: string;
	let base: string;
	let groupRef: FanoutGroup | undefined;

	beforeAll(async () => {
		const trees = path.join(tmp, "patch-trees");
		const fanout: BakeoffFanout = {
			start: async input => {
				groupRef = await startFanout(
					parseFanoutRequest({
						cwd: input.cwd,
						prompt: input.prompt,
						models: input.models,
						budgetUsd: input.budgetUsd,
					}),
					{
						worktreesDir: trees,
						startCommit: input.startCommit,
						bakeoff: input.bakeoff,
						branchName: (index, model) => fanoutBranch(input.bakeoff, index, model, "omp/", "bake"),
						launch: async ({ cwd, model }) => {
							if (model === MODELS[0]) {
								// A new text file, a changed one and a binary one.
								await fs.writeFile(path.join(cwd, "src/extra.ts"), "export const extra = 1;\n");
								await fs.appendFile(path.join(cwd, "src/store.ts"), "// docs\n");
								await fs.writeFile(path.join(cwd, "logo.png"), LOGO);
							} else {
								// Larger than the cap.
								await fs.writeFile(path.join(cwd, "big.txt"), `${"x".repeat(1023)}\n`.repeat(5 * 1024 + 64));
							}
							return `inst-${model === MODELS[0] ? 0 : 1}`;
						},
					},
				);
				return groupRef;
			},
			group: gid => (groupRef?.id === gid ? groupRef : undefined),
			keep: async () => ({ removed: [], skipped: [] }),
			unlink: async () => undefined,
		};
		const started: string[] = [];
		bakeoffs = engine("patch", {
			fanout,
			agent: {
				start: async launch => {
					const agentId = `rw-${started.length}`;
					started.push(agentId);
					const prompt = launch.prompt;
					await fs.writeFile(
						launch.outFile,
						prompt.includes("neutral summary")
							? writeup("It changes the store.", ["src/store.ts@1@Store"])
							: review(/entries \(([A-E, ]+)\)/.exec(prompt)![1]!.split(", "), "src/store.ts").replace(
									"@1@Plan",
									"@1@Store",
								),
					);
					return agentId;
				},
				hosts: async () => [
					{ instanceId: "inst-0", sessionId: "s0", model: MODELS[0]!, busy: false },
					{ instanceId: "inst-1", sessionId: "s1", model: MODELS[1]!, busy: false },
					...started.map(agentId => ({
						instanceId: agentId,
						sessionId: `s-${agentId}`,
						model: null,
						busy: false,
					})),
				],
				stop: async () => undefined,
				cost: async () => 0.02,
			},
		});
		({ id } = await bakeoffs.create({
			cwd: repo,
			ref: "feature/writable",
			base: "main",
			mode: "implementation",
			metrics: METRICS,
			models: MODELS,
			reviewer: "google/gemini-r",
			maxCostUsd: 3,
		}));
		await bakeoffs.idle();
		bakeoff = await bakeoffs.get(id);
		base = await git(repo, "rev-parse", "main");
	}, 60_000);

	/** A fresh clone of the repository at the base, where a patch must apply. */
	async function freshClone(name: string): Promise<string> {
		const dir = path.join(tmp, name);
		await git(tmp, "clone", "-q", "--no-checkout", repo, dir);
		await git(dir, "checkout", "-q", "--detach", base);
		return dir;
	}

	const entryOf = (model: string | undefined) => bakeoff.entries.find(entry => entry.model === model)!;

	it("is offered for every entry whose code is kept, and for no design", async () => {
		expect(bakeoff.stage).toBe("done");
		expect(bakeoff.entries.map(entry => entry.patch)).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
		const designs = engine("patch-design");
		const created = await designs.create({
			cwd: repo,
			ref: "feature/writable",
			base: "main",
			mode: "design",
			metrics: METRICS,
			models: MODELS,
			reviewer: "google/gemini-r",
			maxCostUsd: 3,
		});
		await designs.idle();
		expect((await designs.get(created.id)).entries.every(entry => entry.patch === undefined)).toBe(true);
		await expect(designs.patch(created.id, "A")).rejects.toThrow("Only an implementation has code to export.");
	});

	it("applies to a fresh clone of the base and gives the files the entry has, binary file included", async () => {
		const label = entryOf(MODELS[0]).label;
		const patch = await bakeoffs.patch(id, label);
		expect(patch).toContain("diff --git a/src/extra.ts b/src/extra.ts");
		expect(patch).toContain("GIT binary patch");
		expect(patch).not.toContain(repo);

		const clone = await freshClone("clone-apply");
		await fs.writeFile(path.join(tmp, "entry.patch"), patch);
		await git(clone, "apply", "--check", path.join(tmp, "entry.patch"));
		await git(clone, "apply", path.join(tmp, "entry.patch"));
		expect(await fs.readFile(path.join(clone, "src/extra.ts"), "utf8")).toBe("export const extra = 1;\n");
		expect((await fs.readFile(path.join(clone, "src/store.ts"), "utf8")).endsWith("// docs\n")).toBe(true);
		expect(Buffer.compare(await fs.readFile(path.join(clone, "logo.png")), LOGO)).toBe(0);
		// The entry is the original's change plus its own: the clone holds the original's store too.
		expect(await fs.readFile(path.join(clone, "src/store.ts"), "utf8")).toContain("class Writable");
	});

	it("gives the original's patch against the base: the change itself", async () => {
		const original = bakeoff.entries.find(entry => entry.kind === "original")!;
		const patch = await bakeoffs.patch(id, original.label);
		const clone = await freshClone("clone-original");
		await fs.writeFile(path.join(tmp, "original.patch"), patch);
		await git(clone, "apply", "--check", path.join(tmp, "original.patch"));
		await git(clone, "apply", path.join(tmp, "original.patch"));
		expect(await fs.readFile(path.join(clone, "src/store.ts"), "utf8")).toBe(STORE_AFTER);
	});

	it("refuses a patch over the size cap, in words that say what to do", async () => {
		const label = entryOf(MODELS[1]).label;
		await expect(bakeoffs.patch(id, label)).rejects.toThrow(
			`The patch is larger than ${BAKEOFF_MAX_PATCH_BYTES / (1024 * 1024)} MB`,
		);
	});

	it("refuses an entry that is not in the bake-off, and takes no ref or path in its place", async () => {
		for (const entry of ["Z", "", "main", "../../etc/passwd", "refs/heads/main", base, "A\0"])
			await expect(bakeoffs.patch(id, entry)).rejects.toThrow("There is no such entry.");
		await expect(bakeoffs.patch("nope", "A")).rejects.toThrow();
	});

	it("says the code is gone, and marks the entry, once its commit is no longer kept", async () => {
		const label = entryOf(MODELS[0]).label;
		const refs = (await git(repo, "for-each-ref", "--format=%(refname)", `refs/omp-blueprint/maps/${id}/`)).split(
			"\n",
		);
		expect(refs.length).toBeGreaterThan(0);
		for (const ref of refs.filter(ref => ref.length > 0)) await git(repo, "update-ref", "-d", ref);
		await git(repo, "reflog", "expire", "--expire=now", "--all");
		await git(repo, "gc", "-q", "--prune=now");

		const after = await bakeoffs.get(id);
		expect(after.entries.find(entry => entry.label === label)!.patch).toEqual({
			ok: false,
			reason: "The code of this entry is no longer kept on this computer, so there is nothing to export.",
		});
		await expect(bakeoffs.patch(id, label)).rejects.toThrow("no longer kept on this computer");
	}, 60_000);
});
