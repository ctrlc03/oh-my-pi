# Trajectory inspector and request preview

Two read-only commands show what the session sent to the model and what it will send next.

| Command | What it shows |
| --- | --- |
| `/inspect` | One row per model request of the active branch: timing, tokens, cache, cost, stop reason, and what entered the context since the request before |
| `/preview-request` | The provider request the next turn would send, built without sending it, with a token estimate |

Neither command changes the session, sends a prompt, or costs anything. Both work in the TUI; in ACP mode they print the same information as text. Collab writers get both through [`session-cmd`](./collab.md#trajectory-and-request-preview) and the web client's Timeline.

## `/inspect`

In the TUI `/inspect` opens a list, newest request last and preselected. Each row reads

```text
#12  14:03:21  anthropic/claude-sonnet-4-5  ttft 1.2s, total 8.4s  in 12K out 540  cache 94%  $0.021  +3
```

- `ttft` is the time from the request start to the first streamed token; `total` is the whole response. A provider that reports no timing shows `no timing`.
- `in` counts every prompt token (uncached input, cache reads and cache writes); `cache` is cache reads divided by that prompt total.
- `+3` counts the items that entered the context since the request before; the line under the row names them. A failed or aborted request is marked `error` or `aborted`.

Pick a row with Enter to open its detail: stop reason (with the provider error for a failed request), TTFT and decode time, the four token counts, cost, and every injected item with an excerpt of its text. The panel title carries the summary: request count, total cost, tokens in and out, median TTFT, overall cache share.

### What counts as injected

Everything below is read from the persisted session entries written between two assistant messages, so a resumed session lists its earlier requests too.

| Kind | Source |
| --- | --- |
| `prompt` | The user's (or a guest's) message |
| `tool-results` | The tool results of the previous turn, grouped (`3 tool results`, with `bash ×2, read` as the excerpt) |
| `system-prompt` | The base system prompt's digest the first time it is recorded, and each time it changes (`digest aaaa1111 → cccc2222`); a changed prompt is a common cause of a prompt-cache miss |
| `context-notes` | A revision of the context notebook, or its reminder |
| `todo` | Todo reminders, nudges and preludes |
| `verify` | A failed [verification step](./hooks.md#verification-step) handed back to the agent |
| `hook` | Hook context, rule (TTSR) injections, developer messages |
| `memory` | Memory recall messages |
| `advisor` | Advisor notes |
| `mode` | Plan or goal mode context, model, thinking-level or mode changes |
| `compaction` | A compaction summary or context reset |
| `other` | Any other custom message, named after its type |

Each item carries an estimated token count and an excerpt of at most 1,200 characters. Digest changes and model switches have no token count. In collab the excerpt is redacted through the host's secret obfuscator before it leaves the host.

## `/preview-request`

`/preview-request` runs the real provider path for the next turn with the session's current messages, tools, system prompt and parameters (model, thinking level, service tier, sampling), and stops it at the last moment: the transport hands its request body to a capture hook, the request is aborted, and nothing is transmitted. The result shows the provider-specific body (an Anthropic `messages` request, an OpenAI `responses` request, a Gemini `contents` request, ...) with every string redacted through the session's secret obfuscator, inline binary data replaced by a size marker, and an estimate of its tokens.

Limits, all stated on the report itself:

- Only transports verified to expose their body before any inference traffic are run: `openai-completions`, `openai-responses`, `azure-openai-responses`, `openai-codex-responses`, `anthropic-messages`, `bedrock-converse-stream`, `google-generative-ai`, `google-vertex` and `ollama-chat`. For any other API (`cursor-agent`, `gitlab-duo-agent`, `google-gemini-cli`, ...) the preview is the provider-neutral context the loop hands the transport (system prompt, messages, tools) rather than the wire body, and the report says so.
- It shows the conversation as it stands. The prompt you will send next, pending steering, and `before_provider_request` extension hooks that rewrite the body are not included.
- The preview runs on isolated provider session state, so it never touches a live append-only (`previous_response_id`) conversation; an OpenAI/Codex conversation that would send only a delta shows the full request.
- The body is cut at 60,000 characters in the TUI (120,000 for a collab guest); the report says when it was cut.

Credentials are resolved the same way a real request resolves them, so an OAuth token may refresh, and a missing credential makes the preview fall back to the context view.
