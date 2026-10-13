import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BlueprintSummary } from "@oh-my-pi/pi-wire/blueprint";
import { blueprintOverlayYaml, buildBrief, sessionFolderName } from "../scripts/companion-blueprint-agent";
import { createBlueprintStore } from "../scripts/companion-blueprint-store";

const INDEX = {
	units: [
		{
			path: "packages/app",
			label: "packages/app",
			manifest: true,
			files: 12,
			symbols: 80,
			languages: ["TypeScript"],
			diagram: "index:dir:packages/app",
			topFiles: ["packages/app/src/main.ts"],
		},
	],
	unitEdges: [{ from: "packages/app", to: "packages/lib", files: 3 }],
};

describe("the agent's launch", () => {
	it("lets the session write its one file, matching wildcard characters in the path literally", () => {
		const yaml = blueprintOverlayYaml("/home/me/my [cfg]/cache/out/bp-0123456789ab.json");
		expect(yaml).toContain('glob: "/home/me/my [[]cfg[]]/cache/out/bp-0123456789ab.json"');
		expect(yaml).toContain("bash: deny");
		expect(yaml.indexOf("action: allow")).toBeLessThan(yaml.indexOf("action: deny\n"));
		expect(() => blueprintOverlayYaml("C:\\cfg\\out\\bp-0123456789ab.json")).toThrow(/backslash/);
	});

	it("names the checkout folder after the map, without characters a sandbox profile refuses", () => {
		expect(sessionFolderName("repo", "feat/x")).toBe("Architecture · repo @ feat-x");
		expect(sessionFolderName('re"po', "a\\b\nc")).toBe("Architecture · re-po @ a-b-c");
	});

	it("fills every placeholder of the brief, for a plain, a diff and a refresh map", () => {
		const common = {
			repo: "demo",
			target: "branch `main`",
			commit: "a".repeat(40),
			outFile: "/out/bp-1.json",
			maxCostUsd: 3,
			index: INDEX,
		};
		const plain = buildBrief(common);
		const diff = buildBrief({
			...common,
			diff: {
				baseTarget: "main",
				baseCommit: "b".repeat(40),
				baseDir: "/work/base",
				stat: " a.ts | 2 +-",
				symbols: ["a.ts: run (modified)"],
			},
		});
		const refresh = buildBrief({
			...common,
			refresh: { previousCommit: "c".repeat(40), previousFile: "/out/bp-1.previous.json", stat: " b.ts | 1 +" },
		});
		for (const brief of [plain, diff, refresh]) {
			expect(brief).not.toContain("{{");
			expect(brief).toContain("/out/bp-1.json");
			expect(brief).toContain("packages/app");
		}
		expect(diff).toContain("/work/base");
		expect(diff).toContain("a.ts: run (modified)");
		expect(refresh).toContain("/out/bp-1.previous.json");
		expect(plain).not.toContain("/work/base");
	});
});

describe("the map store", () => {
	let tmp: string;
	beforeAll(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "blueprint-store-"));
	});
	afterAll(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});

	const summary = (
		id: string,
		status: BlueprintSummary["status"],
		over: Partial<BlueprintSummary> = {},
	): BlueprintSummary => ({
		id,
		title: id,
		repoRoot: "/r",
		head: { commit: "a".repeat(40) },
		createdAt: 1,
		status,
		...over,
	});

	it("keeps maps private, and marks a map a stopped companion left running as interrupted", async () => {
		const dir = path.join(tmp, "blueprints");
		const store = createBlueprintStore(dir);
		await store.load();
		await store.put(summary("bp-aaaaaaaaaaaa", "ready", { diagramCount: 3 }));
		await store.put(summary("bp-bbbbbbbbbbbb", "running", { progress: "Indexing the code", instanceId: "i-1" }));
		expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
		expect((await fs.stat(path.join(dir, "index.json"))).mode & 0o777).toBe(0o600);

		const reopened = createBlueprintStore(dir);
		expect((await reopened.load()).interruptedInstances).toEqual(["i-1"]);
		expect(reopened.get("bp-aaaaaaaaaaaa")?.status).toBe("ready");
		expect(reopened.get("bp-bbbbbbbbbbbb")).toMatchObject({ status: "failed", error: "interrupted" });
		expect(reopened.get("bp-bbbbbbbbbbbb")?.progress).toBeUndefined();
		// A second start has nothing left to interrupt.
		expect((await createBlueprintStore(dir).load()).interruptedInstances).toEqual([]);
	});

	it("refuses ids that are not maps' own", async () => {
		const store = createBlueprintStore(path.join(tmp, "other"));
		await expect(store.readMap("../index")).rejects.toThrow(/invalid map id/);
		await expect(store.remove("bp-../../x")).rejects.toThrow(/invalid map id/);
	});
});
