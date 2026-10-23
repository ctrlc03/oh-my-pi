# Shell sandbox

An OS-level sandbox for the commands the agent runs through `bash`. It is **off by default**. With it on, a command that misbehaves (or is steered by a prompt injection) cannot write outside the project, read your credentials, or reach the network, whatever the approval mode says. It complements [approval mode](./approval-mode.md): approvals decide whether a call runs, the sandbox bounds what it can do once it runs.

## Settings

| Setting | Default | Description |
| ------- | ------- | ----------- |
| `sandbox.mode` | `off` | `off`: no sandbox. `workspace-write`: write only the workspace (see below), read everywhere except secrets. `read-only`: write only to temp directories. |
| `sandbox.network` | `off` | `on` lets sandboxed commands use the network. With `off`, outbound network (including loopback) is blocked. YAML booleans work (`false` is `off`). |
| `sandbox.failOpen` | `false` | When the sandbox cannot start (no `sandbox-exec`, no `bwrap`), `false` refuses to run the command with a clear error; `true` runs it unsandboxed and says so in the output. |
| `sandbox.autoEscalate` | `false` | `true` lets the agent's [escalation requests](#escalation) run without a prompt. Off, they always prompt, even in `yolo` mode. |

The settings are in the **Sandbox** group of the `/settings` Interaction tab. `/sandbox` changes the mode and network for the current session only.

A repository's own config (`<project>/.omp/config.yml` and the other project layers) can only make the sandbox **stricter**: a project value looser than your user-level one (`mode: off`, `network: on`, `failOpen: true`, `autoEscalate: true`) is ignored, so a cloned repo cannot switch your sandbox off. Set the loosening values in your user config or per session.

## What a sandboxed command may do

**Writes (`workspace-write`)**

- the session's working directory and the repository root it is in (for a git worktree, also its git directory and the common directory). A root that is, or contains, your home directory or `/` is never made writable (shell startup files and launch agents would be exposed): starting omp in `~` leaves the sandbox read-only apart from temp directories and caches;
- the session's additional directories (`--add-dir` / the session's workspace roots);
- temp directories (`$TMPDIR`, `/tmp`, `/var/folders/…`);
- tool caches under your home directory: `~/.cache`, `~/Library/Caches`, `~/.bun/install`, `~/.npm`, `~/.yarn`, `~/.pnpm-store`, `~/.local/share/pnpm`, `~/.cargo/registry`, `~/.cargo/git`, `~/go/pkg`, `~/.gradle`, `~/.m2/repository`, `~/.nuget/packages`, `~/.node-gyp`.

`read-only` allows temp directories only.

**Reads**: everywhere except

- credentials in your home directory: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.azure`, `~/.kube`, `~/.config/gcloud`, `~/.config/gh`, `~/.docker/config.json`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, `~/Library/Keychains` and `/Library/Keychains`;
- omp's credential database (`agent.db`);
- the VM root (`~/.omp/agent/vm`, or `OMP_VM_ROOT`): the GitHub App private key and the VMs' SSH keys of [VM sessions](./vm-sessions.md). It is neither readable nor writable in any mode;
- paths a `tools.pathRules` `deny` rule covers for reading (a deny that covers only writes makes the path read-only). `allow` and `prompt` rules are not translated. See [path rules](./approval-mode.md#path-rules).

**Read-only even inside a writable root**, so a sandboxed command cannot plant code or settings that later run outside the sandbox:

- the harness agent directory (`~/.omp/agent`, or `PI_CODING_AGENT_DIR`) is read-only in every mode, whatever the cwd, including project approval grants stored there;
- git state: `.git` entries can be neither created, renamed nor removed (a repo cannot be swapped for one with a hostile config), and `hooks`, `config` and `config.worktree` of every `.git` are read-only, including nested clones and submodule gitdirs under `.git/modules`; a worktree's gitdir and the common dir get the same. Commits, branches, fetches into existing repos and the index keep working; `git init`, `git clone` into the workspace and `git config`/`git remote add` need an escalation;
- the harness and tool config entries `.omp`, `.pi`, `.claude`, `.codex`, `.gemini`, `.cursor`, `.mcp.json` (plus the configured config directory name).

The companion's state files (`<agent dir>/collab-companion*`, including the schedule IPC token) are unreadable inside the sandbox.

**Network**: blocked unless `sandbox.network: on` or the call is escalated. Name resolution fails with the network off, so `curl` reports `Could not resolve host`.

A denied command fails with the shell's own message (`Operation not permitted`), followed by a note naming the active policy and the `escalate` parameter.

## Escalation

While the sandbox is on, the `bash` tool has two extra parameters:

- `escalate`: `network` (run this one command with network access) or `full` (run it with no sandbox);
- `justification`: why, shown in the prompt. A call with `escalate` and no justification is refused.

An escalation always goes through the approval prompt, **including in `yolo` mode**, and saved "Always allow" grants do not answer it. With `sandbox.autoEscalate: true` it runs without a prompt (still subject to `bash.patterns` and `tools.approval` deny rules). With the sandbox off the parameters are not offered.

## Backends

| Platform | Backend | Notes |
| -------- | ------- | ----- |
| macOS | Seatbelt: `/usr/bin/sandbox-exec` with a generated SBPL profile | Used and tested here. `tools.pathRules` globs become regular-expression rules. |
| Linux | bubblewrap (`bwrap` on `PATH`) | Read-only root bind, writable binds for the roots above, `--unshare-net` with the network off, `--unshare-pid`, `--new-session` (not for PTY and client-terminal commands, which keep their terminal), secrets masked. Protected paths that do not exist yet (`.omp`, `.mcp.json`, …) are mounted over empty placeholders that bubblewrap creates on the host and omp removes after the command when still empty. Nested `.git` directories are found within 4 levels (4000 directories) under the workspace roots. Not exercised on a Linux host yet; regex-based `tools.pathRules` denies are not enforced there. |
| Windows | none | The sandbox is unavailable: commands are refused unless `sandbox.failOpen` is set. |

The command is wrapped inside omp's shell executor, so everything that goes through it is sandboxed: the agent's `bash` tool (embedded shell, PTY, ACP terminal and launch-service backends), `!cmd` and `!!cmd` in the editor, `verify.command`, loop conditions, ``!`cmd` `` expansion in markdown commands, and autoresearch.

## Limits

- **Shell state does not persist.** Each sandboxed command is a fresh process, so `cd` and `export` do not carry over to the next call. Use absolute paths or one command line.
- **Not sandboxed:** the `eval` kernels (Python and JavaScript), the `debug` tool, MCP and LSP servers, hooks and the browser. While the sandbox is on, `eval` prompts before every run (even in `yolo`), unless `sandbox.autoEscalate` is true.
- Internal URLs (`skill://`, `artifact://`, …) inside a command line are not expanded when the sandbox is on, and a URL working directory is refused.
- Loopback is blocked with the network off, so a command that starts a server and connects to it needs `sandbox.network: on`.
- `tools.pathRules` globs are matched case-sensitively by the sandbox, so write them with the exact case of the path.
- It is a defense for accidents and prompt injection, not a hardened isolation boundary against code deliberately trying to escape.

## `/sandbox`

```
/sandbox                          show the policy, backend and escalation status
/sandbox off | read-only | workspace-write
/sandbox network on | off
```

Changes apply to the session (a runtime override), not to your settings files. A guest in a collab room cannot run it. The model sees the active policy in a short `<sandbox>` section of its system prompt, refreshed when you change it.

## Profiles

An [agent profile](./profiles.md) can set `sandbox: off | read-only | workspace-write`. The stricter of the profile's and the session's mode applies, so a profile never turns the sandbox down. A switch to a profile with a looser `sandbox` counts as loosening for collab guests.
