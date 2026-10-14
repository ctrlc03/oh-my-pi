## Summary

**Stack 6/6: crate agent notes.** Depends on #2248.

- Add `crates/event-system/AGENTS.md` and `crates/ciphernode-builder/AGENTS.md`. Each file gives the purpose of the crate, a file map, the rules for changes, the tests to run, and links to the `agent/` sections that own the shared rules. The builder file also gives the startup phase order and the reason for each step.
- Add a `CLAUDE.md` pointer in each of the two crates, because Claude Code loads only nested `CLAUDE.md` files.
- Root `AGENTS.md`: add a read-budget row that sends an agent to a crate `AGENTS.md` before it changes that crate. Add the crate files to the harness layout.
- `agent/CRATES_ARCHITECTURE.md`: correct the statement that `CiphernodeBuilder` is still a split target. #2245 splits it by startup phase.

6 files, documentation only. No code, test, or configuration changes.

The crate files link to `agent/CRATES_ARCHITECTURE.md`, `agent/invariants/`, and `agent/flow-trace/`, and do not copy them. This PR does not move or delete flow-trace content. `e3-evm` gets no crate file in this PR: this stack changes about 700 of its 20,000 lines, so a short file about the full crate needs a separate review.

## Verification

At head `7d66dd34f`:

- `npx prettier --check` passed for the four new files and `AGENTS.md`. `agent/CRATES_ARCHITECTURE.md` was edited by hand; its two unformatted paragraphs come from #2245.
- `./scripts/check-doc-sync.sh` passed.
- `./scripts/check-invariants.sh` passed.
- Each file, function, feature, and order step in the two crate files was compared with the code at this head.

Upgrade class: **rolling**. Documentation only.

## Stack

#2243 Event runtime crate → #2244 EVM provider cache → #2245 Builder phases and profiles → #2241 EVM and extension setup steps → #2248 Dead code removal → **this PR**
