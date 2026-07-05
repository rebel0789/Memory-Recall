import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const MODEL_ID = 'nomic-ai/nomic-embed-text-v1.5';
const MODEL_REVISION = 'e9b6763023c676ca8431644204f50c2b100d9aab';
const MODEL_LICENSE = 'Apache-2.0';
const EMBEDDING_TENSOR = 'embeddings.word_embeddings.weight';

const TOKEN_SEEDS = [
  '[UNK]',
  'accept',
  'accepted',
  'active',
  'affected',
  'all',
  'approve',
  'approved',
  'architecture',
  'back',
  'blast',
  'call',
  'calls',
  'change',
  'changed',
  'changes',
  'command',
  'context',
  'current',
  'database',
  'decision',
  'dependency',
  'detect',
  'edge',
  'edges',
  'explain',
  'fact',
  'facts',
  'file',
  'files',
  'function',
  'graph',
  'hybrid',
  'impact',
  'memory',
  'memories',
  'method',
  'module',
  'neighborhood',
  'path',
  'proposal',
  'proposals',
  'queue',
  'queued',
  'radius',
  'recall',
  'search',
  'semantic',
  'sql',
  'sqlite',
  'storage',
  'store',
  'symbol',
  'symbols',
  'truth',
  'workspace',
  'Store_approve_all',
  'Store_approve_proposal_uncommitted',
  'graph_explain_command',
  'Store_explain',
  'impact_detect_changes_command',
  'Store_affected_symbols_for_files',
  'rusqlite'
];

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function splitIdentifier(value) {
  return value
    .replace(/([a-z])([A-Z])/gu, '$1 $2')
    .replace(/([A-Za-z])([0-9])/gu, '$1 $2')
    .replace(/([0-9])([A-Za-z])/gu, '$1 $2')
    .replace(/[:_-]+/gu, ' ');
}

function wordPiece(word, vocab) {
  const normalized = word.toLowerCase();
  const out = [];
  let start = 0;
  while (start < normalized.length) {
    let end = normalized.length;
    let current = null;
    while (start < end) {
      const piece = start === 0 ? normalized.slice(start, end) : `##${normalized.slice(start, end)}`;
      if (vocab.has(piece)) {
        current = piece;
        break;
      }
      end -= 1;
    }
    if (!current) return ['[UNK]'];
    out.push(current);
    start = end;
  }
  return out;
}

function expandedTokens(seeds, vocab) {
  const tokens = new Set();
  for (const seed of seeds) {
    for (const raw of splitIdentifier(seed).split(/[^A-Za-z0-9]+/u).filter(Boolean)) {
      for (const piece of wordPiece(raw, vocab)) tokens.add(piece);
    }
  }
  return [...tokens].sort();
}

const model = arg('--model');
const vocabPath = arg('--vocab');
const outPath = arg('--out', path.join(ROOT, 'rust/oaf-store/src/semantic_table.json'));
assert.ok(model, 'usage: node scripts/build-rust-semantic-table.mjs --model model.safetensors --vocab vocab.txt [--out path]');
assert.ok(vocabPath, 'usage: node scripts/build-rust-semantic-table.mjs --model model.safetensors --vocab vocab.txt [--out path]');

const vocabRows = readFileSync(vocabPath, 'utf8').split(/\r?\n/u).filter(Boolean);
const vocab = new Set(vocabRows);
const tokenIds = new Map(vocabRows.map((token, index) => [token, index]));
const tokens = expandedTokens(TOKEN_SEEDS, vocab).filter((token) => tokenIds.has(token));

const fd = openSync(model, 'r');
try {
  const headerLen = Buffer.alloc(8);
  readSync(fd, headerLen, 0, 8, 0);
  const headerSize = Number(headerLen.readBigUInt64LE(0));
  const headerBuf = Buffer.alloc(headerSize);
  readSync(fd, headerBuf, 0, headerSize, 8);
  const header = JSON.parse(headerBuf.toString('utf8'));
  const tensor = header[EMBEDDING_TENSOR];
  assert.ok(tensor, `missing ${EMBEDDING_TENSOR}`);
  assert.equal(tensor.dtype, 'F32');
  assert.equal(tensor.shape.length, 2);
  const [rows, dimensions] = tensor.shape;
  assert.ok(rows >= vocabRows.length, `embedding rows ${rows} must cover vocab rows ${vocabRows.length}`);
  const dataStart = 8 + headerSize + tensor.data_offsets[0];
  const table = [];
  for (const token of tokens) {
    const row = tokenIds.get(token);
    const buf = Buffer.alloc(dimensions * 4);
    readSync(fd, buf, 0, buf.length, dataStart + row * dimensions * 4);
    const values = [];
    let maxAbs = 0;
    for (let index = 0; index < dimensions; index += 1) {
      const value = buf.readFloatLE(index * 4);
      values.push(value);
      maxAbs = Math.max(maxAbs, Math.abs(value));
    }
    const scale = maxAbs === 0 ? 1 : maxAbs / 127;
    table.push({
      token,
      scale: Number(scale.toPrecision(8)),
      vector: values.map((value) => Math.max(-127, Math.min(127, Math.round(value / scale))))
    });
  }
  const artifact = {
    schemaVersion: '1.0.0',
    source: {
      model: MODEL_ID,
      revision: MODEL_REVISION,
      license: MODEL_LICENSE,
      tensor: EMBEDDING_TENSOR,
      modelSha256: sha256(model),
      vocabSha256: sha256(vocabPath)
    },
    quantization: { dtype: 'int8', perTokenScale: true },
    dimensions,
    tokenCount: table.length,
    tokens: table
  };
  writeFileSync(outPath, `${JSON.stringify(artifact)}\n`);
  console.log(JSON.stringify({ outPath, tokenCount: table.length, dimensions, modelSha256: artifact.source.modelSha256, vocabSha256: artifact.source.vocabSha256 }, null, 2));
} finally {
  closeSync(fd);
}
