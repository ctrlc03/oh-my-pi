/**
 * macOS Seatbelt rendering of a {@link SandboxPolicy}: an SBPL profile for
 * `sandbox-exec -p`. The profile starts from `(deny default)` and allows only
 * what ordinary toolchains need (process creation, reads, a short list of
 * system services), so launchd/XPC escapes such as `open` or `osascript` fail.
 * In SBPL the last matching rule wins, hence allows come before the denies
 * that carve exceptions out of them.
 */
import type { SandboxPathMatcher, SandboxPolicy } from "./policy";

/** Mach services every command needs: user lookup, logging, preferences, CoreServices. */
const BASE_MACH_SERVICES: readonly string[] = [
	"com.apple.system.opendirectoryd.libinfo",
	"com.apple.system.logger",
	"com.apple.logd",
	"com.apple.cfprefsd.daemon",
	"com.apple.cfprefsd.agent",
	"com.apple.system.notification_center",
	"com.apple.CoreServices.coreservicesd",
	"com.apple.analyticsd",
	"com.apple.diagnosticd",
	"com.apple.FSEvents",
	"com.apple.lsd.mapdb",
];

/** Additional Mach services DNS and TLS need. Keychain services (`securityd`) stay excluded. */
const NETWORK_MACH_SERVICES: readonly string[] = [
	"com.apple.dnssd.service",
	"com.apple.SystemConfiguration.DNSConfiguration",
	"com.apple.SystemConfiguration.configd",
	"com.apple.trustd.agent",
	"com.apple.networkd",
	"com.apple.nsurlsessiond",
];

const DEVICE_WRITES = [
	'(literal "/dev/null")',
	'(literal "/dev/zero")',
	'(literal "/dev/tty")',
	'(literal "/dev/dtracehelper")',
	'(literal "/dev/ptmx")',
	'(regex #"^/dev/fd/[0-9]+$")',
	'(regex #"^/dev/ttys[0-9]+$")',
].join(" ");

/** Quote a path for an SBPL string literal. */
function sbplString(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function sbplMatcher(matcher: SandboxPathMatcher): string {
	if ("subpath" in matcher) return `(subpath ${sbplString(matcher.subpath)})`;
	return `(regex #"${matcher.regex}")`;
}

function sbplMatchers(matchers: readonly SandboxPathMatcher[]): string {
	return matchers.map(sbplMatcher).join(" ");
}

function machLookup(services: readonly string[]): string {
	return `(allow mach-lookup ${services.map(name => `(global-name ${sbplString(name)})`).join(" ")})`;
}

export function buildSeatbeltProfile(policy: SandboxPolicy): string {
	const lines = [
		"(version 1)",
		"(deny default)",
		"(allow process-exec)",
		"(allow process-fork)",
		"(allow signal (target same-sandbox))",
		"(allow process-info* (target same-sandbox))",
		"(allow sysctl-read)",
		"(allow user-preference-read)",
		"(allow ipc-posix-sem)",
		"(allow pseudo-tty)",
		"(allow file-ioctl)",
		// Creating sockets is harmless without the network rules; AF_UNIX socketpairs back event loops.
		"(allow system-socket)",
		"(allow file-read*)",
		`(allow file-write* ${DEVICE_WRITES})`,
		machLookup(BASE_MACH_SERVICES),
	];
	if (policy.network) {
		lines.push("(allow network*)", machLookup(NETWORK_MACH_SERVICES));
	}
	if (policy.writableRoots.length > 0) {
		lines.push(`(allow file-write* ${sbplMatchers(policy.writableRoots.map(subpath => ({ subpath })))})`);
	}
	if (policy.readOnly.length > 0) lines.push(`(deny file-write* ${sbplMatchers(policy.readOnly)})`);
	if (policy.denyWrite.length > 0) lines.push(`(deny file-write* ${sbplMatchers(policy.denyWrite)})`);
	if (policy.denyAccess.length > 0) lines.push(`(deny file-read* file-write* ${sbplMatchers(policy.denyAccess)})`);
	return `${lines.join("\n")}\n`;
}
