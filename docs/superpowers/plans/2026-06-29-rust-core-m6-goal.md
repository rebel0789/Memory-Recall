# Codex goal — OAF Rust supertool, Milestone M6: distribution (single binary + install + UI)

Date: 2026-06-29. Owner: rebel. Runtime: long autonomous run (overnight ok).
Authoritative design: `docs/product/oaf-rust-supertool-spec.md` (esp. §7.4 scope/security,
§7.7 distribution). Predecessor: M5 (branch `codex/rust-core-m5`). Build M6 ONLY.

## 0. Mission
Make the Rust supertool installable and "wonderful": a single static binary, a safe
install flow that auto-configures coding agents WITH a receipt (never silent), and a local
governed-memory graph UI that is 100% offline. Apply cbm's distribution lessons so we don't
inherit their install/UI/AV bugs.

## STEP 0 — base correctly
Branch off `codex/rust-core-m5`. New worktree `codex/rust-core-m6`. Re-run all existing
harnesses (recall/ingest/graph/intelligence); M1-M5 must still pass before adding M6.

## 1. Repo & build isolation (unchanged)
All code under `/rust` (+ a small static UI asset dir compiled INTO the binary). Do NOT
modify Node files except the existing harnesses + the install/UI test harness. Node
`npm run ci` (435) stays green. Own CI job. No network/model at runtime.

## 2. Scope — IN vs OUT
IN:
- Single static binary: `cargo build --release` → one self-contained binary, minimal/zero
  runtime deps (statically link where the platform allows; document otool/ldd output). The
  binary already serves CLI + `mcp server --stdio`; keep that.
- Install flow: `oaf install` (+ `--dry-run`, `--client <name>`, `--uninstall`) that detects
  installed coding agents (Claude Code, Codex, Cursor, VS Code at least) and writes their
  MCP server entry. MUST print a RECEIPT of every file it will change and route through a
  confirmation/dry-run — NEVER silently mutate agent configs/hooks (cbm #388). Idempotent;
  uninstall removes exactly what it added.
- Graph UI: `oaf ui --port <p>` serves a local governed-memory graph view (force-directed:
  nodes by type, communities, governed-decision highlighting, current/history toggle,
  click-to-focus via explain). UI assets compiled INTO the binary; 100% OFFLINE — NO CDN /
  runtime external requests (cbm #453). Read-only over the SQLite store.
OUT (scope violation if built): semantic search, parallel-ingest optimization (M7), more
ingestion languages, cross-repo, package-manager publishing (Homebrew/npm/etc. — later),
code-signing automation (note it, don't build the signing pipeline here).

## 3. Distribution safety (cbm §7.4/§7.7 — bake in)
- Install: receipt + dry-run before writing; safe temp files (O_EXCL + random name, no
  predictable /tmp — cbm #384); never write outside the user's agent-config dirs; back up
  any file before modifying; uninstall is exact.
- UI: no external network, no CDN; bind to localhost only; read-only; no source bodies or
  secrets in the served payload (labels/counts only, like architecture.overview).
- Binary: print a reproducible-build note + how to verify checksums; document that release
  signing/notarization is required before public distribution (AV false-positive risk,
  cbm's Windows-Defender label) — but DO NOT implement the signing pipeline in this goal.

## 4. Verification (quality + safety, not byte-parity — these are new surfaces)
Add `scripts/rust-distribution-quality.mjs`:
- Binary: builds; runs `oaf --version`, a CLI command, and `mcp server` round-trip; assert
  no unexpected dynamic deps (capture otool -L / ldd output in the report).
- Install: on a TEMP fake agent-config dir, `oaf install --dry-run` prints a receipt listing
  the exact files/entries; `oaf install` applies them; re-running is idempotent (no dup
  entries); `oaf install --uninstall` restores the original state exactly; assert NO file
  outside the temp config dir is touched.
- UI: start `oaf ui` on a port, fetch the graph endpoint, assert it serves the governed
  graph (nodes/edges/communities, current vs history differs when a fact is superseded),
  and assert ZERO outbound network requests / no CDN URLs in the served HTML/JS.

## 5. Carry invariants (M1-M5)
Read-only UI + queries; governed/proposal-gated; never hard-delete; local-first; no
network/model; bounded payloads.

## 6. Benchmark
Binary size; cold-start; `oaf ui` memory footprint; install dry-run latency. Report a table.

## 7. Checkpoint protocol & stop conditions
Commit per green `cargo build && cargo test && node scripts/<harnesses>`. Stop at the first
blocker (e.g. static-linking platform limitation) and report it honestly — note the
platform reality rather than faking a "fully static" claim. No `unsafe` without
justification + test. Stay in scope.

## 8. Definition of done
- [ ] Step 0: based on rust-core-m5; M1-M5 still pass.
- [ ] Single release binary; dynamic-deps documented (honest about any platform that can't
      fully static-link).
- [ ] `oaf install` with receipt + dry-run + idempotent + exact uninstall; verified to touch
      ONLY the agent-config dirs; never silent.
- [ ] `oaf ui` serves the governed graph offline (no CDN/network); current/history toggle
      works; read-only.
- [ ] Distribution-quality harness passes; benchmark table reported.
- [ ] Node `npm run ci` green (435); Node untouched except harnesses.
- [ ] Honest report: binary deps, install receipt sample, UI offline proof, bench, open items.

## 9. Reporting
End with: the install receipt sample, the UI offline proof (no outbound requests), the
binary dependency list, the benchmark table, the DoD checklist, and an explicit
"platform caveats / deferred (signing, packaging) / open questions" list. Real numbers only.
