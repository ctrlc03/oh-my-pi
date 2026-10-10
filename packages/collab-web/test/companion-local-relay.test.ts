import { afterEach, describe, expect, it } from "bun:test";
import {
	COMPANION_RELAY_PORT,
	type CompanionRelay,
	preferredRelayPort,
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
});

describe("companion launch overlay", () => {
	it("names the local relay only when there is one", () => {
		expect(overlayYaml()).not.toContain("localRelayUrl");
		expect(overlayYaml("ws://127.0.0.1:7467")).toContain('localRelayUrl: "ws://127.0.0.1:7467"');
	});
});
