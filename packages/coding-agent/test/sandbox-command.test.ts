import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { parseProfile } from "@oh-my-pi/pi-coding-agent/profiles/definition";
import { stricterSandboxMode } from "@oh-my-pi/pi-coding-agent/profiles/merge";
import { describeLoosening } from "@oh-my-pi/pi-coding-agent/profiles/strictness";
import { parseSandboxArgs, runSandboxCommand } from "@oh-my-pi/pi-coding-agent/sandbox/command";
import { cfgSandboxMode, cfgSandboxNetwork } from "@oh-my-pi/pi-coding-agent/sandbox/settings";

describe("/sandbox command", () => {
	it("parses modes, network toggles and rejects the rest", () => {
		expect(parseSandboxArgs("")).toEqual({ action: "show" });
		expect(parseSandboxArgs("Read-Only")).toEqual({ action: "mode", mode: "read-only" });
		expect(parseSandboxArgs("network on")).toEqual({ action: "network", network: true });
		expect(parseSandboxArgs("network maybe").action).toBe("error");
		expect(parseSandboxArgs("workspace").action).toBe("error");
		expect(parseSandboxArgs("off now").action).toBe("error");
	});

	it("changes the mode and network for the session only", () => {
		const settings = Settings.isolated({});
		runSandboxCommand(settings, parseSandboxArgs("workspace-write"));
		expect(cfgSandboxMode.get(settings)).toBe("workspace-write");
		runSandboxCommand(settings, parseSandboxArgs("network on"));
		expect(cfgSandboxNetwork.get(settings)).toBe("on");
		runSandboxCommand(settings, parseSandboxArgs("off"));
		expect(cfgSandboxMode.get(settings)).toBe("off");
	});
});

describe("profile sandbox field", () => {
	it("parses sandbox, accepting a bare YAML off, and rejects unknown values", () => {
		expect(parseProfile("a", { sandbox: "read-only" }, "user").profile?.sandbox).toBe("read-only");
		expect(parseProfile("a", { sandbox: false }, "user").profile?.sandbox).toBe("off");
		const bad = parseProfile("a", { sandbox: "strict" }, "user");
		expect(bad.profile?.sandbox).toBeUndefined();
		expect(bad.warnings.length).toBeGreaterThan(0);
	});

	it("only ever tightens, and a switch to a looser profile counts as loosening", () => {
		expect(stricterSandboxMode("read-only", "workspace-write")).toBe("read-only");
		expect(stricterSandboxMode("off", "workspace-write")).toBe("workspace-write");
		expect(stricterSandboxMode("workspace-write", "off")).toBe("workspace-write");
		const base = { approvalMode: "write", approvalModeCapped: false } as const;
		const strict = parseProfile("strict", { sandbox: "read-only" }, "user").profile;
		const plain = parseProfile("plain", {}, "user").profile;
		if (!strict || !plain) throw new Error("profiles did not parse");
		expect(describeLoosening(strict, plain, base)).toContain("sandbox");
		expect(describeLoosening(plain, strict, base)).toBeUndefined();
	});
});
