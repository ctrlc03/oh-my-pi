import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	COMPANION_RELAY_PORT,
	type CompanionRelay,
	preferredRelayPort,
	previousRelayPort,
	startCompanionRelay,
} from "../scripts/companion-local-relay";
import { overlayYaml } from "../scripts/companion-start";

const started: CompanionRelay[] = [];

function start(options: Parameters<typeof startCompanionRelay>[0]): CompanionRelay {
	const relay = startCompanionRelay(options);
	started.push(relay);
	return relay;
}

afterEach(() => {
	for (const { relay } of started.splice(0)) relay.stop();
});

describe("companion local relay", () => {
	it("moves to another port when the preferred one is taken, instead of failing to start", () => {
		const first = start({ preferredPort: 0 });
		const taken = Number(new URL(first.url).port);
		const second = start({ preferredPort: taken });
		expect(second.url).not.toBe(first.url);
		expect(new URL(second.url).hostname).toBe("127.0.0.1");
	});

	it("serves on the preferred port when it is free", () => {
		// Probe for a free port, release it, and ask for exactly that one.
		const probe = startCompanionRelay({ preferredPort: 0 });
		const port = Number(new URL(probe.url).port);
		probe.relay.stop();
		const relay = start({ preferredPort: port });
		expect(Number(new URL(relay.url).port)).toBe(port);
	});

	it("follows the port of the user's collab.localRelayUrl, else the default", () => {
		expect(preferredRelayPort("ws://127.0.0.1:9123")).toBe(9123);
		expect(preferredRelayPort("")).toBe(COMPANION_RELAY_PORT);
		expect(preferredRelayPort("ws://evil.example.com:9123")).toBe(COMPANION_RELAY_PORT);
	});

	it("prefers the configured port, then the previous companion's port, then the default", () => {
		expect(preferredRelayPort("ws://127.0.0.1:9123", 7468)).toBe(9123);
		expect(preferredRelayPort("", 7468)).toBe(7468);
		expect(preferredRelayPort("", null)).toBe(COMPANION_RELAY_PORT);
		expect(preferredRelayPort("", undefined)).toBe(COMPANION_RELAY_PORT);
		expect(preferredRelayPort("ws://evil.example.com:9123", 7468)).toBe(7468);
		expect(preferredRelayPort("", 0)).toBe(COMPANION_RELAY_PORT);
		expect(preferredRelayPort("", 70_000)).toBe(COMPANION_RELAY_PORT);
	});
});

describe("the port a restarted companion comes back on", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "previous-port-"));
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	const endpoint = (): string => path.join(dir, "collab-companion-local.json");
	const overlay = (): string => path.join(dir, "collab-companion-overlay.yml");

	it("is the endpoint file's port, then the port its own overlay names", async () => {
		expect(await previousRelayPort(endpoint(), overlay())).toBeNull();
		// A clean exit removed the endpoint file; sessions already running were launched with the overlay's port.
		await Bun.write(overlay(), overlayYaml("ws://127.0.0.1:7468", "/x/collab-companion-local.json"));
		expect(await previousRelayPort(endpoint(), overlay())).toBe(7468);
		await Bun.write(endpoint(), JSON.stringify({ pid: 1, port: 9001, app: true }));
		expect(await previousRelayPort(endpoint(), overlay())).toBe(9001);
	});

	it("ignores an overlay that is unreadable, names no relay, or names one that is not on loopback", async () => {
		for (const text of [
			"collab: [unclosed",
			"not: an overlay\n",
			"collab:\n  autoStart: control\n",
			"collab:\n  localRelayUrl: 7468\n",
			'collab:\n  localRelayUrl: "ws://evil.example.com:7468"\n',
			'collab:\n  localRelayUrl: "ws://127.0.0.1"\n',
			"- a\n- list\n",
		]) {
			await Bun.write(overlay(), text);
			expect(await previousRelayPort(endpoint(), overlay())).toBeNull();
		}
	});

	it("sits between the configured address and the default", async () => {
		await Bun.write(overlay(), overlayYaml("ws://127.0.0.1:7468"));
		const previous = await previousRelayPort(endpoint(), overlay());
		expect(preferredRelayPort("", previous)).toBe(7468);
		expect(preferredRelayPort("ws://127.0.0.1:9123", previous)).toBe(9123);
		expect(preferredRelayPort("", await previousRelayPort(endpoint(), path.join(dir, "none.yml")))).toBe(
			COMPANION_RELAY_PORT,
		);
	});
});

describe("companion launch overlay", () => {
	it("names the local relay only when there is one", () => {
		expect(overlayYaml()).not.toContain("localRelayUrl");
		expect(overlayYaml("ws://127.0.0.1:7467")).toContain('localRelayUrl: "ws://127.0.0.1:7467"');
	});

	it("names the endpoint file next to the relay, so a session follows the relay to a new port", () => {
		const file = "/home/me/.omp/agent/collab-companion-local.json";
		const parsed = Bun.YAML.parse(overlayYaml("ws://127.0.0.1:7467", file)) as { collab: Record<string, unknown> };
		expect(parsed.collab).toEqual({
			autoStart: "control",
			localRelayUrl: "ws://127.0.0.1:7467",
			localRelayEndpointFile: file,
		});
		// Without a relay nothing is published, so there is nothing to point at.
		expect(overlayYaml(undefined, file)).not.toContain("localRelayEndpointFile");
	});
});
