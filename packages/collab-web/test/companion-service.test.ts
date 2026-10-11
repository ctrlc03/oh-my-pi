import { describe, expect, it } from "bun:test";
import { buildPlist } from "../scripts/companion-launchd";
import { managedBy, pairCommand, servicePath, serviceKind, startedByHandHint } from "../scripts/companion-service";
import {
	buildUnit,
	isSystemdManaged,
	noSystemdMessage,
	quoteUnitWord,
	SYSTEMD_UNIT,
	systemdLogHint,
	unitPath,
} from "../scripts/companion-systemd";

const CGROUP_V2_UNIT = `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${SYSTEMD_UNIT}\n`;
const CGROUP_V2_TERMINAL = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-terminal-1234.scope\n";
const CGROUP_V1_UNIT = `12:pids:/user.slice\n1:name=systemd:/user.slice/user-1000.slice/user@1000.service/${SYSTEMD_UNIT}\n`;

describe("quoteUnitWord", () => {
	it("wraps in double quotes and escapes backslash, quote and specifier percent", () => {
		expect(quoteUnitWord("/usr/bin/omp", true)).toBe('"/usr/bin/omp"');
		expect(quoteUnitWord('a "b" \\c', true)).toBe('"a \\"b\\" \\\\c"');
		expect(quoteUnitWord("100%", true)).toBe('"100%%"');
	});

	it("doubles `$` only where systemd expands variables (ExecStart), and escapes whitespace controls", () => {
		expect(quoteUnitWord("a$b", true)).toBe('"a$$b"');
		expect(quoteUnitWord("a$b", false)).toBe('"a$b"');
		expect(quoteUnitWord("a\nb\tc", false)).toBe('"a\\nb\\tc"');
	});

	it("refuses control characters a unit cannot carry", () => {
		expect(() => quoteUnitWord("a\u0000b", true)).toThrow("control characters");
	});
});

describe("buildUnit", () => {
	const unit = buildUnit({
		argv: ["/home/me/.local/bin/omp", "companion"],
		env: { OMP_BIN: "/home/me/.local/bin/omp", PATH: "/home/me/.local/bin:/usr/bin" },
	});

	it("runs the argv as quoted words from the home directory, restarts always, and logs to the journal", () => {
		expect(unit).toContain('ExecStart="/home/me/.local/bin/omp" "companion"\n');
		expect(unit).toContain("WorkingDirectory=%h\n");
		expect(unit).toContain("Restart=always\nRestartSec=5\n");
		expect(unit).toContain("WantedBy=default.target\n");
		expect(unit).not.toContain("User=");
		expect(unit).not.toContain("StandardOutput=");
	});

	it("leaves the tmux sessions it started alone when the unit stops, and counts SIGTERM's exit as clean", () => {
		expect(unit).toContain("KillMode=process\nSuccessExitStatus=143\n");
	});

	it("sets each environment variable on its own quoted line", () => {
		expect(unit).toContain('Environment="OMP_BIN=/home/me/.local/bin/omp"\n');
		expect(unit).toContain('Environment="PATH=/home/me/.local/bin:/usr/bin"\n');
	});

	it("escapes percent signs in paths and doubles `$` only in arguments, as systemd reads them", () => {
		const odd = buildUnit({
			argv: ["/opt/my omp/100%/$HOME/omp", 'a "b" $c\\d'],
			env: { PI_CONFIG_DIR: "/home/me/my config/100%", ODD: 'x "y" $HOME' },
		});
		expect(odd).toContain('ExecStart="/opt/my omp/100%%/$HOME/omp" "a \\"b\\" $$c\\\\d"\n');
		expect(odd).toContain('Environment="PI_CONFIG_DIR=/home/me/my config/100%%"\n');
		expect(odd).toContain('Environment="ODD=x \\"y\\" $HOME"\n');
	});

	it("rejects an executable path with quotes or backslashes, which systemd refuses", () => {
		expect(() => buildUnit({ argv: ['/opt/o"mp', "companion"], env: {} })).toThrow("quotes or backslashes");
	});

	it("rejects an environment variable name systemd would not take", () => {
		expect(() => buildUnit({ argv: ["/a"], env: { "BAD NAME": "x" } })).toThrow("invalid environment variable name");
	});

	it("runs `bun companion.ts` from a checkout", () => {
		const dev = buildUnit({
			argv: ["/usr/local/bin/bun", "/repo/packages/collab-web/scripts/companion.ts"],
			env: {},
		});
		expect(dev).toContain('ExecStart="/usr/local/bin/bun" "/repo/packages/collab-web/scripts/companion.ts"\n');
	});
});

describe("unitPath", () => {
	it("follows XDG_CONFIG_HOME when it is absolute, else ~/.config", () => {
		expect(unitPath({ XDG_CONFIG_HOME: "/x/cfg" })).toBe(`/x/cfg/systemd/user/${SYSTEMD_UNIT}`);
		expect(unitPath({ XDG_CONFIG_HOME: "relative" })).toMatch(new RegExp(`/\\.config/systemd/user/${SYSTEMD_UNIT}$`));
		expect(unitPath({})).toMatch(new RegExp(`/\\.config/systemd/user/${SYSTEMD_UNIT}$`));
	});
});

describe("isSystemdManaged", () => {
	it("needs INVOCATION_ID and the companion unit's cgroup", () => {
		expect(isSystemdManaged({ INVOCATION_ID: "abc" }, () => CGROUP_V2_UNIT)).toBe(true);
		expect(isSystemdManaged({ INVOCATION_ID: "abc" }, () => CGROUP_V1_UNIT)).toBe(true);
	});

	it("is false for a terminal that is itself a systemd unit, and without INVOCATION_ID", () => {
		expect(isSystemdManaged({ INVOCATION_ID: "abc" }, () => CGROUP_V2_TERMINAL)).toBe(false);
		expect(isSystemdManaged({}, () => CGROUP_V2_UNIT)).toBe(false);
		expect(isSystemdManaged({ INVOCATION_ID: "" }, () => CGROUP_V2_UNIT)).toBe(false);
		expect(isSystemdManaged({ INVOCATION_ID: "abc" }, () => "")).toBe(false);
	});
});

describe("noSystemdMessage", () => {
	it("gives the reason and how to run the companion by hand", () => {
		const message = noSystemdMessage("Failed to connect to bus", ["/home/me/.local/bin/omp", "companion"]);
		expect(message).toContain("Failed to connect to bus");
		expect(message).toContain("tmux new-session -d -s omp-companion /home/me/.local/bin/omp companion");
		expect(noSystemdMessage("x", ["/a b/omp", "companion"])).toContain("'/a b/omp' companion");
	});
});

describe("platform dispatch", () => {
	it("picks launchd on macOS, systemd on Linux, nothing elsewhere", () => {
		expect(serviceKind("darwin")).toBe("launchd");
		expect(serviceKind("linux")).toBe("systemd");
		expect(serviceKind("win32")).toBeNull();
	});

	it("is not managed without the platform's marker", () => {
		expect(managedBy({})).toBeNull();
		expect(managedBy({ XPC_SERVICE_NAME: "0" })).toBeNull();
	});

	it("names the right service manager in the started-by-hand text", () => {
		expect(startedByHandHint("linux")).toContain("so systemd keeps it running");
		expect(startedByHandHint("darwin")).toContain("so macOS keeps it running");
		expect(startedByHandHint("linux")).toContain("started by hand");
	});

	it("names the command that prints a pairing link on demand", () => {
		expect(pairCommand()).toBe("bun scripts/companion.ts --pair");
	});

	it("points at the journal on Linux", () => {
		expect(systemdLogHint()).toBe(`journalctl --user -u ${SYSTEMD_UNIT} -f`);
	});
});

describe("servicePath", () => {
	it("lists the tools' directories first and drops Homebrew's off macOS", () => {
		const linux = servicePath(["/home/me/.local/bin/omp", null, "/usr/bin/tmux"], "linux", "/home/me/bin:/usr/bin");
		expect(linux).toBe("/home/me/.local/bin:/usr/bin:/usr/local/bin:/home/me/bin:/bin:/usr/sbin:/sbin");
		const mac = servicePath(["/Users/me/.bun/bin/bun"], "darwin", "/usr/bin");
		expect(mac).toBe("/Users/me/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
	});
});

describe("buildPlist", () => {
	it("keeps the macOS property list as it was: label, argv, env, log", () => {
		const plist = buildPlist({
			argv: ["/Users/me/.bun/bin/bun", "/repo/packages/collab-web/scripts/companion.ts"],
			env: { OMP_BIN: "/Users/me/.bun/bin/omp", PATH: "/usr/bin:/bin" },
			logPath: "/Users/me/Library/Logs/omp-collab-companion.log",
		});
		expect(plist).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>sh.omp.collab-companion</string>
	<key>ProgramArguments</key>
	<array>
		<string>/Users/me/.bun/bin/bun</string>
		<string>/repo/packages/collab-web/scripts/companion.ts</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>OMP_BIN</key>
		<string>/Users/me/.bun/bin/omp</string>
		<key>PATH</key>
		<string>/usr/bin:/bin</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>/Users/me/Library/Logs/omp-collab-companion.log</string>
	<key>StandardErrorPath</key>
	<string>/Users/me/Library/Logs/omp-collab-companion.log</string>
</dict>
</plist>
`);
	});

	it("runs a compiled omp as [omp, companion]", () => {
		const plist = buildPlist({ argv: ["/Users/me/.local/bin/omp", "companion"], env: {}, logPath: "/l" });
		expect(plist).toContain("\t\t<string>/Users/me/.local/bin/omp</string>\n\t\t<string>companion</string>\n");
	});
});
