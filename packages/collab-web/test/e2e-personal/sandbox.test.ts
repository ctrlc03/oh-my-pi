import { afterAll, beforeAll, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { GuestClient } from "../../src/lib/client";
import { PersonalHarness } from "../../scripts/e2e-personal-harness";
import { describeE2e, SCENARIO_TIMEOUT_MS } from "./support";

/** The sandbox is Seatbelt here; the Linux backend is bubblewrap and is not exercised. */
const describeSandbox = process.platform === "darwin" ? describeE2e : describeE2e.skip;

/**
 * Scenario 13: `sandbox.mode: workspace-write`. A shell command of the Personal session writes in the workspace and nowhere
 * of the profile's own state, and cannot read the owner key or the endpoint file.
 */
describeSandbox("the shell sandbox", () => {
	let h: PersonalHarness;
	let guest: GuestClient;
	let P: string;
	let C: string;
	let ownerKey: string;
	let endpointFile: string;

	beforeAll(async () => {
		h = await PersonalHarness.start();
		await h.setUp();
		await h.waitIdle();
		guest = await h.openSession();
		P = h.profile;
		C = h.configDir;
		ownerKey = path.join(h.agentDir, "collab-companion-personal-owner.key");
		endpointFile = path.join(h.agentDir, "collab-companion-personal-ipc.json");
	}, SCENARIO_TIMEOUT_MS);

	afterAll(async () => {
		await h?.stop();
	});

	const exists = (file: string): Promise<boolean> =>
		fs.stat(file).then(
			() => true,
			() => false,
		);

	const bash = (command: string) => ({ name: "bash", args: { command } });

	it(
		"lets a command write the workspace",
		async () => {
			const [result] = await h.toolsOnPrompt(guest, "SANDBOX-WRITE-WORKSPACE", [
				bash(`echo allowed > "${path.join(P, "workspace", "sandbox-ok.txt")}" && echo WROTE-WORKSPACE`),
			]);
			expect(result).toContain("WROTE-WORKSPACE");
			expect((await Bun.file(path.join(P, "workspace", "sandbox-ok.txt")).text()).trim()).toBe("allowed");
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"refuses writes to the profile's agent folder, personal state, run folder and the owner key",
		async () => {
			const targets = [
				path.join(h.agentDir, "sandbox-denied.txt"),
				path.join(P, "personal", "sandbox-denied.txt"),
				path.join(C, "run", "sandbox-denied.txt"),
				path.join(C, "run", "personal", "inbox", "sandbox-denied.json"),
				ownerKey,
			];
			const keyBefore = await Bun.file(ownerKey).text();
			const results = await h.toolsOnPrompt(
				guest,
				"SANDBOX-WRITE-DENIED",
				targets.map(target => bash(`echo tampered >> "${target}"; echo "exit=$?"`)),
			);
			expect(results).toHaveLength(targets.length);
			results.forEach((result, i) => {
				expect(result).toMatch(/not permitted|denied/i);
				expect(result).not.toContain("exit=0");
				expect(result).toContain(path.basename(targets[i]!).slice(0, 8));
			});
			for (const target of targets.slice(0, 4)) expect(await exists(target)).toBe(false);
			expect(await Bun.file(ownerKey).text()).toBe(keyBefore);
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"refuses reading the owner key and the endpoint file",
		async () => {
			const key = (await Bun.file(ownerKey).text()).trim();
			const endpoint = JSON.parse(await Bun.file(endpointFile).text()) as { token: string };
			expect(key.length).toBeGreaterThan(8);
			const results = await h.toolsOnPrompt(guest, "SANDBOX-READ-DENIED", [
				bash(`cat "${ownerKey}"; echo "exit=$?"`),
				bash(`cat "${endpointFile}"; echo "exit=$?"`),
				bash(`ls "${h.agentDir}" | head -50; echo "exit=$?"`),
			]);
			expect(results[0]).toMatch(/not permitted|denied/i);
			expect(results[0]).not.toContain(key);
			expect(results[1]).toMatch(/not permitted|denied/i);
			expect(results[1]).not.toContain(endpoint.token);
			// Nothing the model was shown carries either secret.
			const everything = h.stub.requests.map(r => r.transcript).join("\n");
			expect(everything).not.toContain(key);
			expect(everything).not.toContain(endpoint.token);
		},
		SCENARIO_TIMEOUT_MS,
	);
});
