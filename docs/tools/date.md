# date

> The date and time at which a message of the Personal agent's chat was logged. Only in the `chat-tree` memory mode: [Personal chat tree](../personal-chat-tree.md).

## Source
- Entry: `packages/coding-agent/src/tools/chat-tree-tools.ts` (`DateTool`)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/date.md`
- Logic: `packages/coding-agent/src/personal/chat-tree/zoom.ts` (`dateOf`)

## Availability
- Same as [zoom](./zoom.md). Approval tier: read.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `number` | Yes | The message id. |

## Output
`message <id>: <local time, weekday, UTC offset> (<ISO UTC>)`.
