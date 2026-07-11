# Semantic Setup

Semantic setup turns selected repository documentation into reviewed Memory
Recall proposals. It does not perform semantic retrieval. The default flow uses
the coding agent that is already active; an optional direct API flow is
experimental.

## What the packet contains

The deterministic selector considers root documentation and configuration files
plus Markdown under `docs/adr` and `docs/architecture`. Semantic setup v1 does
not scan or upload raw source-code files.

One packet contains at most 8 sources, 16 KiB per source, and 64 KiB total. It
skips secret-like content, symlink escapes, generated Recall output, unsupported
encodings, and files outside those limits.

The plan is body-free:

```bash
recall semantic plan --harness codex --root . --dry-run
```

The report shows workspace-relative locators, hashes, byte counts, skipped
counts, and the packet fingerprint. It writes nothing and makes no model or
network call.

## Use the active coding agent

Render a task for `codex`, `claude-code`, `cursor`, or `generic`:

```bash
recall semantic task --harness codex --root .
```

Task output is intentionally not a normal JSON report. It is a bounded prompt
on stdout and includes the selected source bodies. The CLI does not invoke the
selected harness. Give that task to the agent that is already running and save
its strict JSON response as `semantic-result.json` inside the workspace.

The response has this shape:

```json
{
  "schemaVersion": "1.0.0",
  "packetFingerprint": "sha256:<packet fingerprint>",
  "facts": [
    {
      "sourceIds": ["src_001"],
      "subject": "project:example",
      "predicate": "uses",
      "object": "sqlite",
      "text": "The project uses SQLite."
    }
  ]
}
```

The result may contain at most 24 facts. Each fact must cite packet source IDs;
it cannot supply trusted locators, hashes, authority, or supersession.

Import reads one workspace-relative JSON file:

```bash
recall semantic import --input semantic-result.json --root . --sqlite .local/memory.sqlite
```

The import file must be a regular non-symlink file no larger than 256 KiB.
Import rebuilds the current packet, requires the current fingerprint, validates
every fact, and queues pending proposals. It does not create ACTIVE memory.

## Review and activate

```bash
recall memory review --root . --sqlite .local/memory.sqlite --format summary
recall memory approve <mpq_id> --root . --sqlite .local/memory.sqlite --format json
```

Bulk approval skips semantic setup proposals. Named approval rehashes every
cited source before activation. If any primary or secondary source is missing,
changed, unsafe, symlinked, or oversized, approval returns
`semantic_source_changed` and leaves the proposal pending and unclaimed.

Reject that stale proposal, rerun the semantic task, and import a result bound to
the new packet:

```bash
recall memory reject <mpq_id> --root . --sqlite .local/memory.sqlite --format json
recall semantic task --harness codex --root .
recall semantic import --input semantic-result.json --root . --sqlite .local/memory.sqlite
```

MCP remains read-only. Ordinary `memory.recall` excludes pending proposals and
returns a semantic fact only after named approval succeeds.

## Optional direct API execution

Direct execution sends the same selected packet in one explicitly consented
request. It runs outside the model gateway and is not a silent fallback.

Gemini uses a pinned endpoint, model, and `GEMINI_API_KEY` environment variable:

```bash
GEMINI_API_KEY=<user-owned-key> recall semantic run --provider gemini --allow-network --root . --sqlite .local/memory.sqlite
```

An OpenAI-compatible provider requires an HTTPS endpoint (or literal local
loopback), model identifier, and environment-variable name:

```bash
MODEL_API_KEY=<user-owned-key> recall semantic run --provider openai-compatible --endpoint https://api.example.com/v1/chat/completions --model model-id --api-key-env MODEL_API_KEY --allow-network --root . --sqlite .local/memory.sqlite
```

Memory Recall checks `--allow-network` before reading the credential. It does
not persist the API key. Only selected documentation and configuration bodies
leave the machine. The executor makes one request with no automatic retry,
provider fallback, streaming mode, or background sync. A failure requires a new
explicit command.

When a provider returns bounded usage counts, the report includes input and
output token counts. Those usage counts are not a provider billing guarantee.
Memory Recall does not estimate price or enforce a cost budget for this
experimental path.

## Limits

- No automatic harness invocation or arbitrary provider discovery.
- No background sync, transcript capture, raw source-code upload, embeddings,
  vector search, or automatic ACTIVE memory.
- No key storage, provider URL in reports, or prompt/model output in reports.
- No write-capable MCP command.
- No benchmark or quality claim for model-generated facts. Review remains
  required.
