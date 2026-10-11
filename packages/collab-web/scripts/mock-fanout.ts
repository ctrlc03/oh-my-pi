/**
 * The `folders` and `fanout-*` requests for scripts/mock-companion.ts, so the model-comparison screens
 * can be tried in a browser without tmux or omp. It runs the real fan-out code (./companion-fanout)
 * against a throw-away git repository: the worktrees, branches, changed files, spend limits and
 * the refusals when keeping a winner are real; only the sessions are fake. Each "session" is a mock host
 * entry that writes a few files into its worktree, works for a few seconds, then idles.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CompanionHost, CompanionReply, CompanionRequest, RunInfo } from "../src/lib/companion";
import { type FanoutGroup, type FanoutModel, type HostFanout, hostFanout } from "../src/lib/fanout";
import {
	compareGroup,
	keepRun,
	parseFanoutRequest,
	parseKeepRequest,
	startFanout,
	withGroup,
} from "./companion-fanout";
import { gitReview } from "./companion-gitflow";

const MODELS: FanoutModel[] = [
	{ selector: "anthropic/claude-sonnet-5-5", provider: "anthropic", name: "Claude Sonnet 5.5" },
	{ selector: "anthropic/claude-haiku-4-5", provider: "anthropic", name: "Claude Haiku 4.5" },
	{ selector: "openai/gpt-5", provider: "openai", name: "GPT-5" },
	{ selector: "openai/gpt-5-mini", provider: "openai", name: "GPT-5 mini" },
	{ selector: "google/gemini-2.5-pro", provider: "google", name: "Gemini 2.5 Pro" },
	{ selector: "deepseek/deepseek-v3", provider: "deepseek", name: "DeepSeek V3" },
];
const WORK_MS = 6_000;

async function sh(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(err.trim() || `${args.join(" ")} failed`);
	return out.trim();
}

export interface MockFanout {
	/** Fields the mock companion's `hosts` frame needs for the app to offer starting sessions and comparing models. */
	capabilities: { canStart: true; canFanout: true };
	/** `hosts` with the group each fan-out session belongs to. */
	annotate(hosts: readonly CompanionHost[]): CompanionHost[];
	handles(request: CompanionRequest): boolean;
	answer(request: CompanionRequest): Promise<CompanionReply>;
}

export async function createMockFanout(options: {
	dir: string;
	/** The mock companion's live session list: fan-out sessions are added to and removed from it. */
	hosts: CompanionHost[];
	onChange(): void;
	/** Answers every `link` request (opening a started session) with this room link, e.g. from `scripts/mock-host.ts`. */
	sessionLink?: string;
}): Promise<MockFanout> {
	const repo = path.join(options.dir, "fanout-repo");
	const worktrees = path.join(options.dir, "worktrees");
	await fs.mkdir(repo, { recursive: true });
	if (!(await Bun.file(path.join(repo, ".git", "HEAD")).exists())) {
		await sh(repo, "git", "init", "-q", "-b", "main");
		await sh(repo, "git", "config", "user.name", "mock");
		await sh(repo, "git", "config", "user.email", "mock@example.com");
		await sh(repo, "git", "config", "commit.gpgsign", "false");
		await Bun.write(path.join(repo, "README.md"), "# mock repository\n");
		await sh(repo, "git", "add", ".");
		await sh(repo, "git", "commit", "-q", "-m", "init");
	}
	const folder = await fs.realpath(repo);
	let groups: FanoutGroup[] = [];
	const spend = new Map<string, number>();
	let sessions = 0;

	/** A fake session: a host entry that writes files into its worktree, "works" for a while, then idles. */
	const launch = async (input: {
		cwd: string;
		prompt: string;
		model: string;
		maxCostUsd?: number;
	}): Promise<string> => {
		const n = ++sessions;
		const instanceId = `fan-${n}-${crypto.randomUUID().slice(0, 6)}`;
		const cwd = await fs.realpath(input.cwd);
		options.hosts.push({
			instanceId,
			sessionId: instanceId,
			sessionName: `${input.model} · comparison`,
			cwd,
			model: input.model,
			startedAt: Date.now(),
			participants: 1,
			busy: true,
			inputRequired: false,
			relayConnected: true,
		});
		const files = (n % 3) + 1;
		for (let i = 1; i <= files; i++) {
			await Bun.write(
				path.join(cwd, "src", `generated-${i}.ts`),
				`// ${input.model}\n${"export {};\n".repeat(5 * n)}`,
			);
		}
		spend.set(cwd, Math.min(input.maxCostUsd ?? Number.POSITIVE_INFINITY, 0.04 * n));
		setTimeout(() => {
			const host = options.hosts.find(h => h.instanceId === instanceId);
			if (host) host.busy = false;
			options.onChange();
		}, WORK_MS);
		options.onChange();
		return instanceId;
	};

	const runsOf = (instanceId: string): RunInfo[] => {
		const passing = Number(instanceId.split("-")[1]) % 2 === 1;
		return [
			{
				runId: `run-${instanceId}`,
				instanceId,
				targetId: "package:test",
				command: "bun test",
				startedAt: Date.now() - 2_000,
				endedAt: Date.now() - 1_000,
				state: "exited",
				exitCode: passing ? 0 : 1,
				signal: null,
			},
		];
	};

	const group = (id: unknown): FanoutGroup => {
		const found = groups.find(g => g.id === id);
		if (!found) throw new Error("unknown group");
		return found;
	};

	return {
		capabilities: { canStart: true, canFanout: true },
		annotate(hosts) {
			const of: Record<string, HostFanout> = hostFanout(groups);
			return hosts.map(host =>
				Object.hasOwn(of, host.instanceId) ? { ...host, fanout: of[host.instanceId] } : host,
			);
		},
		handles: request =>
			request.t === "folders" || request.t.startsWith("fanout-") || (request.t === "link" && !!options.sessionLink),
		async answer(request) {
			switch (request.t) {
				case "link":
					return { t: "link", reqId: request.reqId, url: options.sessionLink ?? "" };
				case "folders":
					return {
						t: "folders",
						reqId: request.reqId,
						folders: [{ cwd: folder, lastActive: Date.now(), sessions: [] }],
					};
				case "fanout-models":
					return { t: "fanout-models", reqId: request.reqId, models: MODELS };
				case "fanout-start": {
					const parsed = parseFanoutRequest(request.request);
					const started = await startFanout(parsed, { worktreesDir: worktrees, launch });
					groups = withGroup(groups, started);
					options.onChange();
					return { t: "fanout-started", reqId: request.reqId, group: started };
				}
				case "fanout-compare":
					return {
						t: "fanout-compare",
						reqId: request.reqId,
						compare: await compareGroup(group(request.group), {
							hosts: () => options.hosts,
							cost: dir => spend.get(dir) ?? null,
							review: dir => gitReview(dir, false),
							runs: runsOf,
						}),
					};
				case "fanout-keep": {
					const keep = parseKeepRequest(request.request);
					const result = await keepRun(group(keep.group), keep, {
						worktreesDir: worktrees,
						hosts: async () => options.hosts,
						runningCwds: async () => options.hosts.map(h => h.cwd),
						dirty: async dir => {
							if (
								!(await fs.stat(dir).then(
									s => s.isDirectory(),
									() => false,
								))
							)
								return null;
							return (await sh(dir, "git", "status", "--porcelain=v1", "-uall")) !== "";
						},
						stop: async instanceId => {
							const at = options.hosts.findIndex(h => h.instanceId === instanceId);
							if (at >= 0) options.hosts.splice(at, 1);
						},
						sleep: async () => {},
					});
					options.onChange();
					return { t: "fanout-kept", reqId: request.reqId, result };
				}
				default:
					throw new Error(`the mock companion does not answer ${request.t}`);
			}
		},
	};
}
