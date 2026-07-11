# Semantic Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Add optional harness and direct-API semantic setup that creates source-bound, explicit-review-only Memory Recall proposals.

**Architecture:** A new dependency-free \`packages/semantic-setup\` package builds bounded document packets, renders a harness task, validates executor output, and normalizes only packet-bound facts. The CLI invokes the package, queues proposals through the existing SQLite provider, and blocks bulk or stale-source activation. Direct API execution is a one-shot explicit network path, deliberately outside the local model gateway.

**Tech Stack:** Node.js 22 ESM, built-in \`fetch\`, built-in crypto/filesystem APIs, existing JSON schema validator, native SQLite proposal queue, Node test runner.

## Global Constraints

- \`recall setup\` stays local-only and does not scan or make model/network calls.
- No API key may be accepted as a CLI value, written to a file, printed, or persisted.
- API execution requires \`--allow-network\`; only HTTPS or loopback HTTP endpoints are allowed.
- Semantic input is bounded docs/config only: 8 files, 16 KiB/file, 64 KiB total; source code bodies stay local.
- Harness task generation must not claim the CLI can invoke an active Codex/Claude session.
- Semantic output creates PENDING fact proposals only, with \`approvalMode: explicit-id-only\` and \`extractionConfidence: inferred\`.
- Semantic proposals cannot set supersession and are excluded from \`memory approve --all\` and \`--all-from\`.
- Explicit approval rechecks the exact source bytes; changed source means no fact is created.
- Reports/events/logs never contain raw bodies, prompts, output text, keys, endpoint URLs, absolute paths, or hidden reasoning.
- No cache, generic cloud model gateway, write MCP tool, automatic harness config write, or automatic active-memory write is added.

---

### Task 1: Source-Bound Semantic Packet and Result Contract

**Files:**
- Create: \`packages/semantic-setup/package.json\`
- Create: \`packages/semantic-setup/src/index.mjs\`
- Create: \`packages/semantic-setup/schemas/semantic-result.schema.json\`
- Create: \`packages/protocol/schemas/semantic-setup-report.schema.json\`
- Create: \`examples/protocol/semantic-setup-report.json\`
- Modify: \`examples/protocol/compatibility/fixtures.json\`
- Modify: \`packages/protocol/README.md\`
- Test: \`tests/semantic-setup.test.mjs\`

**Interfaces:**
- Produces \`buildSemanticSetupPacket({ root, workspaceId, generatedAt })\` with bounded source entries, hashes, skipped-source reasons, and deterministic \`packetFingerprint\`.
- Produces \`renderSemanticSetupTask(packet, { harness })\` without persisting a task file.
- Produces \`normalizeSemanticSetupResult({ packet, result, executor })\` with only packet-bound, safe candidate facts.
- Produces \`buildSemanticSetupReport(...)\` with no raw source/provider credential material.

- [ ] **Step 1: Write source packet tests**

\`\`\`js
test('semantic packet is deterministic, bounded, and excludes secret-like documents', async () => {
  const packet = await buildSemanticSetupPacket({ root, workspaceId: 'ws_test', generatedAt });
  assert.equal(packet.sources.length <= 8, true);
  assert.equal(packet.totalSourceBytes <= 64 * 1024, true);
  assert.equal(packet.sources.some((source) => source.locator.includes('.env')), false);
  assert.equal(packet.skipped.some((item) => item.reason === 'secret_like_content'), true);
  assert.match(packet.packetFingerprint, /^sha256:[a-f0-9]{64}$/);
});
\`\`\`

- [ ] **Step 2: Run the new test and verify it fails**

Run: \`node --test tests/semantic-setup.test.mjs\`

Expected: FAIL because \`packages/semantic-setup/src/index.mjs\` does not exist.

- [ ] **Step 3: Implement packet collection and local schemas**

\`\`\`js
export async function buildSemanticSetupPacket({ root, workspaceId = 'ws_local', generatedAt }) {
  // Resolve only allowlisted workspace docs through realpath, hash full bytes,
  // reject secret-shaped/oversized sources, and cap the selected body budget.
}

export function normalizeSemanticSetupResult({ packet, result, executor }) {
  // Require packet fingerprint and sourceId references; ignore any model-supplied
  // locator/hash/supersession field and force inferred confidence.
}
\`\`\`

- [ ] **Step 4: Add protocol report fixture and validator coverage**

\`\`\`json
{
  "schemaVersion": "1.0.0",
  "command": "semantic plan",
  "packetFingerprint": "sha256:...",
  "sources": [{"sourceId":"src_001","locator":"workspace://README.md","sourceHash":"sha256:..."}],
  "safeguards": {"rawSourceBodiesIncluded": false,"networkCalls": 0,"modelCalls": 0}
}
\`\`\`

- [ ] **Step 5: Run focused checks**

Run: \`node --test tests/semantic-setup.test.mjs && npm run protocol:validate\`

Expected: all focused tests and compatibility fixtures pass.

- [ ] **Step 6: Commit the packet contract**

\`\`\`bash
git add packages/semantic-setup packages/protocol/schemas/semantic-setup-report.schema.json examples/protocol/semantic-setup-report.json examples/protocol/compatibility/fixtures.json packages/protocol/README.md tests/semantic-setup.test.mjs
git commit -m "feat: add bounded semantic setup packets"
\`\`\`

### Task 2: Direct API Executor With Explicit Consent

**Files:**
- Modify: \`packages/semantic-setup/src/index.mjs\`
- Modify: \`tests/semantic-setup.test.mjs\`
- Create: \`docs/adr/0022-explicit-semantic-network-executor.md\`
- Modify: \`docs/architecture/model-gateway.md\`

**Interfaces:**
- Produces \`resolveSemanticApiConfig(options, env)\` for \`gemini\` and \`openai-compatible\` presets without exposing credentials.
- Produces \`executeSemanticApi({ packet, config, credential, fetchImpl })\` with one POST, a timeout, output cap, and no retry/fallback.
- Produces \`evaluateSemanticNetworkConsent({ allowNetwork, endpoint, packet })\` that fails closed before credential access or fetch.

- [ ] **Step 1: Write direct executor tests with fake fetch**

\`\`\`js
test('direct API refuses before reading a credential without explicit network consent', async () => {
  assert.throws(() => resolveSemanticApiConfig({ provider: 'gemini', allowNetwork: false }, { GEMINI_API_KEY: 'never-read' }), /allow-network/);
});

test('direct API sends one bounded OpenAI-compatible request and validates JSON output', async () => {
  const result = await executeSemanticApi({ packet, config, credential: 'test-only', fetchImpl });
  assert.equal(fetchCalls, 1);
  assert.equal(result.facts.length, 1);
});
\`\`\`

- [ ] **Step 2: Run the test and verify it fails**

Run: \`node --test tests/semantic-setup.test.mjs\`

Expected: FAIL because the executor and consent boundary are not implemented.

- [ ] **Step 3: Implement consent, endpoint validation, and API call**

\`\`\`js
if (!allowNetwork) throw semanticError('semantic_network_consent_required');
if (!isHttpsOrLoopback(endpoint)) throw semanticError('semantic_endpoint_denied');
const response = await fetchImpl(endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: \`Bearer \${credential}\` },
  body: JSON.stringify({ model, messages, max_tokens: maxOutputTokens }),
  signal: AbortSignal.timeout(timeoutMs)
});
\`\`\`

- [ ] **Step 4: Record the separate authority boundary**

Document that direct semantic setup is explicit, user-owned, one-shot network consent; it is not \`OAF_MODEL_MODE\`, not a hosted gateway, and not a silent fallback. Update model-gateway documentation to point to the narrow executor.

- [ ] **Step 5: Run focused checks**

Run: \`node --test tests/semantic-setup.test.mjs && npm run check\`

Expected: tests prove missing consent, invalid endpoint, timeout, malformed output, non-2xx response, and success all avoid unsafe persistence.

- [ ] **Step 6: Commit the explicit executor**

\`\`\`bash
git add packages/semantic-setup/src/index.mjs tests/semantic-setup.test.mjs docs/adr/0022-explicit-semantic-network-executor.md docs/architecture/model-gateway.md
git commit -m "feat: add explicit semantic API executor"
\`\`\`

### Task 3: CLI Plan, Task, Run, and Import Commands

**Files:**
- Modify: \`apps/cli/oaf.mjs\`
- Modify: \`tests/cli.test.mjs\`
- Modify: \`tests/semantic-setup.test.mjs\`

**Interfaces:**
- \`recall semantic plan --harness <codex|claude-code|cursor|generic> --dry-run\` emits a body-free report.
- \`recall semantic task --harness <...>\` emits the bounded raw task packet to stdout only.
- \`recall semantic run --provider <gemini|openai-compatible> --allow-network\` queues normalized pending proposals.
- \`recall semantic import --input <workspace-relative-json>\` queues normalized harness results.

- [ ] **Step 1: Write CLI failures and golden paths**

\`\`\`js
test('semantic plan is local and task output names a bounded harness packet', () => {
  const result = runCli(['semantic', 'plan', '--harness', 'codex', '--dry-run', '--root', root]);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).safeguards.networkCalls, 0);
});

test('semantic run requires allow-network before API execution', () => {
  const result = runCli(['semantic', 'run', '--provider', 'gemini', '--root', root]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /allow-network/);
});
\`\`\`

- [ ] **Step 2: Run tests and verify expected failures**

Run: \`node --test tests/cli.test.mjs tests/semantic-setup.test.mjs\`

Expected: FAIL because \`semantic\` is not a CLI command.

- [ ] **Step 3: Implement strict argument handling and report rendering**

\`\`\`js
if (subcommand === 'plan') return semanticPlanCommand(rest);
if (subcommand === 'task') return semanticTaskCommand(rest);
if (subcommand === 'run') return semanticRunCommand(rest);
if (subcommand === 'import') return semanticImportCommand(rest);
throw new Error('semantic requires plan, task, run, or import');
\`\`\`

Validate every option, require workspace-relative input files, keep normal JSON reports free of raw bodies, and route both executor paths through the same normalization/enqueue helper.

- [ ] **Step 4: Verify direct and harness commands locally**

Run: \`node --test tests/cli.test.mjs tests/semantic-setup.test.mjs\`

Expected: plan/task mode has zero model/network calls; import/run create only pending proposals with stable report fingerprints.

- [ ] **Step 5: Commit CLI surface**

\`\`\`bash
git add apps/cli/oaf.mjs tests/cli.test.mjs tests/semantic-setup.test.mjs
git commit -m "feat: expose semantic setup through recall CLI"
\`\`\`

### Task 4: Proposal Guardrails and Source Recheck

**Files:**
- Modify: \`apps/cli/oaf.mjs\`
- Modify: \`tests/cli.test.mjs\`
- Modify: \`tests/memory-recall-integrity.test.mjs\`

**Interfaces:**
- \`memory approve --all\` and \`--all-from\` skip records with \`approvalMode: explicit-id-only\`.
- Explicit \`memory approve <mpq_id>\` verifies \`semanticSourceHash\` against the current workspace file before provider approval.

- [ ] **Step 1: Write regression tests**

\`\`\`js
test('bulk approval leaves semantic proposals pending until named explicitly', async () => {
  await enqueueSemanticProposal(provider, root);
  assert.equal(runCli(['memory', 'approve', '--all', ...common]).status, 0);
  assert.equal((await provider.listProposalQueue({ workspaceId })).at(0).status, 'pending');
  assert.equal(runCli(['memory', 'approve', 'mpq_semantic_pending', ...common]).status, 0);
});

test('explicit semantic approval fails when its anchored source changes', async () => {
  await enqueueSemanticProposal(provider, root);
  writeFileSync(path.join(root, 'DECISIONS.md'), 'changed');
  const result = runCli(['memory', 'approve', 'mpq_semantic_pending', ...common]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /source_changed/);
});
\`\`\`

- [ ] **Step 2: Run tests and verify expected failures**

Run: \`node --test tests/cli.test.mjs tests/memory-recall-integrity.test.mjs\`

Expected: FAIL because current bulk approval selects all pending records and has no semantic source-byte recheck.

- [ ] **Step 3: Implement the guardrails at the CLI boundary**

\`\`\`js
const targets = pending
  .filter((item) => approvalTargets(item, { approveAll, allFrom, explicitId }))
  .map((item) => item.id);
for (const id of targets) {
  await assertSemanticProposalSourceCurrent({ root, proposal: pendingById.get(id) });
  approved.push(await provider.approveProposalFact({ workspaceId, id, workerId, approvedAt }));
}
\`\`\`

Keep root/file access out of the SQLite provider. On mismatch, report \`source_changed\`, leave the queue pending, and do not claim/retry/poison it.

- [ ] **Step 4: Run focused behavior and MCP integrity tests**

Run: \`node --test tests/cli.test.mjs tests/memory-recall-integrity.test.mjs tests/native-memory-sqlite.test.mjs\`

Expected: semantic facts remain absent from ordinary recall until explicit approval and unchanged source verification succeeds.

- [ ] **Step 5: Commit review guardrails**

\`\`\`bash
git add apps/cli/oaf.mjs tests/cli.test.mjs tests/memory-recall-integrity.test.mjs
git commit -m "fix: guard semantic proposal approval"
\`\`\`

### Task 5: Developer Skill, Documentation, and Status Truth

**Files:**
- Modify: \`skills/oaf-memory/SKILL.md\`
- Modify: \`skills/oaf-memory/README.md\`
- Modify: \`skills/oaf-memory/manifest.json\`
- Modify: \`tests/skill-catalog.test.mjs\`
- Create: \`docs/usage/semantic-setup.md\`
- Modify: \`docs/usage/README.md\`
- Modify: \`docs/product/memory-recall-developer-first.md\`
- Modify: \`PROJECT_STATUS.json\`
- Modify: \`README.md\`

**Interfaces:**
- Existing \`skill:oaf-memory\` becomes the current Memory Recall semantic setup skill while preserving its legacy ID/trigger.
- Public documentation states exact local/harness/API boundaries and shows the review/explicit-approval flow.

- [ ] **Step 1: Write docs/skill truth tests**

\`\`\`js
test('semantic skill uses Recall semantic packets and never advertises stale commands', async () => {
  const { manifest, text } = await readSkill('oaf-memory');
  assert.match(text, /recall semantic task/);
  assert.doesNotMatch(text, /oaf ingest-docs|memory consolidate/);
  assert.equal(manifest.sideEffectClass, 'reversible-write');
});
\`\`\`

- [ ] **Step 2: Run the test and verify it fails**

Run: \`node --test tests/skill-catalog.test.mjs tests/usage-docs.test.mjs\`

Expected: FAIL because the skill currently describes stale Rust-only/default commands and lacks the semantic task contract.

- [ ] **Step 3: Update the skill and user documentation**

Document deterministic local scan first, harness task behavior, direct API consent/data boundary, no key persistence, result import, pending review, explicit-ID approval, stale-source re-run, and current limitations. Preserve the legacy identifier but lead with \`recall\` public commands.

- [ ] **Step 4: Update capability truth**

Mark only the implemented packet/task/import/direct executor as supported or experimental with exact limitations. Do not claim arbitrary harness invocation, all-provider support, code upload, background sync, or automatic memory.

- [ ] **Step 5: Run docs and skill tests**

Run: \`node --test tests/skill-catalog.test.mjs tests/usage-docs.test.mjs\`

Expected: skill catalog and docs agree with the implemented commands and security boundary.

- [ ] **Step 6: Commit public truth**

\`\`\`bash
git add skills/oaf-memory docs/usage/semantic-setup.md docs/usage/README.md docs/product/memory-recall-developer-first.md PROJECT_STATUS.json README.md tests/skill-catalog.test.mjs tests/usage-docs.test.mjs
git commit -m "docs: explain governed semantic setup"
\`\`\`

### Task 6: End-to-End and Release Verification

**Files:**
- Modify only if verification reveals a scoped defect.

- [ ] **Step 1: Run static and protocol checks**

Run: \`npm run check && npm run protocol:validate\`

Expected: no lint/format/schema failures.

- [ ] **Step 2: Run the full automated suite**

Run: \`npm test && npm run eval && npm run ci\`

Expected: all test and evaluation assertions pass.

- [ ] **Step 3: Run installed-consumer verification**

Run: \`npm run consumer:smoke && npm run consumer:browser-smoke && npm run release:readiness:check\`

Expected: installed \`recall\` flow remains safe; public artifacts contain the new docs and no key/source-body leakage.

- [ ] **Step 4: Inspect the release diff**

Run: \`git diff --check && git status --short && npm pack --dry-run\`

Expected: no whitespace failures, only intended tracked changes, and package contents include required semantic package/docs/skill files.

- [ ] **Step 5: Commit final verified state**

\`\`\`bash
git add -A
git commit -m "feat: add governed semantic setup"
\`\`\`
