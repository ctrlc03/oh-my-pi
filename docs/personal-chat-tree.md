# Personal agent: the chat-tree memory mode

A second way for the Personal agent ([personal-agent.md](./personal-agent.md)) to remember: **one chat that never ends**. It follows the "UniiChat / OptChat" design (Gist: https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449); this page is what omp does, with the exact numbers.

The first mode, `recall`, stays the default and is unchanged (daily rollover with a handoff note, Mnemopi recall on every owner turn). This one is off until you pick it.

## Turning it on

Set `personal.memoryMode: chat-tree` in the Personal profile's `config.yml`, or pick the mode in the app (offered only when the companion says it supports it). It does nothing unless `personal.enabled` is true and `personal.runKind` is `live`; the nightly review run never uses it.

| Setting | Default | Meaning |
|---|---|---|
| `personal.memoryMode` | `recall` | `recall` or `chat-tree` |
| `personal.chatTree.model` | empty | Model that writes the tree's lines, `provider/id` with an optional `:thinking` suffix. Empty: the cheapest Anthropic Haiku the profile can reach (lowest input then output price, newest id on a tie); if there is none, the profile's `smol` role model; if there is none, the session model |
| `personal.chatTree.concurrency` | 8 | Summaries written at once (≥ 1) |

Prompt caches are per model. For turns and summaries to share the cache of the tools and system prompt, set `personal.chatTree.model` to the model the turns use.

In this mode omp switches off, for that process and its main session only: its own compaction (`compaction.enabled`, idle and mid-turn compaction, notes-backed context windows), Mnemopi auto recall, per-turn recall and pinned-memory injection, and the `recall` and `reflect` tools. Subagents keep omp's compaction as the profile configures it: they have no chat to bound their context. `zoom` is the only way to navigate memory. Mnemopi retention (`retain`, `memory_edit`) keeps running, so the nightly review still has material. About you (the profile's `AGENTS.md`) stays: it follows the system prompt as the user's own instructions.

The companion never rolls the live session over for the daily time in this mode, and a keep-alive restart, or a replaced omp session, simply continues the chat. The one thing it does end is a full omp session: the omp session file grows with every turn (the chat's view bounds what the model sees, not what omp keeps), so once the file passes 6 MB the companion, at the next idle moment, starts a **fresh** omp session: no handoff request, no first prompt, no note. The chat under `personal-chat/` is left as it is and carries the continuity.

## Where it lives

`<agent dir>/personal-chat/`, independent of omp session files:

```
main/YYYY-MM-DD.jsonl   {i, kind, text, size, date}   every message, append-only, flushed, one file per UTC day
tree/YYYY-MM-DD.jsonl   {l, i, text, size}              every built node, append-only
view.json               [[l, i], ...]                   the view, saved as it is (never rebuilt from the log)
lock                    pid of the one owner process
status.json             what the companion reads
```

Kinds: `user` (the owner's own words: their prompts, a collab guest's prompts, and events the owner signed), `unii` (what the agent said), `tool` (a tool call, `name {json}`), `echo` (tool output, and anything from outside: events not signed by the owner, PR-watch messages), `work` (a subagent's report, starting `[Name]`), `note` (memories from before the chat). The agent's thoughts are never logged. A tool output is clipped to its first and last 15,000 characters; any other long text is split into consecutive messages of at most 16 KB. Sizes are UTF-8 bytes everywhere, never tokens.

A second omp process that finds the lock held by a live process waits up to 20 seconds and then refuses to open the chat (its turns fail with that message). A failed open is not final: the next turn, tool call or note tries again (a lock held by a live process is then only looked at, without the wait), and so does a summary model that could not be resolved the first time (a typo in `personal.chatTree.model`, a registry not yet populated). A stale lock is taken over: its process is dead, or its pid was reused (it names this very process while no chat here holds it, or its process started after the lock was written, compared through `ps -o etime=` where `ps` is available). The takeover renames the stale lock aside and only deletes it if it is still the content that was judged stale, so a lock another process linked in the meantime is never removed. A torn last line (crash mid-write) is cut off on open.

A turn start that was logged before a crash is not logged again: the first turn of a new process compares the messages that open it with the last rows of the log, and skips the leading ones already there (same kind and text, and made no later than the row).

`status.json`, rewritten atomically at most once a second when the numbers change:

```json
{ "messages": 0, "nodesBuilt": 0, "nodesPending": 0, "viewBytes": 0, "compactionsFailed": 0, "updatedAt": "ISO" }
```

`compactionsFailed` is the number of nodes whose summary failed and wait for a retry (at the next message).

## The tree

Message *i* is node `(0, i)`. Nodes `(l, 2k)` and `(l, 2k+1)` merge into `(l+1, k)` once both exist. Every node is at most 512 bytes. A source that already fits is kept word for word, with no model call (a leaf is `kind: text`; two short lines are joined by a newline). Everything else is a side request to the summary model:

- the same system prompt and tools as a turn, so the cache holds; the model is never given a chance to call a tool (a tool call in a reply is ignored);
- one user message: the view (lines of the chat before the node, built ones only, ending at the node), then the task text (the spec's §4 texts, with a 512-dash ruler);
- if the line is over 512 bytes, a "Too long" follow-up in the same conversation; up to 5 calls, keeping the shortest line. An `id+n|` head the model copied from the view to the front of its line is dropped before the line is measured or stored (live runs showed Haiku doing it now and then, which rendered as `22+1|2+2|…`);
- a failed node is retried at the next message. Each node is built once. Ready nodes sit in queues (leaves first, then merges, lowest level first); nothing scans the tree. At most `personal.chatTree.concurrency` calls run at once.
- every call that is answered is recorded in the session as model usage (`chat-tree-compaction`, like the cache warmer's), so its cost counts in the session's totals, its spend cap and the profile's day and month limits.

A turn waits (up to 90 seconds) until every message before the new one is summarized; past that the view shows `(not summarized yet: zoom it)` for those lines and the turn goes on. A message whose summary call failed is not waited for once nothing else before the new message is still being summarized: it is tried again at each message, and the view shows the placeholder for it meanwhile. Stopping the turn ends the wait at once (and the wait for the cache gate, below); nothing of that turn is logged.

## The view

A list of tree nodes covering the whole chat, oldest first, rendered `id+n|text` (newlines turned into spaces, no dates, never whole messages). It is a sawtooth between 64 and 128 KB: each message appends a line; once over 128,000 bytes, a batch merges the sibling pairs most due (`due = (T − last) / 2^l`, from the pair's *last* message, merging only pairs whose parent is built) until it is back to 64,000 bytes. The compaction view of a summary is the same with 16–32 KB, ends at the node and holds only built lines.

## A turn

Each owner message, and each event or schedule message from the Personal runtime, starts a **fresh** model call made of `[tools][system prompt][view][state][message]` and nothing else. The state (date, time, workspace) comes after the view so the prefix stays cacheable. Messages the owner sends during the turn are logged as `user` and reach the model between its tool calls; its own tool calls and their results stay in the turn. Nothing of the turn carries to the next one except what was logged. omp's session file keeps the usual transcript for the app.

Subagents stay: the `task` tool works as before, with omp's own compaction, and a subagent's report (the tool result or the later background delivery) is logged as `work`. `zoom("Name")` reads a subagent's whole transcript.

## Tools

- `zoom(id, n)`: `n` a power of 2, `id` a multiple of `n`. `n ≥ 2` gives the two lines under `id+n`; `n = 1` gives message `id` whole, in pages of 12,000 characters (`page`). `zoom("Name")` gives a subagent's transcript.
- `date(id)`: when message `id` was logged, local time and ISO UTC.

## Prompt caching

On Anthropic the view is sent as blocks of 4 lines. The request carries four cache marks: the last tool, the system prompt, the last whole view block, and the request end. A call whose marked prefix another call is still writing waits until that call's response has its first content (a text, thinking or tool call block; the provider's `start` event comes before it has read the request and does not count). A turn on the summary model holds the system prompt's prefix the same way, from its model call until its reply has first content. Other providers ignore the marks.

## First start and notes

When the chat is empty the companion sends the stored handoff note as one or more owner-signed `control` events whose body is `note\n<text>`; each is logged as one `note` message and starts no turn. Nothing else is imported. The companion clears the stored note only after every piece is in the inbox, so a failed hand-over is repeated at the next start while the chat is still empty. In the session a note's inbox file is deleted only after the note is logged: a failure (for example a chat that cannot open yet) puts the file back in the inbox, and after a second failure it is dropped with a `failed` receipt.

## Limits

- Images are not stored in the chat: a message with images is logged with `[image: type]` and the model sees the image only in the turn that received it.
- The day files use UTC dates.
- The chat belongs to one agent dir; two profiles have two chats.
