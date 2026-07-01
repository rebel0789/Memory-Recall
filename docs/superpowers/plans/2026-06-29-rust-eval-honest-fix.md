# Codex goal — Make the OAF Rust eval honest (realistic multi-call baseline)

Date: 2026-06-29. Owner: rebel. Runtime: short focused task. Predecessor: M7
(branch `codex/rust-core-m7`). This is a FIX to `scripts/rust-eval.mjs`, not a milestone.

## 0. Why
The current eval reports ~99% token reduction with `toolCallReduction: 0` — a single big
file-read vs one graph query. That is NOT a realistic baseline and overstates the win (the
cherry-picked-headline trap). Replace it with a realistic multi-call file-by-file baseline
so the number is defensible. Expect an order-of-magnitude result (~5–20×), NOT 99%. If it
comes out far higher, the baseline is still too generous — scrutinize and report honestly.

## 1. Base & isolation
Branch off `codex/rust-core-m7`. New worktree `codex/eval-honest-fix`. Only modify
`scripts/rust-eval.mjs` (and its CI wiring if needed). Do NOT touch `/rust` source or any
other Node file. Node `npm run ci` (435) stays green. Re-run all existing harnesses first;
M1–M7 must still pass.

## 2. The honest baseline (the core of this fix)
For each structural question, BOTH approaches must produce the CORRECT answer (graded
PASS/PARTIAL/FAIL vs a known key). Measure the COST to reach that answer:
- **Graph approach:** the actual OAF tool call(s) — typically 1 `query graph` / `graph path`
  / `recall`. tokens = the tool response payload; toolCalls = the real number (usually 1).
- **File-by-file baseline = model how an agent ACTUALLY explores, in multiple calls:**
  1. One search/grep call for the target symbol across the repo (respect .gitignore; do NOT
     read binary/vendored). tokens += the grep result (file:line matches); toolCalls += 1.
  2. Open ONLY the files that contain matches, up to a realistic cap (e.g. ≤8 files — the
     files a focused agent would actually open; NOT the whole repo, NOT files without a
     match). For each: read its content the agent would consume to answer (the relevant
     region or, for a small file, the whole file). tokens += that content; toolCalls += 1
     per file read.
  3. baseline tokens = grep + sum(reads); baseline toolCalls = 1 + filesRead.
- Reductions: tokenReduction = (baseline.tokens - graph.tokens)/baseline.tokens;
  toolCallReduction = (baseline.toolCalls - graph.toolCalls)/baseline.toolCalls. The
  tool-call reduction MUST now be > 0 (graph 1 call vs baseline several).

## 3. Questions & repos
≥3 realistic structural questions (e.g. "what does FUNCTION call?", "what calls FUNCTION?",
"what implements/uses X?") on ≥2 real repos (the OAF repo + one external real repo fetched
read-only into a temp dir). Use a known answer key per question for the PASS/PARTIAL/FAIL grade.

## 4. Honesty rules (hard)
- No whole-repo dumping baseline; no reading files without a match; no artificial inflation.
- Report the MEASURED per-question and aggregate numbers (token + tool-call reduction +
  grade). Expect ~order-of-magnitude. If aggregate token reduction is still >~50× or any
  toolCallReduction is 0, treat it as suspect — investigate and report what's happening,
  do NOT ship the inflated number.
- State the methodology in the output. Report any FAIL/PARTIAL honestly.

## 5. Definition of done
- [ ] `scripts/rust-eval.mjs` uses the multi-call baseline above; toolCallReduction > 0.
- [ ] ≥3 questions × ≥2 real repos, graded, with a stated methodology.
- [ ] Aggregate numbers reported honestly (defensible order-of-magnitude, not 99%).
- [ ] M1–M7 harnesses still pass; Node `npm run ci` green (435).
- [ ] Honest report: per-question + aggregate token/tool-call reduction, grades, methodology,
      and a note if any number looks too high and why.

## 6. Reporting
End with the per-question table (graph vs baseline: tokens, toolCalls, grade), the aggregate
token + tool-call reduction, the methodology statement, and an explicit honesty note. Real
numbers only.
