# zoom

> Open a line of the Personal agent's chat view, or read a message whole. Only in the `chat-tree` memory mode: [Personal chat tree](../personal-chat-tree.md).

## Source
- Entry: `packages/coding-agent/src/tools/chat-tree-tools.ts` (`ZoomTool`)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/zoom.md`
- Logic: `packages/coding-agent/src/personal/chat-tree/zoom.ts`

## Availability
- Exposed only to the top-level session of a Personal agent with `personal.enabled`, `personal.runKind: live` and `personal.memoryMode: chat-tree`. Always visible (essential), never a subagent tool.
- Approval tier: read.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `number \| string` | Yes | A message id (a multiple of `n`), or a subagent's name for its whole transcript. |
| `n` | `number` | No | A power of 2. `n ≥ 2`: the two lines `id+n/2` and the one after it. `1` (default): message `id` whole. |
| `page` | `number` | No | Page (from 1) of a long message or transcript, 12,000 characters a page. |

## Output
Text. Lines read `id+n|text`; a line not summarized yet reads `(not summarized yet: zoom it)`. A whole message starts with `message <id>, <kind>, <bytes> bytes`. A bad `n`, an `id` that is not a multiple of `n`, or an `id` past the end of the chat is a tool error that says so.
