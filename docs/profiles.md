# Agent profiles

An agent profile is a named bundle of session behaviour you switch with one command or key, in the spirit of OpenCode's Plan and Build agents: a read-only reviewer, a docs-only editor, a "no network" profile, and so on. A profile can set:

- a tool allowlist (`tools`) and/or denylist (`disabledTools`)
- `approvalMode` and per-tool `approval` policies (see [Tool approval mode](./approval-mode.md))
- `pathRules` and `outsideProject` (see [Path rules](./approval-mode.md#path-rules))
- a `model` (or role alias such as `@smol`) and a `thinking` level
- an extra system-prompt section (`prompt`)

> Not to be confused with the CLI's `--profile <name>`, which selects an isolated config directory. Agent profiles live inside one session and change nothing on disk.

## Built-in profiles

| Name     | Effect |
| -------- | ------ |
| `build`  | The default. Changes nothing: the session's own tools, approval, model and prompt apply. |
| `review` | Read-only tools (`read`, `grep`, `find`, `glob`, `ast_grep`, `lsp`, `web_search`, `trace`, `flow`, `recall`, `todo`, `ask`, `wait`, `think`), `edit`/`write`/`ast_edit`/`bash`/`eval`/`task`/`github` denied by `tools.approval`, `lsp` limited to read actions (`lspReadOnly`), and a prompt asking for a code review that reports findings without editing. |

`yield` is never filtered out, so a subagent-style completion path is always available.

## Defining profiles

Profiles come from four places; a later one replaces an earlier one of the same name (names are case-insensitive):

1. the built-ins
2. `~/.omp/agent/profiles/*.md`
3. the `profiles` setting (`profiles.<name>` in `config.yml`)
4. `<project>/.omp/profiles/*.md` (nearest `.omp`), which **cannot** replace a built-in name, so a repository cannot redefine `build` or `review`

Markdown files take the file name as the profile name; the front matter holds the fields and the body is the prompt section:

```markdown
---
description: Documentation only
tools: [read, grep, find, edit, write]
approvalMode: write
approval:
  bash: deny
pathRules:
  - glob: "docs/**"
    action: allow
  - glob: "**"
    tools: [edit, write]
    action: deny
model: "@smol"
thinking: low
---
You are updating documentation. Do not change source code.
```

The same fields work under `profiles.<name>` (with `prompt:` for the text). Invalid fields are dropped with a warning that `/profile` lists; the rest of the profile still applies.

| Field | Meaning |
| ----- | ------- |
| `description` | Shown in pickers. |
| `tools` | Allowlist of tool names. Omitted: no allowlist. |
| `disabledTools` | Tools removed from the active set, applied after `tools`. |
| `approvalMode` | `always-ask`, `always-ask-cached`, `write` or `yolo`. Replaces `tools.approvalMode` while active, except that it never loosens a CLI `--approval-mode`/`--yolo` or the mode under a repository-supplied profile (see below). |
| `approval` | `tool: allow \| prompt \| deny`, laid over `tools.approval` per tool. |
| `pathRules` | Same shape as `tools.pathRules`. |
| `lspReadOnly` | `true` limits the `lsp` tool to navigation and diagnostics (no `rename`, `rename_file` or applied `code_actions`) while active. `review` sets it. |
| `outsideProject` | `allow`, `prompt` or `deny`; the stricter of this and `tools.outsideProject` applies. |
| `sandbox` | `off`, `workspace-write` or `read-only`; the stricter of this and `sandbox.mode` applies (a profile never turns the [shell sandbox](./sandbox.md) down). |
| `model` | Model selector, optionally `:level`; applied when you switch to the profile. |
| `thinking` | Thinking level (`thinkingLevel` also works). |
| `prompt` | Extra system-prompt section (the body of a markdown profile). |

## Permissions only ever tighten

A profile may restrict the session and may allow what the session leaves open, but it never lifts a `deny` you configured. Those apply under every profile:

- `tools.approval`: a tool the session denies stays denied even if the profile says `allow`; other keys are overridden per tool.
- `tools.pathRules`: the profile's `deny` rules are checked first; the session's rules follow up to and including its last `deny`; then the profile's `prompt` rules, then its `allow` rules; then the rest. So neither a profile `prompt` nor a profile `allow` can shadow a configured `deny`. With `tools.outsideProject: deny`, a profile `allow` rule is ignored (an allowing rule exempts a path from that check).
- `tools.outsideProject`: the stricter value wins.
- `tools.approvalMode`: a mode set by a CLI flag (`--approval-mode`, `--yolo`) is a floor, and so is your configured mode under a profile that a repository supplies (a `.omp/profiles/*.md` file, `profiles` in project settings, or a `profile.default` set by project settings). The stricter of the two applies (`always-ask` over `always-ask-cached` over `write` over `yolo`; `always-ask-cached` ranks below `always-ask` because its remembered grants let later writes through unasked). Profiles you define yourself replace a configured (non-CLI) mode freely.
- `bash.patterns` is never touched by profiles.

While a profile with `approvalMode`, `approval`, `pathRules` or `outsideProject` is active, edits you make to those settings elsewhere are shadowed until the next switch.

## Switching

- `/profile` lists the profiles (the active one is marked, plus any load warnings); `/profile <name>` switches. Completion offers the names.
- `app.profile.cycle` (default `Alt+O`) cycles to the next profile in list order. Rebind it in `keybindings.yml` ([Keybindings](./keybindings.md)).
- The status line's `mode` segment shows the active profile when it is not `build`.
- The choice is saved in the session and restored on resume, branch navigation and `/new`; a new session starts in `profile.default` (default: `build`).
- A switch while the agent is working is queued and applies when the turn ends; `/profile` then shows the queued name.
- A switch is refused while plan, goal or vibe mode is active: those modes own the tool set. Exit them first.
- Switching to a profile with a `model` changes the session model; switching to a profile without one puts back the model and thinking level the session had before, unless you changed them yourself in between. After a resume the original is not remembered, so switching back to `build` does not revert the model.

## Relationship to plan mode

Plan mode is unchanged and independent: it is a workflow (explore, write a plan, get it approved) with its own tool restrictions. A profile is a standing configuration. They do not combine; plan mode must be off to switch profiles, and a profile does not enter plan mode. Use `review` when you want a read-only session without the plan-and-approve flow.

## Collab

A host advertises the `profiles` feature in `welcome.features`. Writers receive the profile list in `welcome.profiles` and the active name in `state.profile`, and switch with `session-cmd` `profile` (`arg` is the name); view-only guests get no list and are refused like for other session controls. The web app shows a profile pill next to the model pills. A switch the host would refuse (unknown name, plan/goal/vibe mode) comes back as an `error`.

A guest may only **tighten** the host's profile. A switch to a profile that is less strict than the active one (a looser approval mode, tools the active profile does not enable, a per-tool `allow` or an `allow` path rule it lacks, a dropped `deny`/`prompt` path rule, a looser `outsideProject` or `sandbox`, or LSP edit actions the active profile blocks) is refused with an `error` naming the reason. The host can still switch to any profile from its own TUI. See [Collab](./collab.md).

## Settings

| Setting | Default | Description |
| ------- | ------- | ----------- |
| `profiles` | `{}` | Profile definitions by name (see above). |
| `profile.default` | unset | Profile a session starts in until it switches. Unset starts in `build`. |

## Limits

- `review` has no `bash`; define your own profile if you want a read-only profile with a safe command allowlist (for example `approval` with `bash: prompt`, plus `bash.patterns`).
- Definitions are re-read on every lookup, so edits to a profile file apply on the next switch, not to the active one.
- Tools added later (MCP servers, tool discovery) obey the active profile's allowlist and denylist.
