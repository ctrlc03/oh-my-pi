/**
 * Contract: the endpoint file yields a port only when it is well formed and names a running
 * process; anything else (missing, garbled, out-of-range port, dead companion) yields nothing.
 */
import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readLiveLocalRelayPort } from "@oh-my-pi/pi-coding-agent/collab/local-relay-endpoint";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function endpointFile(contents: string | undefined): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-endpoint-"));
	dirs.push(dir);
	const file = path.join(dir, "collab-companion-local.json");
	if (contents !== undefined) fs.writeFileSync(file, contents);
	return file;
}

async function deadPid(): Promise<number> {
	const child = Bun.spawn([process.execPath, "-e", ""]);
	await child.exited;
	return child.pid;
}

it("returns the port of a running companion", () => {
	expect(readLiveLocalRelayPort(endpointFile(JSON.stringify({ pid: process.pid, port: 7468, app: true })))).toBe(7468);
});

it("returns nothing for a dead companion", async () => {
	expect(readLiveLocalRelayPort(endpointFile(JSON.stringify({ pid: await deadPid(), port: 7468 })))).toBeUndefined();
});

it("returns nothing for a missing, garbled or malformed file", () => {
	expect(readLiveLocalRelayPort(endpointFile(undefined))).toBeUndefined();
	expect(readLiveLocalRelayPort(endpointFile("{not json"))).toBeUndefined();
	expect(readLiveLocalRelayPort(endpointFile("null"))).toBeUndefined();
	expect(readLiveLocalRelayPort(endpointFile(JSON.stringify({ port: 7468 })))).toBeUndefined();
	expect(readLiveLocalRelayPort(endpointFile(JSON.stringify({ pid: process.pid })))).toBeUndefined();
	expect(readLiveLocalRelayPort(endpointFile(JSON.stringify({ pid: 0, port: 7468 })))).toBeUndefined();
});

it("returns nothing for a port that is not a valid TCP port", () => {
	for (const port of [0, 65_536, -1, 74.5, "7468"]) {
		expect(readLiveLocalRelayPort(endpointFile(JSON.stringify({ pid: process.pid, port })))).toBeUndefined();
	}
});
