/**
 * Entry of a foreign agent host: one process per session, started detached by the companion and living on
 * after it. It hosts a collab room for one vendor agent (`./foreign-host.ts`) until the agent can no longer
 * run or the process is told to stop (SIGTERM, SIGINT, SIGHUP).
 *
 *   bun scripts/foreign/host-main.ts --agent <id> --cwd <abs dir> [--resume <session id>] [--model <id>]
 *     [--permission supervised|full] [--max-cost <usd>] [--prompt-file <path>] [--worktree]
 *     [--fanout <json {group,model,agent?}>] [--relay <ws url>] [--local-relay <ws url>] [--web <http url>]
 *
 * The config root is `~/<PI_CONFIG_DIR or .omp>`, as everywhere else. A bad argument ends the process with
 * status 2 and a message on stderr.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionPermission } from "@oh-my-pi/pi-wire";
import type { HostFanout } from "../../src/lib/fanout";
import { isRecord } from "../../src/tool-render/util";
import { agentName } from "./agents";
import { ForeignHost, type ForeignHostOptions } from "./foreign-host";

const AGENT_ID_RE = /^(?:claude|codex|cursor|grok|opencode|custom:[a-z0-9-]{1,32})$/;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MODEL_RE = /^[A-Za-z0-9_][\w.:/@+[\]-]{0,199}$/;
const MAX_PROMPT_BYTES = 256 * 1024;

const VALUE_FLAGS = new Set([
	"--agent",
	"--cwd",
	"--resume",
	"--model",
	"--permission",
	"--max-cost",
	"--prompt-file",
	"--fanout",
	"--relay",
	"--local-relay",
	"--web",
]);
const SWITCH_FLAGS = new Set(["--worktree"]);

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): Map<string, string> {
	const values = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === undefined) continue;
		if (SWITCH_FLAGS.has(flag)) {
			values.set(flag, "");
			continue;
		}
		if (!VALUE_FLAGS.has(flag)) throw new UsageError(`unknown argument: ${flag}`);
		const value = argv[++i];
		if (value === undefined) throw new UsageError(`${flag} needs a value`);
		if (values.has(flag)) throw new UsageError(`${flag} was given twice`);
		values.set(flag, value);
	}
	return values;
}

function parseFanout(text: string): HostFanout {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new UsageError("--fanout is not JSON");
	}
	if (!isRecord(parsed) || typeof parsed.group !== "string" || typeof parsed.model !== "string") {
		throw new UsageError("--fanout needs a group and a model");
	}
	const agent = parsed.agent;
	if (agent === undefined) return { group: parsed.group, model: parsed.model };
	if (!isRecord(agent) || typeof agent.id !== "string" || typeof agent.name !== "string")
		throw new UsageError("--fanout has a malformed agent");
	return { group: parsed.group, model: parsed.model, agent: { id: agent.id, name: agent.name } };
}

/** The prompt file's text; the file is deleted once read, so a prompt never lingers on disk. */
async function takePrompt(file: string): Promise<string> {
	let text: string;
	try {
		const stat = await fs.stat(file);
		if (!stat.isFile() || stat.size > MAX_PROMPT_BYTES) throw new UsageError("--prompt-file is not a small file");
		text = await Bun.file(file).text();
	} catch (err) {
		if (err instanceof UsageError) throw err;
		throw new UsageError(`cannot read --prompt-file: ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		await fs.rm(file, { force: true });
	}
	return text;
}

async function parseOptions(argv: readonly string[]): Promise<ForeignHostOptions> {
	const args = parseArgs(argv);
	const agentId = args.get("--agent");
	if (agentId === undefined || !AGENT_ID_RE.test(agentId))
		throw new UsageError("--agent must be claude, codex, cursor, grok, opencode or custom:<name>");
	const cwd = args.get("--cwd");
	if (cwd === undefined || !path.isAbsolute(cwd) || cwd.includes("\0"))
		throw new UsageError("--cwd must be an absolute path");
	try {
		if (!(await fs.stat(cwd)).isDirectory()) throw new Error("not a directory");
	} catch {
		throw new UsageError(`--cwd is not a directory: ${cwd}`);
	}
	const resume = args.get("--resume");
	if (resume !== undefined && !SESSION_ID_RE.test(resume)) throw new UsageError("--resume is not a session id");
	const model = args.get("--model");
	if (model !== undefined && (!MODEL_RE.test(model) || model.startsWith("-")))
		throw new UsageError("--model is not a model id");
	const permission = args.get("--permission") ?? "supervised";
	if (permission !== "supervised" && permission !== "full")
		throw new UsageError("--permission must be supervised or full");
	const cost = args.get("--max-cost");
	const maxCostUsd = cost === undefined ? undefined : Number(cost);
	if (maxCostUsd !== undefined && (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0))
		throw new UsageError("--max-cost must be a positive number of dollars");
	const relayUrl = args.get("--relay");
	if (relayUrl !== undefined && !/^wss?:\/\//.test(relayUrl))
		throw new UsageError("--relay must start with ws:// or wss://");
	const localRelayUrl = args.get("--local-relay");
	const webUrl = args.get("--web");
	if (webUrl !== undefined && !/^https?:\/\//.test(webUrl))
		throw new UsageError("--web must start with http:// or https://");
	const fanout = args.get("--fanout");
	const promptFile = args.get("--prompt-file");
	const prompt = promptFile === undefined ? undefined : await takePrompt(promptFile);

	const configDir = path.join(os.homedir(), process.env.PI_CONFIG_DIR || ".omp");
	const name = await agentName(agentId, { configDir });
	if (name === null) throw new UsageError(`unknown agent: ${agentId}`);

	return {
		configDir,
		agent: { id: agentId, name },
		cwd,
		resume,
		model,
		permission: permission as SessionPermission,
		maxCostUsd,
		prompt,
		worktree: args.has("--worktree"),
		fanout: fanout === undefined ? undefined : parseFanout(fanout),
		relayUrl,
		localRelayUrl,
		webUrl,
	};
}

async function main(): Promise<number> {
	let options: ForeignHostOptions;
	try {
		options = await parseOptions(process.argv.slice(2));
	} catch (err) {
		console.error(`host-main: ${err instanceof Error ? err.message : String(err)}`);
		return err instanceof UsageError ? 2 : 1;
	}
	const host = new ForeignHost(options);
	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
		process.on(signal, () => void host.stop(`${options.agent.name} session stopped`));
	}
	process.on("unhandledRejection", reason => {
		console.error("host-main: unhandled rejection:", reason);
	});
	try {
		await host.start();
	} catch (err) {
		console.error(`host-main: ${err instanceof Error ? err.message : String(err)}`);
		await host.stop("the session could not start", 1);
		return 1;
	}
	const { control, view, web } = host.links;
	console.log("foreign host ready");
	console.log(`agent: ${options.agent.name} (${options.agent.id})`);
	console.log(`session: ${host.sessionId}`);
	console.log(`join link: ${control}`);
	console.log(`view link (read-only): ${view}`);
	console.log(`web link: ${web}`);
	return host.done;
}

process.exit(await main());
