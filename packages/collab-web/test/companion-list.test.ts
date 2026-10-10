import { describe, expect, it } from "bun:test";
import { createSessionLister, type RegistryModule } from "../scripts/companion-list";

class FakeLinkError extends Error {}

function lister(registry: Partial<RegistryModule>, cli: string[][]) {
	return createSessionLister({
		sandboxOverlayPath: "/nonexistent",
		runOmp: async args => {
			cli.push(args);
			return JSON.stringify({ url: "https://cli/link" });
		},
		loadRegistry: async () => ({ CollabLinkError: FakeLinkError, ...registry }) as RegistryModule,
	});
}

describe("session links", () => {
	it("come from the registry without spawning omp", async () => {
		const cli: string[][] = [];
		const asked: string[] = [];
		const sessions = lister(
			{
				resolveCollabHostLink: async (selector, access) => {
					asked.push(`${selector}:${access}`);
					return { instanceId: selector, generation: 1, access, url: "https://registry/link" };
				},
			},
			cli,
		);
		expect(await sessions.link("abc12345")).toBe("https://registry/link");
		expect(asked).toEqual(["abc12345:control"]);
		expect(cli).toEqual([]);
	});

	it("do not fall back to the CLI when the registry refuses: a stale generation must not hand out the successor room", async () => {
		const cli: string[][] = [];
		const sessions = lister(
			{
				resolveCollabHostLink: async () => {
					throw new FakeLinkError("started a new room since it was listed");
				},
			},
			cli,
		);
		await expect(sessions.link("abc12345")).rejects.toThrow("new room");
		expect(cli).toEqual([]);
	});

	it("fall back to the CLI when the registry fails unexpectedly", async () => {
		const cli: string[][] = [];
		const sessions = lister(
			{
				startCollabSession: async () => {
					throw new Error("socket closed");
				},
			},
			cli,
		);
		expect(await sessions.share("abc12345")).toBe("https://cli/link");
		expect(cli).toEqual([["collab", "start", "abc12345", "--json"]]);
	});

	it("use the CLI when the registry module cannot load", async () => {
		const cli: string[][] = [];
		const sessions = createSessionLister({
			sandboxOverlayPath: "/nonexistent",
			runOmp: async args => {
				cli.push(args);
				return JSON.stringify({ url: "https://cli/link" });
			},
			loadRegistry: async () => {
				throw new Error("cannot find module");
			},
		});
		expect(await sessions.link("abc12345")).toBe("https://cli/link");
		expect(cli).toEqual([["collab", "link", "abc12345", "--json"]]);
	});
});
