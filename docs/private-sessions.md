# Private sessions

A private session guarantees that **no model request leaves the machine** for a provider outside an explicit allowlist. Use it for work that must stay on local models (for example a Mac Studio serving GLM through `ds4` and a second model through `llama.cpp`), while normal sessions keep mixing in hosted models.

## Starting one

```bash
omp --private                  # interactive
omp --private -p "summarize"   # headless
```

From the collab app, choose **Private** in the start-session sheet; the companion launches `omp --private`. See [collab](./collab.md#private-sessions).

`--private` is for **new sessions only**.

- `--private` with `--resume`, `--continue`, `--restore` or `--fork` of a session that is not already private fails with `only a new session can be made private; a forked private session stays private`.
- Resuming, continuing, restoring or forking a session that is private keeps it private, with or without the flag.
- A private session cannot be turned back into a normal one. To leave private mode, start a new session in a new process.
- A normal process cannot switch to a private session at runtime (`/resume`); open it with `omp --resume <id>`, which adopts the session's privacy at startup.
- `/restart` relaunches with `--private` whenever the process is private, including when privacy came from a resumed session rather than the flag.

The session header records `private: true`; the header, not the flag, is the source of truth after creation. Forks, branches and subagent transcripts of a private session copy it.

## Configuration

Both settings are read from the operator's layers (global `config.yml`, `--config` overlays); a project `.omp/config.yml` cannot widen them.

```yaml
private:
   providers: [studio-glm, studio-nanbeige] # provider ids private sessions may call
   modelRoles: # used instead of `modelRoles` inside private sessions
      default: studio-glm/glm-5.3-flash
      smol: studio-nanbeige/nanbeige
```

| Setting              | Default | Meaning                                                                                                                                                                                                                   |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `private.providers`  | `[]`    | Provider ids a private session may call. Starting a private session while it is empty fails at startup, naming this setting.                                                                                              |
| `private.modelRoles` | `{}`    | Role → selector map that replaces `modelRoles` per role in private sessions. A role not listed here resolves from the normal `modelRoles` and fallbacks, but must still land on an allowed provider (otherwise it fails). |

The session starts on `private.modelRoles.default`, or the resolved `default` role when that is allowed. A `--model`, `--smol`, `--slow` or `--plan` flag is a deliberate choice for the run and wins over `private.modelRoles`, but is still limited to the allowlist.

## What is enforced

Private mode is process-wide and one-way: once a process enters it, nothing in that process (a later `/new`, an SDK session, a subagent) can leave it, and a repeated activation can only narrow the allowlist.

- **Egress guard.** Every pi-ai dispatch checks the provider before any I/O: `stream`/`streamSimple`, the transport fetch (every HTTP attempt, including prewarm and retries), credential lookup (`KeyCascade.get` and `getWithCredential`, so no OAuth refresh runs for a disallowed provider), the Codex compaction stream, image generation, speech, transcription, embeddings, rerank, video, the native judge, and the raw-fetch compaction and proxy paths. A custom `compaction.remoteEndpoint` is ignored in a private process whichever layer set it, so remote compaction needs a provider-native route on an allowed provider and otherwise falls through to the next compaction method. A disallowed call throws `PrivateModeError` ("<provider> is not allowed in a private session (private.providers: …)").
- **Catalog.** Models of providers outside the allowlist disappear from the model registry (picker, `/model`, role resolution, fallback chains, credential lookup). Fallback chains skip every candidate that is not allowed.
- **Model switching.** The picker, `/model`, prompt model overrides and collab model pills refuse a disallowed model with a clear message.
- **Subagents.** Subagents run in the same process and inherit private mode; worker threads receive the allowlist at boot and enter private mode before any other service starts.
- **Auxiliary services.** Private mode turns on `models.offline`, so the judge, Spotlight, live audio, title and commit generators and similar services stay on the active model's provider.
- **Memory.** Every memory backend (local, Hindsight, Mnemopi, Sharpshooter) is off in a private process, whatever `memory.backend` says in any layer. A normal process's memory collection skips sessions whose header is private, so private transcripts never feed it.
- **Shared stores.** A private session writes no prompts into the shared `history.db` and journals no recaps there, and the `archive` eval prelude lists and reads no private session.
- **Advisor.** Disabled; `/advisor on` is refused.
- **Tools.** `web_search` is removed from the tool set.
- **Sharing.** `/share` is refused (including custom share scripts).
- **Telemetry and tunnels.** OTLP export is not started, and the image-URL blob broker is never built, so no image is published to a public host, tunnel or provider file API.
- **Marker.** A startup notice reads "Private session: models limited to …", the TUI status line shows a `Private` badge in the `mode` segment, and a collab host advertises the `private` feature and `private: true` in its registry row.

## What is not guaranteed

Private mode limits **model requests**. It is not a network firewall.

- `bash`, `eval` and anything the agent runs in a shell (`curl`, package managers) reach the network as usual.
- The `read` tool's URL fetch, the `fetch` tool (including its reader backends: Jina, Firecrawl, Parallel) and the browser tools reach any URL the model picks, so prompt-injected content can still exfiltrate; disable those tools if that matters.
- `report_issue` sends model-chosen text to the issue tracker.
- MCP servers, extensions and custom tools are arbitrary code with arbitrary network access.
- Model and usage discovery against a provider may send metadata (not transcript content) to that provider's endpoint.
- An allowlisted provider whose `baseUrl` is remote sends requests to that remote host. List only providers whose `baseUrl` is local.
- Custom providers registered by an extension with their own `streamSimple` run under the extension's code, below the guard.

## Implementation files

- `packages/ai/src/private-mode.ts`: process-wide allowlist and `PrivateModeError`.
- `packages/coding-agent/src/config/private-mode.ts`: activation, catalog filter.
- `packages/coding-agent/src/session/private-session.ts`: adoption rules for resume, fork and switch.
- `packages/coding-agent/src/thread/services/private-mode.ts`: hand-off to worker threads.
