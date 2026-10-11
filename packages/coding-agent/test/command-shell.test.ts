import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	CommandShellExpansion,
	type ShellExpansionMode,
	resolveShellExpansionMode,
} from "@oh-my-pi/pi-coding-agent/config/command-shell";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { expandPromptTemplate, type PromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import { cfgCommandsShellExpansion } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { expandSlashCommand, type FileSlashCommand } from "@oh-my-pi/pi-coding-agent/extensibility/slash-commands";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("shell output in markdown commands", () => {
	let tempDir: TempDir;

	beforeAll(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-command-shell-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
	});

	afterAll(() => {
		tempDir.removeSync();
		resetSettingsForTest();
	});

	function command(content: string, level: "user" | "project" | "native" | undefined = "user"): FileSlashCommand {
		return {
			name: "cmd",
			description: "",
			content,
			source: "test",
			...(level ? { _source: { provider: "claude", providerName: "test", level } } : {}),
		};
	}

	function shellFor(mode: ShellExpansionMode, timeoutMs = 30_000): CommandShellExpansion {
		return new CommandShellExpansion({
			mode,
			cwd: tempDir.path(),
			timeoutMs,
			sessionKey: "command-shell-test",
		});
	}

	async function run(
		invocation: string,
		file: FileSlashCommand,
		mode: ShellExpansionMode = "user",
		timeoutMs?: number,
	): Promise<{ text: string; shell: CommandShellExpansion }> {
		const shell = shellFor(mode, timeoutMs);
		const text = await shell.resolve(expandSlashCommand(invocation, [file], shell));
		return { text, shell };
	}

	it("replaces a snippet with the command's output, run in the session cwd", async () => {
		const { text, shell } = await run("/cmd", command("Here: !`pwd` done"));
		expect(fs.realpathSync(text.replace(/^Here: /, "").replace(/ done$/, ""))).toBe(fs.realpathSync(tempDir.path()));
		expect(shell.notices().map(notice => notice.level)).toEqual(["info"]);
		expect(shell.notices()[0]?.message).toContain("pwd");
	});

	it("expands several snippets and leaves the surrounding text alone", async () => {
		const { text } = await run("/cmd", command("a !`echo one` b !`echo two` c"));
		expect(text).toBe("a one b two c");
	});

	it("shell-quotes arguments so they cannot inject commands", async () => {
		const marker = path.join(tempDir.path(), "pwned");
		const hostile = `x'; touch ${marker}; echo '`;
		const { text } = await run(`/cmd "${hostile}"`, command("!`printf %s $1`"));
		expect(text).toBe(hostile);
		expect(fs.existsSync(marker)).toBe(false);

		const all = await run(`/cmd a "b c" '$(touch' ${marker}')'`, command("!`printf '[%s]' $ARGUMENTS`"));
		expect(all.text).toBe(`[a][b c][$(touch][${marker})]`);
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("escapes arguments for the quotes the template author wrote around them", async () => {
		const marker = path.join(tempDir.path(), "quoted");
		const single = `a'b$HOME\`touch ${marker}\`\\d`;
		const inSingle = await run(`/cmd "${single}"`, command("!`printf %s '$1'`"));
		expect(inSingle.text).toBe(single);
		const double = `a"b$HOME\`touch ${marker}\`\\d`;
		const inDouble = await run(`/cmd '${double}'`, command('!`printf %s "$1"`'));
		expect(inDouble.text).toBe(double);
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("never lets an argument become shell source, whatever quoting it lands in", async () => {
		const marker = path.join(tempDir.path(), "nested");
		const hostile = `x"; touch ${marker}; echo "`;
		const cases = [
			'!`echo "$(printf %s $1)"`',
			'!`echo "$(printf %s "$1")"`',
			"!`echo \"$(printf %s '$1')\"`",
			"!`cat <<EOF\n$1\nEOF`",
			"!`cat <<EOF\n$(printf %s $1)\nEOF`",
			"!`printf %s $1`",
		];
		for (const body of cases) {
			await run(`/cmd '${hostile}'`, command(body));
			expect(fs.existsSync(marker)).toBe(false);
		}
		// A heredoc body is not a quoting context the scan knows, so the reference keeps its bare-word quotes there.
		const heredoc = await run(`/cmd '${hostile}'`, command("!`cat <<EOF\n$1\nEOF`"));
		expect(heredoc.text).toContain(hostile);
		const nested = await run(`/cmd '${hostile}'`, command('!`echo "$(printf %s $1)"`'));
		expect(nested.text).toBe(hostile);
	});

	it("does not run snippets smuggled in through arguments or re-render command output", async () => {
		const marker = path.join(tempDir.path(), "smuggled");
		const { text } = await run(
			`/cmd "!\`touch ${marker}\`"`,
			command("Args: $ARGUMENTS\nOut: !`printf '{{args}} #'`"),
		);
		expect(fs.existsSync(marker)).toBe(false);
		expect(text).toContain("Out: {{args}} #");
		expect(text).toContain(`Args: !\`touch ${marker}\``);
	});

	it("inserts error text for a failing command, with its output", async () => {
		const { text } = await run("/cmd", command("before !`echo oops; exit 3` after"));
		expect(text).toContain("Error running `echo oops; exit 3`: exited with code 3");
		expect(text).toContain("oops");
		expect(text.startsWith("before ")).toBe(true);
		expect(text.endsWith(" after")).toBe(true);
	});

	it("inserts error text when a command times out", async () => {
		const started = Date.now();
		const { text } = await run("/cmd", command("!`sleep 20`"), "user", 300);
		expect(text).toContain("timed out after 300ms");
		expect(Date.now() - started).toBeLessThan(15_000);
	});

	it("caps very long output", async () => {
		const { text } = await run("/cmd", command("!`yes line | head -n 20000`"));
		expect(text.length).toBeLessThan(20_100);
		expect(text).toContain("output truncated");
	});

	describe("gate by command source", () => {
		const marker = () => path.join(tempDir.path(), "ran");

		it("user mode runs user commands but leaves project commands untouched", async () => {
			const body = () => `!\`touch ${marker()} && echo ran\``;
			const user = await run("/cmd", command(body(), "user"), "user");
			expect(user.text).toBe("ran");
			fs.rmSync(marker(), { force: true });

			const project = await run("/cmd", command(body(), "project"), "user");
			expect(project.text).toBe(body());
			expect(fs.existsSync(marker())).toBe(false);
			const [notice] = project.shell.notices();
			expect(notice?.level).toBe("warning");
			expect(notice?.message).toContain("/cmd");
		});

		it("all mode runs project commands", async () => {
			const { text } = await run("/cmd", command("!`echo from-project`", "project"), "all");
			expect(text).toBe("from-project");
		});

		it("off mode runs nothing", async () => {
			const user = await run("/cmd", command("!`echo hi`", "user"), "off");
			expect(user.text).toBe("!`echo hi`");
		});

		it("bundled commands without a source level count as user commands", async () => {
			const { text } = await run("/cmd", command("!`echo bundled`", undefined), "user");
			expect(text).toBe("bundled");
		});

		it("treats plugin-supplied commands like project commands, even at user level", async () => {
			for (const provider of ["claude-plugins", "omp-plugins"]) {
				const plugin: FileSlashCommand = {
					...command("!`echo plugin`"),
					_source: { provider, providerName: provider, level: "user" },
				};
				const gated = await run("/cmd", plugin, "user");
				expect(gated.text).toBe("!`echo plugin`");
				expect(gated.shell.notices()[0]?.level).toBe("warning");
				expect((await run("/cmd", plugin, "all")).text).toBe("plugin");
			}
		});

		it("applies to prompt templates by their directory", async () => {
			const template = (source: string): PromptTemplate => ({
				name: "tpl",
				description: "",
				content: "!`echo tpl`",
				source,
			});
			const user = shellFor("user");
			expect(await user.resolve(expandPromptTemplate("/tpl", [template("(user)")], user))).toBe("tpl");
			const project = shellFor("user");
			expect(await project.resolve(expandPromptTemplate("/tpl", [template("(project:frontend)")], project))).toBe(
				"!`echo tpl`",
			);
		});
	});

	it("leaves snippets as written when no expansion is passed", () => {
		expect(expandSlashCommand("/cmd", [command("!`echo hi`")])).toBe("!`echo hi`");
	});
});

describe("commands.shellExpansion setting", () => {
	it("defaults to user", () => {
		expect(resolveShellExpansionMode(Settings.isolated())).toBe("user");
	});

	it("honors runtime and user-level values", () => {
		expect(resolveShellExpansionMode(Settings.isolated({ "commands.shellExpansion": "all" }))).toBe("all");
	});

	it("ignores a project layer that tries to enable itself", async () => {
		using root = TempDir.createSync("@pi-command-shell-mode-");
		const agentDir = path.join(root.path(), "agent");
		const cwd = path.join(root.path(), "repo");
		await Bun.write(path.join(cwd, ".omp/config.yml"), "commands:\n  shellExpansion: all\n");
		const settings = await Settings.loadIsolated({ cwd, agentDir });
		expect(settings.getProvenance(cfgCommandsShellExpansion)).toBe("project");
		expect(resolveShellExpansionMode(settings)).toBe("user");
	});

	it("keeps the user-level value when the project layer also sets one", async () => {
		using root = TempDir.createSync("@pi-command-shell-mode-");
		const agentDir = path.join(root.path(), "agent");
		const cwd = path.join(root.path(), "repo");
		await Bun.write(path.join(agentDir, "config.yml"), "commands:\n  shellExpansion: off\n");
		await Bun.write(path.join(cwd, ".omp/config.yml"), "commands:\n  shellExpansion: all\n");
		const settings = await Settings.loadIsolated({ cwd, agentDir });
		expect(resolveShellExpansionMode(settings)).toBe("off");
	});
});
