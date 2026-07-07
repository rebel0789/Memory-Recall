# Codex goal — OAF Rust supertool, M9: more languages (tree-sitter ingest breadth)

Date: 2026-06-29. Owner: rebel. Runtime: long autonomous run. Authoritative design:
`docs/product/oaf-rust-supertool-spec.md` (esp. §7.5 extraction pitfalls). Predecessor: M8
(branch `codex/rust-core-m8-semantic`). Build M9 ONLY. Fire AFTER M8.

## 0. Mission
Extend governed tree-sitter ingest beyond the M3 five (JS/TS/JSX/TSX, Python, Rust, Go) to
more languages — each done WELL with per-language conformance tests — moving toward cbm's
breadth while keeping our extraction-quality edge and avoiding cbm's documented per-language
bugs.

## STEP 0 — base correctly
Branch off `codex/rust-core-m8-semantic`. New worktree `codex/rust-core-m9-langs`. Re-run all
existing harnesses; M1-M8 must still pass before adding M9.

## 1. Scope — IN vs OUT
IN: add a BATCH of languages — target Java, C, C++, Ruby, PHP, C# — each producing governed
File/Module/Function/Class/Method facts + DEFINES/IMPORTS/CALLS edges, with CALLS resolving to
Function/Method (NEVER Module). Do as many as you can do WELL (correct call graph + a passing
conformance test); STOP and report rather than shipping a shaky language. Vendored grammars
compiled into the binary.
OUT (scope violation): HTTP/route/gRPC/IaC/k8s passes, Hybrid-LSP type resolution, cross-repo,
semantic-table changes, UI/install changes. Per-language CALLS/IMPORTS/DEFINES only.

## 2. Quality bar per language (pre-empt cbm's §7.5 bugs)
For EACH added language: CALLS->Function/Method not Module (cbm #220/#438/#43); capture
signatures/annotations as fact attributes where relevant (cbm #382 Java annotations missing);
large files never silently produce zero/partial nodes (cbm #213/#199 — flag, don't truncate);
dedup by name; confidence + provenance on every fact; honor .gitignore/.git/info/exclude; no
O(n^2) AST loops (cbm #130/#106). Index identifier + doc text for BM25 via the camel tokenizer.

## 3. Verification — per-language QUALITY (not byte-parity)
Extend the ingest-quality harness: a fixture per added language with a KNOWN call graph;
assert exact expected entities + CALLS/IMPORTS/DEFINES edges (caller->callee correct, dedup,
no truncation), and report precision/recall per language. Re-ingest is idempotent; supersession
on re-ingest works. Also ingest >=1 real multi-language repo and assert node-count sanity (no
silent truncation) + zero duplicate entity ids. Report honest precision numbers + unhandled
patterns per language.

## 4. Carry invariants + memory
Governed/proposal-gated; current-truth; --max-memory + bounded workers (M7) still hold across
the new grammars; no O(n^2). Note the binary SIZE increase from added grammars (report it).

## 5. Checkpoint & stop
Commit per green `cargo build && cargo test && node scripts/<harness>` — ideally one commit
per language so a shaky one can be dropped cleanly. Stop at the first language you can't do
WELL; report it rather than degrading quality. Node `npm run ci` green; only /rust + harness
touched. No `unsafe` without justification + test.

## 6. Definition of done
- [ ] Step 0: based on m8-semantic; M1-M8 still pass.
- [ ] >=3 new languages added WELL (target 6: Java, C, C++, Ruby, PHP, C#), each with a passing
      per-language conformance fixture (correct call-graph attribution, dedup, no truncation).
- [ ] Real multi-language repo ingests with node-count sanity + zero dup entity ids.
- [ ] Binary size increase reported; --max-memory still honored.
- [ ] Node `npm run ci` green (435); only allowed files touched.
- [ ] Honest report: per-language precision/recall + unhandled patterns; any language dropped
      (and why).

## 7. Reporting
End with: per-language quality table (precision/recall, expected vs actual edges), the real
multi-lang repo result, the binary-size delta, the DoD checklist, and an explicit
"dropped / unhandled patterns / open questions" list. Real numbers only.
