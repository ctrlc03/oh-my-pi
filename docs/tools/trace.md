# trace

> Who defines, calls, handles, publishes, or emits a symbol, answered in one call from a persistent, incremental code index. No model calls. Shown as `Trace` in the UI.

## Source
- Entry: `packages/coding-agent/src/tools/trace.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/trace.md`
- Key collaborators:
  - `packages/coding-agent/src/codemap/store.ts` — SQLite schema, file enumeration (reuses `listFiles` from `tools/jfind/tree.ts`), incremental refresh
  - `packages/coding-agent/src/codemap/query.ts` — `trace` and `search` queries, derived event/handler edges, text rendering
  - `packages/coding-agent/src/codemap/bridges.ts` — cross-language edges (Solidity event → Rust decoder → internal type, Rust → Solidity function, Rust → Noir circuit)
  - `packages/coding-agent/src/codemap/rows.ts` — joined symbol/ref row shapes shared by `query.ts` and `bridges.ts`
  - `packages/coding-agent/src/codemap/words.ts` — identifier splitting for search
  - `packages/natives` `extractSymbolsAsync` — tree-sitter symbol and reference extraction (Rust, TypeScript/TSX, JavaScript, Solidity, Python, Go, Noir)

Disabled by default: set `codemap.enabled` to enable. Once enabled it is an essential (top-level) tool.

## CLI
`omp codemap build [PATH]`, `stats [PATH]`, `trace <SYMBOL> [PATH] [--depth N] [--json]`, `search <WORDS> [PATH] [--json]`, `flow "<QUESTION>" [PATH] [--from SYMBOL] [--hops N] [--json]` (see [flow](flow.md)) (`packages/coding-agent/src/cli/codemap-cli.ts`). `PATH` is the repository root to index (default `.`).

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | Yes | An identifier (`CommitteeFinalized`, `Actor::handle`), or several words (contains a space) for a ranked symbol search. An unknown identifier falls back to search. |
| `path` | `string` | No | File or directory restricting results. The index root is the session cwd; a path outside the cwd is rejected with an error. |
| `depth` | `number` | No | 1 (default) to 3. At 2+, an event is followed publisher → event → handlers → events their `handle` methods publish → their handlers; a function gets caller chains. |

## Index
Stored at `<cache dir>/codemap/<sha256(root) first 16 hex>.sqlite` (next to the judgment cache). Tables `files`, `symbols`, `refs`, `meta`, plus an FTS5 table over name words, signature, doc, and path words (LIKE search when FTS5 is unavailable). Every call lists the root (gitignore-aware, same deny lists as `find`), compares `(mtime, size)` per source file (`rs ts tsx js jsx mjs cjs sol py go nr`, up to 1 MiB), re-extracts only changed files with 16 extractions in flight, and drops removed files in one transaction. A schema version mismatch rebuilds the index.

## Derived edges
Computed per query, not stored:
- **handles** — Rust `impl Handler<…X…> for Actor`: every identifier type argument counts (so `TypedEvent<E3Requested>` handles both). Path refs to a variant inside the `handle` method of an impl handling a broad enum count as handling that variant (tuple-struct and struct-variant match arms).
- **publishes** — struct literals (`construct`) and type/constructor heads (`type`, plus tuple struct/variant constructors recorded as `construct`) directly inside the arguments of `publish`, `publish_local`, `dispatch`, `do_send`, `send`, `try_send`, `notify`, `emit`, or `broadcast`, credited to the enclosing symbol. Transparent wrappers (`new`, `from`, `into`, `clone`, `to_owned`, `Some`, `Ok`, `Err`, `Box`, `Arc`, `Rc`, `wrap`) pass the enclosing call through, so `addr.send(TypedEvent::new(E { .. }))` credits `E` to `send`; wrapper types (`TypedEvent`, `Box`, …) are never reported as the event. `path` refs (`E3Stage::X`) are excluded: they are enum variants used as values. An event built into a variable and published later, or a variant passed as a field, is not linked.
- **qualified symbols** — `Owner::name` keeps definitions whose parent (or impl self type, compared by exact last type name) is `Owner`, falling back to all definitions of `name` when none match (a module path such as `crate_name::Type`). With an owner, handlers, publishers, callers, references, and chains are limited to files that define or mention `Owner`, and a `Scope` section says so.
- **emits** — Solidity `emit X(…)`.
- **decodes** (Solidity event E → Rust) — Rust `type`/`path`/`construct` refs named like a Solidity `event` symbol, credited to the enclosing symbol (the event is re-declared in a `sol!` block, which is not extracted, so the reference itself is the link). Scopes that also call `decode_log_data`/`decode_log`/`decode_raw_log` or name `SIGNATURE_HASH` are marked `decoder` and listed first; struct/enum bodies (wrappers) are not sites. Multi-segment paths such as `ICiphernodeRegistry::E::decode_log_data(…)` yield type refs for each capitalized qualifier.
- **becomes** (event E → internal Rust type T) — a struct W whose span contains a `type` ref to E, plus `impl From<W> for T` (the trait must be exactly `From<W>` or a path to it) or a method of `impl W` whose return type names T; also a `construct` in the decoder scope between a ref to E and the next ref to a different Solidity event (the wrapper itself is skipped). Structs rank before enums. A type that more than four events convert into (a broad event enum) reports no `Decoded from`.
- **converts** — any `impl From<A> for B`: `Converts to` on A, `Converted from` on B.
- **calls-contract** (Rust → Solidity) — Rust `call` refs whose name equals a Solidity `function` symbol name that has an uppercase letter or is ≥ 8 characters and is not a generic name (`new`, `get`, `set`, `call`, `send`, `transfer`, `approve`, `balanceOf`, `owner`, `initialize`, `init`, `deploy`, `address`, `decode`, `encode`, …). Shown as `Called from Rust` on the Solidity function (and removed from its `Callers`) and `Calls contract` on the Rust caller.
- **proves-with** (Rust → Noir) — Noir packages are directories holding `src/main.nr`, named by the `name` under `[package]` in `Nargo.toml` (read from disk at query time) and by the directory name. A Rust `string` ref equal to a package name links to the package's `main`; a `path`/`type` ref on the same line (`CircuitName::ThresholdShareDecryption => "share_decryption"`) names the circuit too, and a group string elsewhere in the file (`=> "threshold"`) picks between packages sharing a name by parent directory. Shown as `Circuit` (the `main` plus `Named in Rust`) and, on a circuit's `main`, `Proved from Rust`.
- **calls / references / implements / contains** — straight from `refs`, `impl_trait`, and `parent_id`.

## Outputs
Single text block under about 8 KB: sections `Definitions`, `Members`, actor view (`Handles`, `Publishes`, `Implements`, `Inherent impls`), `Handled by`, `Published by`, `Emitted by`, `Implemented / extended by`, `Decoded by`, `Becomes`, `Decoded from`, `Converts to`, `Converted from`, `Called from Rust`, `Circuit`, `Named in Rust`, `Callers`, `Inside <fn>`, `Calls contract`, `References`, and at depth 2+ `Event chain` / `Caller chain`. The event chain walks emitted by → (called from Rust) → decoded by → becomes → handled by → publishes. Site lines are `path:start-end  kind  name  — signature`, with paths relative to the cwd (absolute outside it) so `read path:start-end` works. Lists are capped (12 handlers/publishers, 15 callers, …) with `+N more` counts; overlong output is truncated with a line count. When the refresh re-parsed or removed files, a trailing line reports it.

`details`: `symbol`, `depth`, `mode` (`trace` or `search`), `found`, `reparsed`, `files`. A symbol or search with no match is marked `useless`.

## Side Effects
- Filesystem: reads changed source files; writes the index database under the cache directory. Never writes inside the searched repository.
- No network or model access; no model registry required.
