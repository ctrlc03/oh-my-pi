/**
 * The `pre-push` hook of high-stakes sessions (./companion-stakes): a small POSIX shell script the companion puts in a
 * repository's hooks folder while a session in it is high stakes. It runs in whatever process pushes, asks the
 * companion over its loopback server whether the tree of every pushed commit is covered, and falls back to the state
 * files the companion keeps when the companion cannot be reached. It never installs into a repository whose
 * `core.hooksPath` is set (the hooks there belong to a tool such as husky), and a `pre-push` hook of the user's own is
 * moved to `pre-push.omp-orig` and still runs after ours.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { STAKES_IPC_FILE, STAKES_PRE_PUSH_PATH, STAKES_STATE_DIR } from "@oh-my-pi/pi-wire/stakes";
import { git } from "./companion-git";

/** First line after the shebang: how the companion recognises its own hook. */
export const HOOK_MARKER = "# omp-high-stakes-hook v1";
const ORIGINAL_SUFFIX = ".omp-orig";
/** Index of the state files: `<key><TAB><checkout>` lines, so the hook can find its checkout's file without hashing. */
export const STAKES_INDEX_FILE = "index";

const decoder = new TextDecoder();

/** The hook script for the agent directory `agentDir`. */
export function hookScript(agentDir: string): string {
	const quoted = `'${agentDir.replaceAll("'", `'\\''`)}'`;
	return `#!/bin/sh
${HOOK_MARKER}
# Managed by the omp collab companion while a session in this repository is high stakes: a push needs a passed quiz.
# The companion puts this file back if it is changed; turn the mode off in the app to remove it.
agent_dir=${quoted}
ipc="$agent_dir/${STAKES_IPC_FILE}"
state_dir="$agent_dir/${STAKES_STATE_DIR}"
tmp=$(mktemp 2>/dev/null || echo "\${TMPDIR:-/tmp}/omp-stakes.$$")
trap 'rm -f "$tmp"' EXIT
cat > "$tmp"
zero=0000000000000000000000000000000000000000000000000000000000000000
shas=""
while read -r _lref lsha _rref _rsha; do
	[ -z "$lsha" ] && continue
	case "$zero" in "$lsha"*) continue ;; esac
	shas="$shas$lsha
"
done < "$tmp"
chain() {
	orig="$(dirname "$0")/pre-push${ORIGINAL_SUFFIX}"
	if [ -x "$orig" ]; then "$orig" "$@" < "$tmp" || exit $?; fi
}
if [ -z "$shas" ]; then chain "$@"; exit 0; fi
top=$(git rev-parse --show-toplevel 2>/dev/null) || top=$(pwd)
reply=""
if [ -r "$ipc" ]; then
	port=$(sed -n 's/.*"port":\\([0-9][0-9]*\\).*/\\1/p' "$ipc")
	token=$(sed -n 's/.*"token":"\\([^"]*\\)".*/\\1/p' "$ipc")
	reply=$(printf '%s\\n%s' "$top" "$shas" | curl -sS --max-time 40 -H "Authorization: Bearer $token" -H 'Content-Type: text/plain' --data-binary @- "http://127.0.0.1:$port${STAKES_PRE_PUSH_PATH}" 2>/dev/null) || reply=""
fi
case "$reply" in
	allow*) chain "$@"; exit 0 ;;
	deny*)
		printf '%s\\n' "$reply" | sed '1d' >&2
		exit 1
		;;
esac
# The companion did not answer: go by the state file it keeps for this checkout.
key=""
[ -r "$state_dir/${STAKES_INDEX_FILE}" ] && key=$(awk -F '\\t' -v p="$top" '$2 == p { print $1; exit }' "$state_dir/${STAKES_INDEX_FILE}")
file="$state_dir/$key"
if [ -z "$key" ] || [ ! -r "$file" ] || ! grep -qx 'mode on' "$file"; then chain "$@"; exit 0; fi
for sha in $shas; do
	tree=$(git rev-parse --verify --quiet "$sha^{tree}") || tree=""
	if [ -z "$tree" ] || ! grep -qx "tree $tree" "$file"; then
		echo "Blocked: this is a high-stakes session and the omp collab companion cannot be reached to check the quiz, and $sha is not known to be covered by a passed quiz. Start the companion, or pass the quiz in the collab app, then push again." >&2
		exit 1
	fi
done
chain "$@"
exit 0
`;
}

/** What a repository's hook looks like to the companion. */
export type HookState = "installed" | "missing" | "unavailable";

export interface HookStatus {
	state: HookState;
	/** Why it is `unavailable`. */
	note?: string;
}

async function hooksDir(root: string): Promise<{ dir: string } | { note: string }> {
	const custom = await git(root, ["config", "--get", "core.hooksPath"]);
	if (custom.code === 0 && decoder.decode(custom.out).trim() !== "")
		return { note: "This repository sets core.hooksPath, so its hooks belong to another tool and are left alone." };
	const result = await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
	const dir = decoder.decode(result.out).trim();
	if (result.code !== 0 || dir === "") return { note: "The repository's hooks folder could not be found." };
	return { dir };
}

async function readText(file: string): Promise<string | null> {
	return await fs.readFile(file, "utf8").catch(() => null);
}

/** Whether our hook is in place in the repository whose primary checkout is `root`. */
export async function hookStatus(root: string, agentDir: string): Promise<HookStatus> {
	const where = await hooksDir(root);
	if ("note" in where) return { state: "unavailable", note: where.note };
	const text = await readText(path.join(where.dir, "pre-push"));
	return { state: text === hookScript(agentDir) ? "installed" : "missing" };
}

/** Put our hook in place, moving a hook of the user's aside; a no-op when it is already ours and current. */
export async function installHook(root: string, agentDir: string): Promise<HookStatus> {
	const where = await hooksDir(root);
	if ("note" in where) return { state: "unavailable", note: where.note };
	const file = path.join(where.dir, "pre-push");
	const wanted = hookScript(agentDir);
	const current = await readText(file);
	if (current === wanted) return { state: "installed" };
	await fs.mkdir(where.dir, { recursive: true });
	if (current !== null && !current.includes(HOOK_MARKER)) {
		const orig = `${file}${ORIGINAL_SUFFIX}`;
		if ((await readText(orig)) === null) await fs.rename(file, orig);
	}
	const temp = `${file}.${process.pid}.tmp`;
	await fs.writeFile(temp, wanted, { mode: 0o755 });
	await fs.chmod(temp, 0o755);
	await fs.rename(temp, file);
	return { state: "installed" };
}

/** Take our hook out and put the user's own back; leaves a hook that is not ours alone. */
export async function removeHook(root: string): Promise<void> {
	const where = await hooksDir(root);
	if ("note" in where) return;
	const file = path.join(where.dir, "pre-push");
	const current = await readText(file);
	if (current === null || !current.includes(HOOK_MARKER)) return;
	const orig = `${file}${ORIGINAL_SUFFIX}`;
	if ((await readText(orig)) !== null) await fs.rename(orig, file);
	else await fs.rm(file, { force: true });
}
