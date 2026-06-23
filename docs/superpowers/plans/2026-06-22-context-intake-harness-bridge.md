# Context Intake Harness Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Slice 1 of the OAF context intake harness bridge: a read-only scanner, schema, dry-run CLI, and tests for Codex, Claude Code, and Cursor project context files.

**Architecture:** Add a focused `packages/harness-context` domain package that scans documented harness files under a workspace root and emits schema-validated, sanitized `HarnessContextSource` records. Extend the existing `npm run oaf` CLI with `context scan --from <harness> --root <path> --dry-run`, with no import, network, adapter activation, or writes.

**Tech Stack:** Node 22 ESM, built-in `node:test`, built-in `fs/promises`, `path`, `crypto`, existing dependency-free JSON Schema validator.

---

## Scope

This plan implements only Slice 1 from
`docs/superpowers/specs/2026-06-22-context-intake-harness-bridge-design.md`.

Implemented:

- provider-neutral `harness-context-source` protocol schema;
- scanner package for Codex, Claude Code, and Cursor documented project files;
- deterministic fingerprints;
- redacted scan reports;
- CLI dry-run command;
- focused unit and CLI tests;
- protocol validation coverage.

Not implemented in this plan:

- proposal import;
- source snapshot persistence;
- memory writes;
- handoff export;
- MCP stdio wrapper;
- Supermemory adapter;
- MEX-compatible scaffold scanner;
- Graphify or Serena adapter;
- graph database or embedding integration;
- external network access;
- adapter activation;
- `PROJECT_STATUS.json` capability changes.

## File Structure

- Create `packages/protocol/schemas/harness-context-source.schema.json`
  - Protocol contract for each sanitized scanner output record.
- Create `examples/protocol/harness-context-source.json`
  - Valid example used by protocol validation.
- Modify `examples/protocol/compatibility/fixtures.json`
  - Add valid and invalid fixtures for the new schema.
- Create `examples/protocol/compatibility/invalid-harness-context-source.json`
  - Invalid fixture proving schema rejects raw or unsupported fields.
- Create `packages/harness-context/package.json`
  - Workspace package manifest with no runtime dependencies.
- Create `packages/harness-context/src/index.mjs`
  - Scanner implementation, redaction, deterministic hashing, path safety, and report building.
- Modify `apps/cli/oaf.mjs`
  - Add `oaf context scan --from <codex|claude|cursor|all> --root <path> --dry-run --json`.
- Modify `tests/cli.test.mjs`
  - Add CLI dry-run assertions.
- Create `tests/harness-context.test.mjs`
  - Unit tests for scanning, redaction, symlink denial, oversize handling, and determinism.
- Modify `README.md`
  - Add a short proposed-feature note pointing at the design spec and dry-run command only after tests pass.

Prior-art references captured in the design spec:

- `mex-memory/mex`: structured project-memory scaffold and drift checks;
- `safishamsi/graphify`: queryable knowledge graph over code, schemas, docs,
  scripts, and media;
- `oraios/serena`: MCP semantic retrieval and editing toolkit.

They are not runtime dependencies for this plan and are not enabled adapters.

## Task 1: Protocol Schema And Fixtures

**Files:**
- Create: `packages/protocol/schemas/harness-context-source.schema.json`
- Create: `examples/protocol/harness-context-source.json`
- Create: `examples/protocol/compatibility/invalid-harness-context-source.json`
- Modify: `examples/protocol/compatibility/fixtures.json`

- [ ] **Step 1: Add the failing protocol fixture references**

Modify `examples/protocol/compatibility/fixtures.json` by adding two fixture entries:

```json
{
  "id": "harness-context-source-valid",
  "schema": "packages/protocol/schemas/harness-context-source.schema.json",
  "instance": "examples/protocol/harness-context-source.json",
  "expectedValid": true
}
```

```json
{
  "id": "harness-context-source-invalid-raw-body",
  "schema": "packages/protocol/schemas/harness-context-source.schema.json",
  "instance": "examples/protocol/compatibility/invalid-harness-context-source.json",
  "expectedValid": false
}
```

- [ ] **Step 2: Create the valid fixture**

Create `examples/protocol/harness-context-source.json`:

```json
{
  "schemaVersion": "1.0.0",
  "id": "hctx_0123456789abcdef",
  "workspaceId": "ws_local",
  "harness": "codex",
  "sourceKind": "instruction",
  "scope": "repository",
  "trust": "user-authored",
  "dataClass": "workspace-private",
  "provenance": {
    "locator": "workspace://AGENTS.md",
    "contentHash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "byteSize": 128
  },
  "reviewStatus": "scan-only",
  "retention": "workspace",
  "bodyHash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "summary": "Repository instruction file discovered for Codex.",
  "redactions": {
    "secretCount": 0,
    "localPathCount": 0,
    "reasonCodes": []
  },
  "createdAt": "2026-06-22T00:00:00.000Z",
  "metadata": {
    "scannerVersion": "0.1.0"
  }
}
```

- [ ] **Step 3: Create the invalid fixture**

Create `examples/protocol/compatibility/invalid-harness-context-source.json`:

```json
{
  "schemaVersion": "1.0.0",
  "id": "hctx_invalid",
  "workspaceId": "ws_local",
  "harness": "codex",
  "sourceKind": "instruction",
  "scope": "repository",
  "trust": "user-authored",
  "dataClass": "workspace-private",
  "provenance": {
    "locator": "workspace://AGENTS.md",
    "contentHash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "byteSize": 128
  },
  "reviewStatus": "scan-only",
  "retention": "workspace",
  "bodyHash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "summary": "Repository instruction file discovered for Codex.",
  "rawBody": "This field must be rejected.",
  "redactions": {
    "secretCount": 0,
    "localPathCount": 0,
    "reasonCodes": []
  },
  "createdAt": "2026-06-22T00:00:00.000Z",
  "metadata": {
    "scannerVersion": "0.1.0"
  }
}
```

- [ ] **Step 4: Create the schema**

Create `packages/protocol/schemas/harness-context-source.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://open-agent-fabric.dev/schemas/harness-context-source-1.0.json",
  "title": "Harness Context Source",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "id",
    "workspaceId",
    "harness",
    "sourceKind",
    "scope",
    "trust",
    "dataClass",
    "provenance",
    "reviewStatus",
    "retention",
    "bodyHash",
    "summary",
    "redactions",
    "createdAt",
    "metadata"
  ],
  "properties": {
    "schemaVersion": { "const": "1.0.0" },
    "id": { "type": "string", "pattern": "^hctx_[a-f0-9]{16,64}$" },
    "workspaceId": { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
    "harness": { "enum": ["codex", "claude-code", "cursor", "opencode", "windsurf", "generic-mcp"] },
    "sourceKind": { "enum": ["instruction", "rule", "memory", "skill", "mcp-config", "command", "profile", "handoff"] },
    "scope": { "enum": ["user", "workspace", "repository", "team", "unknown"] },
    "trust": { "enum": ["user-authored", "tool-generated", "external", "unknown"] },
    "dataClass": { "enum": ["public", "workspace-private", "sensitive"] },
    "provenance": {
      "type": "object",
      "additionalProperties": false,
      "required": ["locator", "contentHash", "byteSize"],
      "properties": {
        "locator": { "type": "string", "pattern": "^(workspace|user-selected)://[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,512}$", "maxLength": 640 },
        "contentHash": { "type": "string", "pattern": "^sha256:[a-f0-9]{64}$" },
        "byteSize": { "type": "integer", "minimum": 0, "maximum": 65536 }
      }
    },
    "reviewStatus": { "enum": ["scan-only", "proposed", "accepted", "rejected", "quarantined"] },
    "retention": { "enum": ["session", "workspace", "durable", "unknown"] },
    "bodyHash": { "type": "string", "pattern": "^sha256:[a-f0-9]{64}$" },
    "summary": { "type": "string", "minLength": 1, "maxLength": 240 },
    "redactions": {
      "type": "object",
      "additionalProperties": false,
      "required": ["secretCount", "localPathCount", "reasonCodes"],
      "properties": {
        "secretCount": { "type": "integer", "minimum": 0, "maximum": 1024 },
        "localPathCount": { "type": "integer", "minimum": 0, "maximum": 1024 },
        "reasonCodes": {
          "type": "array",
          "maxItems": 16,
          "uniqueItems": true,
          "items": { "enum": ["secret_like_value", "local_path", "oversized", "binary", "symlink_escape", "unsupported_file"] }
        }
      }
    },
    "createdAt": { "type": "string", "format": "date-time" },
    "metadata": {
      "type": "object",
      "additionalProperties": { "type": ["string", "number", "integer", "boolean", "null"] },
      "maxProperties": 16
    }
  }
}
```

- [ ] **Step 5: Run protocol validation and observe failure before implementation**

Run:

```bash
npm run protocol:validate
```

Expected before the schema file exists: failure naming `harness-context-source.schema.json` as missing or unreadable.

- [ ] **Step 6: Run protocol validation after adding schema**

Run:

```bash
npm run protocol:validate
```

Expected after the files exist: all protocol fixtures pass, with the total count increased by 2 from the previous baseline.

- [ ] **Step 7: Commit schema and fixtures**

```bash
git add packages/protocol/schemas/harness-context-source.schema.json examples/protocol/harness-context-source.json examples/protocol/compatibility/invalid-harness-context-source.json examples/protocol/compatibility/fixtures.json
git commit -m "feat: add harness context source schema"
```

## Task 2: Scanner Package

**Files:**
- Create: `packages/harness-context/package.json`
- Create: `packages/harness-context/src/index.mjs`
- Test: `tests/harness-context.test.mjs`

- [ ] **Step 1: Write the first failing scanner tests**

Create `tests/harness-context.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanHarnessContext } from '../packages/harness-context/src/index.mjs';
import { assertJsonSchema } from '../packages/protocol/src/schema-validator.mjs';
import harnessContextSourceSchema from '../packages/protocol/schemas/harness-context-source.schema.json' with { type: 'json' };

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), 'oaf-harness-context-'));
}

test('scans Codex AGENTS.md without exposing raw content', async () => {
  const root = await workspace();
  await writeFile(path.join(root, 'AGENTS.md'), 'Use npm run ci. API_KEY=secret-value. Path /Users/rebel/private.txt');
  const report = await scanHarnessContext({ root, harnesses: ['codex'], workspaceId: 'ws_local', clock: () => '2026-06-22T00:00:00.000Z' });
  assert.equal(report.summary.totalAccepted, 1);
  assert.equal(report.sources[0].harness, 'codex');
  assert.equal(report.sources[0].sourceKind, 'instruction');
  assert.equal(report.sources[0].redactions.secretCount, 1);
  assert.equal(report.sources[0].redactions.localPathCount, 1);
  assertJsonSchema(harnessContextSourceSchema, report.sources[0], 'harness context source');
  assert(!JSON.stringify(report).includes('secret-value'));
  assert(!JSON.stringify(report).includes('/Users/rebel/private.txt'));
});

test('scans Claude Code and Cursor documented project files', async () => {
  const root = await workspace();
  await mkdir(path.join(root, '.claude'), { recursive: true });
  await mkdir(path.join(root, '.cursor', 'rules'), { recursive: true });
  await writeFile(path.join(root, 'CLAUDE.md'), 'Prefer deterministic tests.');
  await writeFile(path.join(root, '.cursor', 'rules', 'project.mdc'), 'Always run npm run check.');
  await writeFile(path.join(root, '.cursor', 'mcp.json'), '{"mcpServers":{}}');
  const report = await scanHarnessContext({ root, harnesses: ['claude-code', 'cursor'], workspaceId: 'ws_local', clock: () => '2026-06-22T00:00:00.000Z' });
  assert.deepEqual(report.sources.map((source) => `${source.harness}:${source.sourceKind}`).sort(), [
    'claude-code:instruction',
    'cursor:mcp-config',
    'cursor:rule'
  ]);
  for (const source of report.sources) assertJsonSchema(harnessContextSourceSchema, source, 'harness context source');
});

test('scanner skips oversized files and reports sanitized failures', async () => {
  const root = await workspace();
  await writeFile(path.join(root, 'AGENTS.md'), 'x'.repeat(70_000));
  const report = await scanHarnessContext({ root, harnesses: ['codex'], workspaceId: 'ws_local', maxBytes: 1024, clock: () => '2026-06-22T00:00:00.000Z' });
  assert.equal(report.summary.totalAccepted, 0);
  assert.equal(report.summary.totalSkipped, 1);
  assert.equal(report.skipped[0].reason, 'oversized');
  assert.equal(report.skipped[0].locator, 'workspace://AGENTS.md');
});

test('scanner rejects symlinks that escape workspace', async () => {
  const root = await workspace();
  const outside = await workspace();
  await writeFile(path.join(outside, 'outside.md'), 'outside secret');
  await symlink(path.join(outside, 'outside.md'), path.join(root, 'AGENTS.md'));
  const report = await scanHarnessContext({ root, harnesses: ['codex'], workspaceId: 'ws_local', clock: () => '2026-06-22T00:00:00.000Z' });
  assert.equal(report.summary.totalAccepted, 0);
  assert.equal(report.skipped[0].reason, 'symlink_escape');
  assert(!JSON.stringify(report).includes('outside secret'));
});

test('scanner output is deterministic for the same input and clock', async () => {
  const root = await workspace();
  await writeFile(path.join(root, 'AGENTS.md'), 'Use npm run ci.');
  const first = await scanHarnessContext({ root, harnesses: ['codex'], workspaceId: 'ws_local', clock: () => '2026-06-22T00:00:00.000Z' });
  const second = await scanHarnessContext({ root, harnesses: ['codex'], workspaceId: 'ws_local', clock: () => '2026-06-22T00:00:00.000Z' });
  assert.deepEqual(first, second);
});
```

- [ ] **Step 2: Run the scanner test and verify failure**

Run:

```bash
node --test tests/harness-context.test.mjs
```

Expected: fails with `Cannot find module '../packages/harness-context/src/index.mjs'`.

- [ ] **Step 3: Add package manifest**

Create `packages/harness-context/package.json`:

```json
{
  "name": "@open-agent-fabric/harness-context",
  "version": "0.2.0-dev",
  "type": "module",
  "private": true,
  "exports": "./src/index.mjs",
  "license": "Apache-2.0"
}
```

- [ ] **Step 4: Add scanner implementation**

Create `packages/harness-context/src/index.mjs`:

```js
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { assertJsonSchema } from '../../protocol/src/schema-validator.mjs';
import harnessContextSourceSchema from '../../protocol/schemas/harness-context-source.schema.json' with { type: 'json' };

export const HARNESS_CONTEXT_SCANNER_VERSION = '0.1.0';
const DEFAULT_MAX_BYTES = 64 * 1024;
const SUPPORTED_HARNESSES = new Set(['codex', 'claude-code', 'cursor']);
const SECRET_VALUE = /(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*["']?[^"'\s]+/ig;
const LOCAL_PATH = /\/Users\/[A-Za-z0-9._-]+\/[^\s"'`)]*/g;
const BINARY_BYTES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u;

const STATIC_SOURCES = Object.freeze({
  codex: [
    { relativePath: 'AGENTS.md', sourceKind: 'instruction', scope: 'repository', trust: 'user-authored' }
  ],
  'claude-code': [
    { relativePath: 'CLAUDE.md', sourceKind: 'instruction', scope: 'repository', trust: 'user-authored' }
  ],
  cursor: [
    { relativePath: '.cursorrules', sourceKind: 'rule', scope: 'repository', trust: 'user-authored' },
    { relativePath: '.cursor/mcp.json', sourceKind: 'mcp-config', scope: 'workspace', trust: 'user-authored' }
  ]
});

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hashRef(value) {
  return `sha256:${sha256(value)}`;
}

function posixRelative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function locator(relativePath) {
  return `workspace://${relativePath}`;
}

function redactText(text) {
  let secretCount = 0;
  let localPathCount = 0;
  const withoutSecrets = String(text).replace(SECRET_VALUE, () => {
    secretCount += 1;
    return '[redacted-secret]';
  });
  const redacted = withoutSecrets.replace(LOCAL_PATH, () => {
    localPathCount += 1;
    return '[redacted-local-path]';
  });
  const reasonCodes = [];
  if (secretCount) reasonCodes.push('secret_like_value');
  if (localPathCount) reasonCodes.push('local_path');
  return { redacted, secretCount, localPathCount, reasonCodes };
}

function summarize({ harness, sourceKind, relativePath, text }) {
  const { redacted } = redactText(text);
  const compact = redacted.replace(/\s+/g, ' ').trim();
  const prefix = `${harness} ${sourceKind} ${relativePath}`;
  const suffix = compact ? `: ${compact.slice(0, 120)}` : '';
  return `${prefix}${suffix}`.slice(0, 240);
}

async function resolveInside(rootReal, absolutePath) {
  const real = await realpath(absolutePath);
  const relative = path.relative(rootReal, real);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return { ok: false, reason: 'symlink_escape' };
  return { ok: true, real };
}

async function maybeReadSource({ root, rootReal, source, harness, workspaceId, maxBytes, createdAt }) {
  const absolute = path.resolve(root, source.relativePath);
  const relativePath = posixRelative(root, absolute);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return { skipped: { harness, locator: locator(source.relativePath), reason: 'symlink_escape' } };
  }
  let info;
  try {
    info = await lstat(absolute);
  } catch {
    return null;
  }
  const inside = await resolveInside(rootReal, absolute).catch(() => ({ ok: false, reason: 'symlink_escape' }));
  if (!inside.ok) return { skipped: { harness, locator: locator(source.relativePath), reason: inside.reason } };
  const realInfo = await stat(inside.real);
  if (!realInfo.isFile()) return { skipped: { harness, locator: locator(source.relativePath), reason: 'unsupported_file' } };
  if (info.isSymbolicLink() && inside.real === absolute) return { skipped: { harness, locator: locator(source.relativePath), reason: 'symlink_escape' } };
  if (realInfo.size > maxBytes) return { skipped: { harness, locator: locator(source.relativePath), reason: 'oversized' } };
  const body = await readFile(inside.real, 'utf8');
  if (BINARY_BYTES.test(body)) return { skipped: { harness, locator: locator(source.relativePath), reason: 'binary' } };
  const redacted = redactText(body);
  const contentHash = hashRef(body);
  const bodyHash = hashRef(redacted.redacted);
  const id = `hctx_${sha256(`${harness}:${source.relativePath}:${contentHash}`).slice(0, 24)}`;
  const item = {
    schemaVersion: '1.0.0',
    id,
    workspaceId,
    harness,
    sourceKind: source.sourceKind,
    scope: source.scope,
    trust: source.trust,
    dataClass: redacted.secretCount ? 'sensitive' : 'workspace-private',
    provenance: {
      locator: locator(source.relativePath),
      contentHash,
      byteSize: realInfo.size
    },
    reviewStatus: 'scan-only',
    retention: 'workspace',
    bodyHash,
    summary: summarize({ harness, sourceKind: source.sourceKind, relativePath: source.relativePath, text: body }),
    redactions: {
      secretCount: redacted.secretCount,
      localPathCount: redacted.localPathCount,
      reasonCodes: redacted.reasonCodes
    },
    createdAt,
    metadata: {
      scannerVersion: HARNESS_CONTEXT_SCANNER_VERSION
    }
  };
  assertJsonSchema(harnessContextSourceSchema, item, 'harness context source');
  return { item };
}

async function cursorRuleSources(root) {
  const rulesRoot = path.join(root, '.cursor', 'rules');
  let entries;
  try {
    entries = await readdir(rulesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mdc'))
    .map((entry) => ({
      relativePath: `.cursor/rules/${entry.name}`,
      sourceKind: 'rule',
      scope: 'repository',
      trust: 'user-authored'
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export async function scanHarnessContext({
  root = process.cwd(),
  harnesses = ['codex', 'claude-code', 'cursor'],
  workspaceId = 'ws_local',
  maxBytes = DEFAULT_MAX_BYTES,
  clock = () => new Date().toISOString()
} = {}) {
  const rootPath = path.resolve(root);
  const rootReal = await realpath(rootPath);
  const selected = harnesses.includes('all') ? [...SUPPORTED_HARNESSES] : harnesses;
  for (const harness of selected) {
    if (!SUPPORTED_HARNESSES.has(harness)) throw new Error(`unsupported_harness:${harness}`);
  }
  const createdAt = clock();
  const sources = [];
  const skipped = [];
  for (const harness of selected) {
    const definitions = [...(STATIC_SOURCES[harness] ?? [])];
    if (harness === 'cursor') definitions.push(...await cursorRuleSources(rootPath));
    for (const source of definitions) {
      const result = await maybeReadSource({ root: rootPath, rootReal, source, harness, workspaceId, maxBytes, createdAt });
      if (result?.item) sources.push(result.item);
      if (result?.skipped) skipped.push(result.skipped);
    }
  }
  sources.sort((left, right) => `${left.harness}:${left.provenance.locator}`.localeCompare(`${right.harness}:${right.provenance.locator}`));
  skipped.sort((left, right) => `${left.harness}:${left.locator}`.localeCompare(`${right.harness}:${right.locator}`));
  return {
    schemaVersion: '1.0.0',
    scannerVersion: HARNESS_CONTEXT_SCANNER_VERSION,
    workspaceId,
    rootFingerprint: hashRef(rootReal),
    summary: {
      totalAccepted: sources.length,
      totalSkipped: skipped.length,
      externalAdaptersEnabled: 0,
      externalWritesEnabled: false
    },
    sources,
    skipped
  };
}
```

- [ ] **Step 5: Run scanner tests**

Run:

```bash
node --test tests/harness-context.test.mjs
```

Expected: all scanner tests pass.

- [ ] **Step 6: Run protocol validation**

Run:

```bash
npm run protocol:validate
```

Expected: all protocol fixtures pass.

- [ ] **Step 7: Commit scanner package**

```bash
git add packages/harness-context/package.json packages/harness-context/src/index.mjs tests/harness-context.test.mjs
git commit -m "feat: add read-only harness context scanner"
```

## Task 3: CLI Dry-Run Command

**Files:**
- Modify: `apps/cli/oaf.mjs`
- Modify: `tests/cli.test.mjs`

- [ ] **Step 1: Add failing CLI tests**

Append these tests to `tests/cli.test.mjs`:

```js
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('context scan dry-run reports sanitized harness sources', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-cli-harness-'));
  writeFileSync(path.join(root, 'AGENTS.md'), 'Run npm run ci. token=secret-value. See /Users/rebel/private.txt');
  const result = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'context', 'scan', '--from', 'codex', '--root', root, '--dry-run'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.totalAccepted, 1);
  assert.equal(report.summary.externalAdaptersEnabled, 0);
  assert.equal(report.summary.externalWritesEnabled, false);
  assert(!result.stdout.includes('secret-value'));
  assert(!result.stdout.includes('/Users/rebel/private.txt'));
});

test('context scan rejects non-dry-run mode', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-cli-harness-'));
  writeFileSync(path.join(root, 'AGENTS.md'), 'Run npm run ci.');
  const result = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'context', 'scan', '--from', 'codex', '--root', root], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--dry-run is required/);
});
```

- [ ] **Step 2: Run CLI tests and verify failure**

Run:

```bash
node --test tests/cli.test.mjs
```

Expected: the new CLI dry-run test fails because `context scan` is not parsed.

- [ ] **Step 3: Modify CLI imports**

At the top of `apps/cli/oaf.mjs`, add:

```js
import { scanHarnessContext } from '../../packages/harness-context/src/index.mjs';
```

- [ ] **Step 4: Replace `contextCommand` with a subcommand dispatcher**

Replace the current `contextCommand` function with:

```js
async function contextCommand(values) {
  if (values[0] === 'scan') return contextScanCommand(values.slice(1));
  const requestPath = option(values, '--request');
  const recordsPath = option(values, '--records');
  if (!requestPath || !recordsPath) {
    console.error('context requires --request <json> and --records <json>, or context scan --from <harness> --dry-run');
    process.exitCode = 2;
    return;
  }
  const request = JSON.parse(await readFile(requestPath, 'utf8'));
  const records = JSON.parse(await readFile(recordsPath, 'utf8'));
  console.log(JSON.stringify(compileContext(request, records), null, 2));
}

async function contextScanCommand(values) {
  if (!values.includes('--dry-run')) {
    console.error('context scan requires --dry-run; import and writes are not implemented');
    process.exitCode = 2;
    return;
  }
  const from = option(values, '--from') ?? 'all';
  const root = option(values, '--root') ?? process.cwd();
  const workspaceId = option(values, '--workspace') ?? 'ws_local';
  const harnesses = from === 'all' ? ['all'] : from.split(',').map((item) => item.trim()).filter(Boolean);
  try {
    const report = await scanHarnessContext({ root, harnesses, workspaceId });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
```

- [ ] **Step 5: Update help output**

In the `help()` text inside `apps/cli/oaf.mjs`, add:

```text
  oaf context scan --from codex --root . --dry-run
```

Also keep this sentence unchanged in meaning:

```text
The default bootstrap is local-only and enables no external writes.
```

- [ ] **Step 6: Run CLI tests**

Run:

```bash
node --test tests/cli.test.mjs
```

Expected: all CLI tests pass.

- [ ] **Step 7: Commit CLI dry-run command**

```bash
git add apps/cli/oaf.mjs tests/cli.test.mjs
git commit -m "feat: add harness context scan dry run"
```

## Task 4: Docs And Verification

**Files:**
- Modify: `README.md`
- Modify only if behavior text needs it: `docs/superpowers/specs/2026-06-22-context-intake-harness-bridge-design.md`

- [ ] **Step 1: Add README beta note**

Add a short section near the CLI or quality-gates area of `README.md`:

```md
### Context Intake Preview

The proposed OAF-031 context intake bridge starts with a read-only dry run:

```bash
npm run oaf -- context scan --from codex --root . --dry-run
```

The scanner reports documented harness context files, redacts secret-like values
and private local paths, and writes no imports by default. Imported memory,
handoff export, MCP serving, and external memory adapters remain out of the
default bootstrap until separate reviewed tasks land.
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
node --test tests/harness-context.test.mjs tests/cli.test.mjs tests/protocol-schema-validator.test.mjs
```

Expected: all selected tests pass.

- [ ] **Step 3: Run protocol validation**

Run:

```bash
npm run protocol:validate
```

Expected: all fixtures pass, including the new valid and invalid harness context fixtures.

- [ ] **Step 4: Run repository checks**

Run:

```bash
npm run check
```

Expected: repository checks pass, external adapter contracts remain disabled, and no dependency is added to `package.json`.

- [ ] **Step 5: Run full CI**

Run:

```bash
npm run ci
```

Expected: check, protocol validation, tests, and evaluations all pass.

- [ ] **Step 6: Verify status boundaries**

Run:

```bash
npm run status
```

Expected:

- `Defaults: network=deny, externalWrites=false, model=deterministic, residency=local-only`
- `DISABLED` still includes `adapters.external` and `publishing.external`
- no new status capability is claimed for OAF-031.

- [ ] **Step 7: Commit docs and final verification updates**

```bash
git add README.md docs/superpowers/plans/2026-06-22-context-intake-harness-bridge.md
git commit -m "docs: document context intake preview"
```

## Self-Review Checklist

- Spec coverage:
  - Slice 1 schema: Task 1.
  - Slice 1 scanner: Task 2.
  - Slice 1 CLI dry-run: Task 3.
  - Slice 1 docs and verification: Task 4.
  - Proposal import, handoff export, MCP wrapper, and Supermemory adapter are excluded from this plan because the approved spec split them into separate slices.
- Placeholder scan:
  - The plan contains no unresolved placeholder markers and no unnamed files.
- Type consistency:
  - The schema uses `harness`, `sourceKind`, `scope`, `trust`, `dataClass`, `provenance`, `reviewStatus`, `retention`, `bodyHash`, `summary`, and `redactions`.
  - The scanner returns those same fields and validates them before adding records to the report.
  - The CLI calls `scanHarnessContext` and prints the same report object used in unit tests.

## Final Handoff Requirements

After implementation, report:

- files changed;
- exact test counts from `npm test`, `npm run protocol:validate`, and `npm run eval`;
- scanner result for a synthetic workspace;
- confirmation that external adapters remain disabled;
- confirmation that external writes remain false;
- known limitations;
- rollback commit range.
