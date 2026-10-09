# flow

> Trace a multi-step flow end to end from a question, across Solidity, Rust, and Noir, over the persistent code index of [trace](trace.md), pruned by the session's judge. Shown as `Flow` in the UI.

## Source
- Entry: `packages/coding-agent/src/tools/flow.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/flow.md`; judge question text in `packages/coding-agent/src/prompts/tools/flow-question.md`
- Key collaborators:
  - `packages/coding-agent/src/codemap/flow.ts` — the shared walk (tool and CLI): entry discovery, breadth-first expansion, judging, report
  - `packages/coding-agent/src/codemap/query.ts` — `flowNeighbors` turns every derived edge into symbol-to-symbol hops, in both directions
  - `packages/coding-agent/src/codemap/bridges.ts` — the cross-language edges (decodes, becomes, converts, calls-contract, proves-with)
  - `packages/coding-agent/src/tools/jfind/cascade.ts` — `runCascade`, reused for entry discovery with the same judge
  - `packages/coding-agent/src/judgment/index.ts` — resolves the `judge` role

Disabled by default: set `codemap.enabled` (the same setting as `trace`) to enable. Once enabled it is an essential (top-level) tool.

## CLI
`omp codemap flow "<QUESTION>" [PATH] [--from SYMBOL] [--hops N] [--json]` (`packages/coding-agent/src/cli/codemap-cli.ts`). `PATH` is the repository root (default `.`). Progress goes to stderr. The judge is resolved like `omp find` (project settings, `judge` role); when it is not a native System One model the walk is structural.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `question` | `string` | Yes | The flow in plain words. Entry points are discovered from it unless `from` is given. |
| `from` | `string` | No | A symbol (`Name` or `Owner::name`) to start from; its definitions (up to four, non-test first) are the entries and are not judged for relevance. |
| `path` | `string` | No | File or directory restricting the walk (and the entry search). Must be inside the cwd. |
| `hops` | `number` | No | Edges followed from the entries; default 5, clamped to 1–8. |

## How it works
1. **Entries.** With `from`, its definitions. Otherwise the union (capped at 24 symbols) of full-text hits for the question over the index and the innermost symbols overlapping the best `find` cascade hits. The judge answers "Is this code a step in: <question>?" for every candidate in one batched System One request per ≤64 cards; entries with p ≥ 0.5 are kept (at most 4; if none, the best at p ≥ 0.3, at most 2).
2. **Walk.** Breadth-first over all edges in both directions: publishes/handled-by, emits/emitted-by, decoded-by/decodes, becomes, `From` conversions, calls-contract/called-from-Rust, proves-with/proved-from-Rust, and callers/callees (8 per node, plain-call names like `new`/`clone` skipped). Each frontier is judged as one batch of cards (language, kind, qualified name, path and lines, signature, first doc sentence, the edge label that reached it); nodes with p ≥ 0.45 become steps and are expanded, at most 10 per hop, with 7 of those slots reserved for event and cross-language edges. Plausible rejects (0.30–0.45, or good but over the cap) become "Also consider" (at most 8). Cards are built from sorted stable text so the shared judgment cache can answer repeats.
3. **Report.** Steps in discovery order, entries first: `n. [lang] Qualified.name  path:start-end  — edge from step k (label)  p=0.xx`, then the signature. Output stays under about 8 KB; when it would exceed that, the strongest steps (bridge edges favored) and the chain they were reached through are kept and the rest counted. A final line gives nodes judged, requests, tokens, cost, and wall time.

Without a native judge (the `judge` role does not resolve to a System One model) the same walk runs structurally: every edge is followed with the same fan-out caps, nothing is pruned by relevance, and the report says so. If judge requests fail, affected nodes are kept unjudged (no `p`) and the failures are listed.

## Outputs
Text as above. `details`: `question`, `from`, `mode` (`judged` or `structural`), `steps`, `alsoConsider`, `stats` (`judged`, `requests`, `errors`, token counts, `cost`, `apiMs`, `elapsedMs`, `failures`), `reparsed`, `files`. No steps is marked `useless`. `--json` prints the full `FlowResult` (every step with its parent, label, and node location, not clipped).

A step is a location to read, not proof: edges are linked by name, so values passed through variables, dynamic dispatch, renamed re-exports, and macros are invisible, and the decode/becomes/proves-with bridges are heuristics (see [trace](trace.md#derived-edges)).

## Side Effects
- Filesystem: refreshes the index like `trace` (reads changed sources, writes the cache-directory database); the `find` cascade reads files for entry discovery. Never writes inside the repository.
- Model calls: judge requests (billed to the session ledger as purpose `flow`; the `find` cascade's under `flow` too); none in structural mode. A call is limited to 90 seconds.
