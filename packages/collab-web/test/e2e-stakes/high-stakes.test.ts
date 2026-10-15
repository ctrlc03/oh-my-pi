import { afterAll, beforeAll, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { QuizAttempt } from "@oh-my-pi/pi-wire/quiz";
import { STAKES_STATE_DIR } from "@oh-my-pi/pi-wire/stakes";
import { answerQuiz, getQuiz, listQuizzes, retryQuiz } from "../../src/components/quiz/quiz-api";
import type { GuestClient } from "../../src/lib/client";
import type { CompanionHost } from "../../src/lib/companion";
import { PersonalHarness, until } from "../../scripts/e2e-personal-harness";
import { stubModelsYml } from "../../scripts/e2e-personal-stub";
import { SCENARIO_TIMEOUT_MS, describeE2e } from "../e2e-personal/support";

/**
 * The high-stakes scenario, end to end: the real companion, a real omp session in tmux (its command gate and watcher), the
 * quiz-writing session, and a scripted model. The remote is a bare repository on disk; nothing goes to GitHub.
 * Run with `bun run e2e:stakes`.
 */
describeE2e("a high-stakes session", () => {
	let h: PersonalHarness;
	let repo: string;
	let remote: string;
	let guest: GuestClient;
	let host: CompanionHost;
	let instanceId: string;

	const run = async (cwd: string, ...command: string[]): Promise<{ code: number; out: string }> => {
		const proc = Bun.spawn(command, {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				PATH: process.env.PATH ?? "",
				HOME: h.home,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t",
			},
		});
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, out: `${out}${err}`.trim() };
	};
	const git = async (...args: string[]): Promise<string> => {
		const { code, out } = await run(repo, "git", ...args);
		if (code !== 0) throw new Error(`git ${args.join(" ")}: ${out}`);
		return out;
	};
	const remoteHas = async (branch: string): Promise<boolean> =>
		(await run(remote, "git", "branch", "--list", branch)).out.includes(branch);
	const bash = (command: string) => ({ name: "bash", args: { command } });
	/** What the agent sees when it runs `command`. */
	const agentRuns = async (marker: string, ...commands: string[]): Promise<string[]> =>
		await h.toolsOnPrompt(guest, marker, commands.map(bash));

	/** Script the question-writing session: it writes `questions` to the file its prompt names. */
	const scriptQuizWriter = (cites: string[]): void => {
		const choice = (n: number, ref: string) => ({
			kind: "choice",
			topic: `Topic ${n}`,
			prompt: `Question ${n}: which one is right?`,
			reminder: "Read the cited code.",
			refs: [ref],
			choices: ["The right one", "A wrong one", "Another wrong one"],
			answer: "a",
			explanation: "The first one is right.",
		});
		const content = JSON.stringify({ parts: [{ part: 1, questions: cites.map((ref, i) => choice(i + 1, ref)) }] });
		h.stub.enqueue(
			request => {
				const target = /(\/\S*\/cache\/quizzes\/out\/\S+?\.json)/.exec(request.transcript)?.[1];
				if (!target) throw new Error("the quiz prompt names no output file");
				return { tools: [{ name: "write", args: { path: target, content } }] };
			},
			request =>
				request.transcript.includes("/cache/quizzes/out/") && request.messages.every(m => m.role !== "tool"),
		);
	};

	const stakes = () => h.client.stakesStatus(instanceId);

	/** Take the quiz `id` once with every answer wrong but the first `right` ones, then report the attempt. */
	const take = async (id: string, right: number, attempt = "a1"): Promise<QuizAttempt> => {
		const { quiz } = await getQuiz(h.client, id);
		let last: QuizAttempt | undefined;
		for (const [i, question] of quiz.questions.entries()) {
			const choices = question.choices ?? [];
			// The right choice is the one that reads "The right one": choice ids are shuffled by the companion.
			const good = choices.find(c => c.text === "The right one")!;
			const bad = choices.find(c => c.text !== "The right one")!;
			last = (await answerQuiz(h.client, id, attempt, question.id, { choice: (i < right ? good : bad).id })).attempt;
		}
		return last!;
	};

	beforeAll(async () => {
		// The setup wizard would wait for a sign-in the stub does not need.
		h = await PersonalHarness.start({
			defaultConfigYaml: "modelRoles:\n  default: stub/stub-model\nstartup:\n  setupWizard: false",
		});
		await Bun.write(path.join(h.configDir, "agent", "models.yml"), stubModelsYml(h.stub));
		repo = path.join(h.home, "work");
		remote = path.join(h.home, "remote.git");
		await fs.mkdir(repo, { recursive: true });
		await run(h.home, "git", "init", "-q", "--bare", "-b", "main", remote);
		await git("init", "-q", "-b", "main");
		await git("remote", "add", "origin", remote);
		await Bun.write(path.join(repo, "README.md"), "demo\n");
		await git("add", "-A");
		await git("commit", "-q", "-m", "init");
		await git("push", "-q", "origin", "main");
		await git("checkout", "-q", "-b", "feature");
		await fs.mkdir(path.join(repo, "src"), { recursive: true });
		await Bun.write(
			path.join(repo, "src/greet.ts"),
			"export function greet(name: string): string {\n\treturn `hello ${name}`;\n}\n\nexport const GREETING = 'hello';\n\nexport function shout(name: string): string {\n\treturn greet(name).toUpperCase();\n}\n",
		);
		await git("add", "-A");
		await git("commit", "-q", "-m", "greet");
		await until("the companion to advertise high stakes", () => h.client.getSnapshot().canHighStakes, {
			timeoutMs: 60_000,
		});
		scriptQuizWriter(["src/greet.ts@1@greet", "src/greet.ts@5@GREETING", "src/greet.ts@7@shout"]);
		instanceId = await h.client.startSession(repo, { highStakes: true });
		host = await until(
			"the session's host row",
			() => h.client.getSnapshot().hosts.find(candidate => candidate.instanceId === instanceId),
			{ timeoutMs: 90_000 },
		);
		guest = await h.openSession(host);
		// The session's watcher writes its "high-stakes mode is on" message within a few seconds; the first prompt takes it.
		await Bun.sleep(6_000);
	}, SCENARIO_TIMEOUT_MS);

	afterAll(async () => {
		await h?.stop();
	});

	it(
		"is high stakes from the first moment: the host row says so and the repository has the hook",
		async () => {
			expect(h.client.getSnapshot().hosts.find(candidate => candidate.instanceId === instanceId)?.highStakes).toBe(
				true,
			);
			expect(await Bun.file(path.join(repo, ".git/hooks/pre-push")).text()).toContain("omp-high-stakes-hook");
			const files = await fs.readdir(path.join(h.configDir, "agent", STAKES_STATE_DIR));
			expect(files).toContain("index");
			expect(await stakes()).toMatchObject({ on: true, covered: false, needs: "full", hook: "installed" });
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"refuses the agent's pushes and pull requests in every spelling, and tells it to ask the user",
		async () => {
			const commands = [
				"git push origin feature",
				"git -C . push origin feature",
				"git -c push.default=current push",
				"git push --no-verify origin feature",
				"git config alias.p push && git p origin feature",
				"gh pr create --title t --body b",
				"gh pr merge 1",
				"gh api -X POST repos/o/r/pulls -f title=t",
			];
			const results: string[] = [];
			for (const [i, command] of commands.entries()) {
				const [result] = await agentRuns(`STAKES-AGENT-PUSH-${i}`, command);
				results.push(`${command} => ${result}`);
			}
			for (const result of results) {
				expect(result).toContain("high-stakes session");
				expect(result).toContain("Ask the user");
			}
			expect(await remoteHas("feature")).toBe(false);
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"stops a client the gate cannot see (a push from outside omp) at the pre-push hook",
		async () => {
			const refused = await run(repo, "git", "push", "origin", "feature");
			expect(refused.code).not.toBe(0);
			expect(refused.out).toContain("quiz");
			expect(await remoteHas("feature")).toBe(false);
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"refuses the app's own push and pull request, with the same reason",
		async () => {
			await expect(h.client.pushBranch(instanceId)).rejects.toThrow(/high stakes/);
			await expect(h.client.createPullRequest(instanceId, "t", "b")).rejects.toThrow();
			expect(await remoteHas("feature")).toBe(false);
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"does not let a 66% quiz unlock the push, but a full-marks attempt does",
		async () => {
			const made = await h.client.stakesQuiz(instanceId);
			expect(made).toMatchObject({ created: true, delta: false });
			await until(
				"the quiz to be written",
				async () => (await listQuizzes(h.client)).find(quiz => quiz.id === made.id)?.status === "ready",
				{ timeoutMs: 180_000, everyMs: 500 },
			);
			expect(await h.client.stakesQuiz(instanceId)).toEqual({ id: made.id, delta: false, created: false });
			const failed = await take(made.id, 2);
			expect(failed.score.points).toBeLessThan(failed.score.total);
			expect(await stakes()).toMatchObject({ covered: false });
			await expect(h.client.pushBranch(instanceId)).rejects.toThrow();
			const retry = await retryQuiz(h.client, made.id, "all");
			await take(made.id, 3, retry.id);
			expect(await stakes()).toMatchObject({ covered: true, coveredBy: "pass", passed: { delta: false } });
			expect((await getQuiz(h.client, made.id)).stakes?.passedAttempt).toBe(retry.id);
			await h.client.pushBranch(instanceId);
			expect(await remoteHas("feature")).toBe(true);
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"lets the agent push what the passed quiz covered",
		async () => {
			const [result] = await agentRuns("STAKES-AGENT-COVERED", "git push origin feature:covered && echo PUSHED");
			expect(result).toContain("PUSHED");
			expect(await remoteHas("covered")).toBe(true);
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"needs a quiz on only the new changes after the passed diff, and commits that add nothing need none",
		async () => {
			await git("commit", "-q", "--allow-empty", "-m", "no change");
			expect(await stakes()).toMatchObject({ covered: true });
			await Bun.write(
				path.join(repo, "src/bye.ts"),
				"export function bye(name: string): string {\n\treturn `bye ${name}`;\n}\n",
			);
			await git("add", "-A");
			await git("commit", "-q", "-m", "bye");
			const [refused] = await agentRuns("STAKES-AGENT-STALE", "git push origin feature");
			expect(refused).toContain("since the last passed quiz");
			expect(await stakes()).toMatchObject({ covered: false, needs: "delta" });
			scriptQuizWriter(["src/bye.ts@1@bye", "src/bye.ts@2@bye"]);
			const made = await h.client.stakesQuiz(instanceId);
			expect(made.delta).toBe(true);
			await until(
				"the delta quiz to be written",
				async () => (await listQuizzes(h.client)).find(quiz => quiz.id === made.id)?.status === "ready",
				{ timeoutMs: 180_000, everyMs: 500 },
			);
			// Only the new file was handed to the question writer.
			const brief = h.stub.requests.findLast(request => request.transcript.includes("src/bye.ts"))!;
			expect(brief.transcript).not.toContain("src/greet.ts (added)");
			// With a quarter design and understanding questions about those changes mixed in.
			expect(brief.transcript).toContain("about a quarter (25 %)");
			expect(brief.transcript).toContain("the new changes only");
			await take(made.id, 2);
			expect(await stakes()).toMatchObject({ covered: true, passed: { delta: true } });
			await h.client.pushBranch(instanceId);
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"asks before it is turned off, and leaves a marker in the session when it is",
		async () => {
			await expect(h.client.setHighStakes(instanceId, false)).rejects.toThrow(/confirmation/);
			expect((await stakes()).on).toBe(true);
			await h.client.setHighStakes(instanceId, false, { confirmOff: true });
			expect((await stakes()).on).toBe(false);
			expect(await Bun.file(path.join(repo, ".git/hooks/pre-push")).exists()).toBe(false);
			await until(
				"the session to record that high stakes is off",
				() =>
					guest
						.getSnapshot()
						.entries.some(
							entry =>
								entry.type === "custom_message" &&
								entry.customType === "high-stakes" &&
								JSON.stringify(entry).includes("off"),
						),
				{ timeoutMs: 30_000, everyMs: 500 },
			);
			await Bun.write(path.join(repo, "free.txt"), "free\n");
			await git("add", "-A");
			await git("commit", "-q", "-m", "free");
			const [pushed] = await agentRuns("STAKES-AGENT-FREE", "git push origin feature:free && echo FREE-PUSHED");
			expect(pushed).toContain("FREE-PUSHED");
		},
		SCENARIO_TIMEOUT_MS,
	);
});
