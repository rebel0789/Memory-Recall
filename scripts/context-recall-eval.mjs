import { readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  CODE_SEARCH_CONTEXT_SELECTION_POLICY,
  compileContextFromSources,
  createFixtureRecordReader
} from '../packages/context-compiler/src/index.mjs';

const FIXED_TIME = '2026-06-30T00:00:00.000Z';
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.md', '.css', '.html', '.yml', '.yaml', '.toml', '.sql', '.txt', '.schema', '.lock']);
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'over', 'under', 'when', 'where', 'which', 'what', 'then', 'than', 'were', 'been', 'have', 'has', 'had', 'are', 'is', 'was', 'will', 'can', 'not', 'all', 'any', 'same', 'repo', 'file', 'files', 'source', 'code']);

function usage() {
  return [
    'Usage: node scripts/context-recall-eval.mjs --dataset <path> [--mode lexical-pack|compiler-code-search|external-baseline-json] [--baseline-results <path>] [--budgets 8000,12000] [--candidate-limit 50]',
    '',
    'Runs a tracked-repo context recall benchmark. Reports safe paths and metrics only.'
  ].join('\n');
}

function argValue(args, name, fallback = null) {
  const index = args.lastIndexOf(name);
  return index === -1 ? fallback : args[index + 1] ?? fallback;
}

function estimateTokens(value) {
  return Math.max(1, Math.ceil(String(value ?? '').length / 4));
}

function terms(value, max = 120) {
  const out = [];
  const seen = new Set();
  for (const raw of String(value ?? '').toLowerCase().replace(/[^a-z0-9_./:-]+/g, ' ').split(/\s+/)) {
    for (const term of [raw, ...raw.split(/[/.:-]+/).filter(Boolean)]) {
      if (term.length < 2 || STOP_WORDS.has(term) || seen.has(term)) continue;
      seen.add(term);
      out.push(term);
      if (out.length >= max) return out;
    }
  }
  return out;
}

async function buildCorpus({ root = process.cwd(), maxFileBytes = 200_000, chunkChars = 10_000 } = {}) {
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const trackedSet = new Set(tracked);
  const chunks = [];
  let trackedTextFiles = 0;
  let fullCorpusTokens = 0;

  for (const filePath of tracked) {
    const ext = path.extname(filePath);
    if (!TEXT_EXTENSIONS.has(ext) && !filePath.endsWith('AGENTS.md') && !filePath.endsWith('README')) continue;

    const absolute = path.join(root, filePath);
    const fileStat = await stat(absolute).catch(() => null);
    if (!fileStat?.isFile() || fileStat.size > maxFileBytes) continue;

    const buffer = await readFile(absolute);
    if (buffer.includes(0)) continue;

    const body = buffer.toString('utf8');
    trackedTextFiles += 1;
    fullCorpusTokens += estimateTokens(`${filePath}\n${body}`);

    const totalChunks = Math.max(1, Math.ceil(body.length / chunkChars));
    for (let index = 0; index < totalChunks; index += 1) {
      const slice = body.slice(index * chunkChars, (index + 1) * chunkChars);
      const text = `${filePath}\nchunk ${index + 1}/${totalChunks}\n${slice}`;
      chunks.push({
        id: `obs_file_${String(chunks.length + 1).padStart(6, '0')}`,
        path: filePath,
        chunk: index + 1,
        totalChunks,
        text,
        tokens: estimateTokens(text),
        tags: terms(`${filePath} ${slice.slice(0, 6000)}`)
      });
    }
  }

  const records = chunks.map((chunk) => ({
    id: chunk.id,
    kind: 'observation',
    workspaceId: 'ws_context_recall',
    title: `${chunk.path} chunk ${chunk.chunk}`,
    text: chunk.text,
    tags: chunk.tags,
    relations: chunk.tags.slice(0, 40),
    scope: 'workspace-private',
    dataClass: 'workspace-private',
    trustClass: 'observed',
    status: 'active',
    source: 'git-tracked-oaf-file-chunk',
    tokens: chunk.tokens,
    confidence: 0.75,
    authority: chunk.path.startsWith('docs/architecture/') ? 0.95 : 0.7,
    updatedAt: FIXED_TIME,
    metadata: { path: chunk.path, chunk: chunk.chunk, totalChunks: chunk.totalChunks }
  }));

  return { trackedSet, records, trackedTextFiles, chunks: chunks.length, fullCorpusTokens };
}

function lexicalScore(record) {
  return Number(record.metadata?.retrieval?.lexicalScore ?? 0);
}

function compareRows(left, right) {
  return lexicalScore(right) - lexicalScore(left) || left.tokens - right.tokens || left.id.localeCompare(right.id);
}

function packRows(rows, budget) {
  const byPath = new Map();
  for (const row of rows) {
    const filePath = row.metadata?.path;
    if (!filePath) continue;
    const list = byPath.get(filePath) ?? [];
    list.push(row);
    byPath.set(filePath, list);
  }

  for (const list of byPath.values()) list.sort(compareRows);
  const firstChunks = [...byPath.values()].map((list) => list[0]).sort(compareRows);
  const remainingChunks = [...byPath.values()].flatMap((list) => list.slice(1)).sort(compareRows);

  const selected = [];
  let used = 0;
  for (const row of [...firstChunks, ...remainingChunks]) {
    if (selected.some((item) => item.id === row.id)) continue;
    if (used + row.tokens > budget) continue;
    selected.push(row);
    used += row.tokens;
  }
  return selected;
}

function summarizeCase(testCase, selected, fullCorpusTokens) {
  const selectedPaths = [...new Set(selected.map((item) => item.metadata?.path).filter(Boolean))];
  const hitGold = testCase.goldFiles.filter((filePath) => selectedPaths.includes(filePath));
  const returnedTokens = selected.reduce((sum, item) => sum + item.tokens, 0);
  return {
    id: testCase.id,
    hit: hitGold.length > 0,
    fileRecall: testCase.goldFiles.length ? hitGold.length / testCase.goldFiles.length : 0,
    goldCount: testCase.goldFiles.length,
    hitGold,
    selectedPaths,
    selectedCount: selected.length,
    returnedTokens,
    savingsRatio: 1 - (returnedTokens / fullCorpusTokens)
  };
}

function resultKey(caseId, budget) {
  return `${caseId}:${budget}`;
}

function safeRelativeFilePath(value, { trackedSet }) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('baseline selectedFiles must contain non-empty strings');
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    normalized.startsWith('~') ||
    path.isAbsolute(normalized)
  ) {
    throw new Error(`unsafe baseline path: ${value}`);
  }
  if (!trackedSet.has(normalized)) throw new Error(`baseline path is not tracked: ${normalized}`);
  return normalized;
}

async function readExternalBaseline(filePath, { trackedSet }) {
  const baseline = JSON.parse(await readFile(filePath, 'utf8'));
  const baselineId = String(baseline.baselineId ?? '');
  if (baseline.schemaVersion !== '1.0.0') throw new Error('baseline schemaVersion must be 1.0.0');
  if (!/^[a-z0-9._-]{1,80}$/.test(baselineId)) throw new Error('baselineId must be a safe slug');
  if (!Array.isArray(baseline.results)) throw new Error('baseline results must be an array');

  const rows = new Map();
  for (const item of baseline.results) {
    if (typeof item?.caseId !== 'string' || !item.caseId) throw new Error('baseline result caseId is required');
    if (!Number.isInteger(item.budget) || item.budget < 1) throw new Error(`baseline result ${item.caseId} has invalid budget`);
    if (!Number.isInteger(item.returnedTokens) || item.returnedTokens < 0) throw new Error(`baseline result ${item.caseId} has invalid returnedTokens`);
    if (!Array.isArray(item.selectedFiles)) throw new Error(`baseline result ${item.caseId} selectedFiles must be an array`);

    const key = resultKey(item.caseId, item.budget);
    if (rows.has(key)) throw new Error(`duplicate baseline result: ${key}`);
    rows.set(key, {
      caseId: item.caseId,
      budget: item.budget,
      returnedTokens: item.returnedTokens,
      selectedPaths: [...new Set(item.selectedFiles.map((selected) => safeRelativeFilePath(selected, { trackedSet })))]
    });
  }

  return { baselineId, rows };
}

function summarizeExternalCase(testCase, row, fullCorpusTokens) {
  const hitGold = testCase.goldFiles.filter((filePath) => row.selectedPaths.includes(filePath));
  return {
    id: testCase.id,
    hit: hitGold.length > 0,
    fileRecall: testCase.goldFiles.length ? hitGold.length / testCase.goldFiles.length : 0,
    goldCount: testCase.goldFiles.length,
    hitGold,
    selectedPaths: row.selectedPaths,
    selectedCount: row.selectedPaths.length,
    returnedTokens: row.returnedTokens,
    savingsRatio: 1 - (row.returnedTokens / fullCorpusTokens)
  };
}

function summarizeBudget({ budget, cases, fullCorpusTokens }) {
  const hitCases = cases.filter((item) => item.hit).length;
  return {
    budget,
    metrics: {
      hitRate: hitCases / cases.length,
      avgFileRecall: cases.reduce((sum, item) => sum + item.fileRecall, 0) / cases.length,
      avgReturnedTokens: Math.round(cases.reduce((sum, item) => sum + item.returnedTokens, 0) / cases.length),
      avgSavingsRatio: cases.reduce((sum, item) => sum + item.savingsRatio, 0) / cases.length,
      fullCorpusTokens
    },
    cases
  };
}

function gateResult(result, thresholds) {
  const failures = [];
  if (result.metrics.hitRate < thresholds.hitRateMin) failures.push('hit_rate');
  if (result.metrics.avgFileRecall < thresholds.avgFileRecallMin) failures.push('avg_file_recall');
  if (result.metrics.avgReturnedTokens > thresholds.avgReturnedTokensMax) failures.push('avg_returned_tokens');
  if (result.metrics.avgSavingsRatio < thresholds.avgSavingsRatioMin) failures.push('avg_savings_ratio');
  return failures;
}

function requestForCase(testCase, budget, candidateLimit) {
  return {
    schemaVersion: '1.0.0',
    id: `ctxreq_${testCase.id}_${budget}`,
    requestId: `ctxreq_${testCase.id}_${budget}`,
    correlationId: `corr_${testCase.id}_${budget}`,
    workspaceId: 'ws_context_recall',
    actorId: 'usr_context_recall',
    taskId: 'task_context_recall',
    objective: testCase.query,
    step: testCase.query,
    requiredIds: [],
    requiredEntities: terms(testCase.query, 24),
    allowedDataClasses: ['workspace-private'],
    allowedTrustClasses: ['observed', 'verified', 'trusted'],
    allowedScopes: ['workspace-private'],
    sourcePlan: [{ kind: 'lexical', required: true, limit: candidateLimit, timeoutMs: 10000 }],
    perSourceLimit: candidateLimit,
    totalCandidateLimit: candidateLimit,
    tokenBudget: budget,
    trustedTimestamp: FIXED_TIME,
    now: FIXED_TIME
  };
}

async function selectRows({ mode, testCase, budget, candidateLimit, reader, recordsById }) {
  if (mode === 'lexical-pack') {
    const rows = await reader.searchLexical({
      workspaceId: 'ws_context_recall',
      query: testCase.query,
      limit: candidateLimit,
      allowedScopes: ['workspace-private'],
      statuses: ['active'],
      at: FIXED_TIME
    });
    return packRows(rows, budget);
  }

  if (mode === 'compiler-code-search') {
    const compiled = await compileContextFromSources(requestForCase(testCase, budget, candidateLimit), {
      recordReader: reader,
      selectionPolicy: CODE_SEARCH_CONTEXT_SELECTION_POLICY,
      clock: () => FIXED_TIME
    });
    return compiled.manifest.selected.map((item) => recordsById.get(item.id)).filter(Boolean);
  }

  throw new Error(`unknown mode: ${mode}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(usage());
    return;
  }

  const datasetPath = argValue(args, '--dataset');
  if (!datasetPath) throw new Error('missing --dataset');

  const dataset = JSON.parse(await readFile(datasetPath, 'utf8'));
  const mode = argValue(args, '--mode', 'compiler-code-search');
  const budgets = String(argValue(args, '--budgets', dataset.targetBudget ?? 12000)).split(',').map((value) => Number(value.trim())).filter(Number.isInteger);
  const candidateLimit = Number(argValue(args, '--candidate-limit', 50));
  const targetBudget = Number(argValue(args, '--target-budget', dataset.targetBudget ?? budgets[0]));
  const baselineResultsPath = argValue(args, '--baseline-results');
  if (!budgets.length || !Number.isInteger(candidateLimit) || candidateLimit < 1) throw new Error('invalid budget or candidate limit');
  if (mode === 'external-baseline-json' && !baselineResultsPath) throw new Error('missing --baseline-results');

  const corpus = await buildCorpus();
  const reader = createFixtureRecordReader(corpus.records);
  const recordsById = new Map(corpus.records.map((record) => [record.id, record]));
  const externalBaseline = mode === 'external-baseline-json' ? await readExternalBaseline(baselineResultsPath, { trackedSet: corpus.trackedSet }) : null;
  const cases = dataset.cases.map((testCase) => ({
    ...testCase,
    goldFiles: testCase.goldFiles.filter((filePath) => corpus.trackedSet.has(filePath))
  }));

  const results = [];
  for (const budget of budgets) {
    const caseResults = [];
    for (const testCase of cases) {
      if (mode === 'external-baseline-json') {
        const row = externalBaseline.rows.get(resultKey(testCase.id, budget));
        if (!row) throw new Error(`missing baseline result: ${resultKey(testCase.id, budget)}`);
        caseResults.push(summarizeExternalCase(testCase, row, corpus.fullCorpusTokens));
      } else {
        const selected = await selectRows({ mode, testCase, budget, candidateLimit, reader, recordsById });
        caseResults.push(summarizeCase(testCase, selected, corpus.fullCorpusTokens));
      }
    }
    results.push(summarizeBudget({ budget, cases: caseResults, fullCorpusTokens: corpus.fullCorpusTokens }));
  }

  const target = results.find((item) => item.budget === targetBudget) ?? results[0];
  const failures = gateResult(target, dataset.thresholds);
  const report = {
    schemaVersion: '1.0.0',
    datasetId: dataset.id,
    suite: dataset.suite,
    mode,
    ...(externalBaseline ? { baselineId: externalBaseline.baselineId } : {}),
    generatedAt: FIXED_TIME,
    corpus: {
      trackedTextFiles: corpus.trackedTextFiles,
      chunks: corpus.chunks,
      fullCorpusTokens: corpus.fullCorpusTokens
    },
    candidateLimit,
    thresholds: dataset.thresholds,
    gate: { budget: target.budget, failures },
    gateDecision: failures.length ? 'fail' : 'pass',
    results
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 2;
});
