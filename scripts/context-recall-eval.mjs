import { readFile, readdir, stat } from 'node:fs/promises';
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
const FALLBACK_EXCLUDED_DIRS = new Set(['.git', '.local', '.scratch', '.claude', '.cursor', '.github', '.playwright-cli', 'node_modules', 'coverage', 'context-packs', 'graphify-out', 'output']);
const FALLBACK_EXCLUDED_FILES = new Set(['.env', '.DS_Store', 'REPOSITORY_MANIFEST.json.tmp']);

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

function rankedTerms(value, max = 180) {
  const counts = new Map();
  let ordinal = 0;
  const firstSeen = new Map();
  for (const raw of String(value ?? '').toLowerCase().replace(/[^a-z0-9_./:-]+/g, ' ').split(/\s+/)) {
    for (const term of [raw, ...raw.split(/[/.:-]+/).filter(Boolean)]) {
      if (term.length < 2 || STOP_WORDS.has(term)) continue;
      if (!firstSeen.has(term)) firstSeen.set(term, ordinal);
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
    ordinal += 1;
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || firstSeen.get(left[0]) - firstSeen.get(right[0]) || left[0].localeCompare(right[0]))
    .slice(0, max)
    .map(([term]) => term);
}

function locatorTerms(filePath, body) {
  return [...new Set([...terms(filePath, 80), ...rankedTerms(body, 180)])];
}

function normalizeRelativePath(value) {
  return path.posix.normalize(String(value ?? '').replaceAll('\\', '/'));
}

async function listCorpusFiles(root) {
  try {
    const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split('\n')
      .map(normalizeRelativePath)
      .filter(Boolean);
    if (tracked.length > 0) return tracked;
  } catch {
    // Package archives do not include .git metadata. Fall back to the packaged file tree.
  }

  const files = [];
  async function walkDir(directory, relativeDirectory = '') {
    const entries = (await readdir(directory, { withFileTypes: true }).catch(() => []))
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const relativePath = normalizeRelativePath(relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name);
      if (entry.isDirectory()) {
        if (FALLBACK_EXCLUDED_DIRS.has(entry.name) || FALLBACK_EXCLUDED_DIRS.has(relativePath)) continue;
        await walkDir(path.join(directory, entry.name), relativePath);
      } else if (entry.isFile()) {
        if (FALLBACK_EXCLUDED_FILES.has(entry.name) || FALLBACK_EXCLUDED_FILES.has(relativePath)) continue;
        files.push(relativePath);
      }
    }
  }

  await walkDir(root);
  return files.sort();
}

async function buildCorpus({ root = process.cwd(), maxFileBytes = 200_000, chunkChars = 10_000, excludePaths = [] } = {}) {
  const tracked = await listCorpusFiles(root);
  const trackedSet = new Set(tracked);
  const excluded = new Set(excludePaths.map(normalizeRelativePath));
  const chunks = [];
  const locators = [];
  let trackedTextFiles = 0;
  let fullCorpusTokens = 0;

  for (const filePath of tracked) {
    if (excluded.has(filePath)) continue;
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
    locators.push({
      id: `obs_locator_${String(locators.length + 1).padStart(6, '0')}`,
      path: filePath,
      text: `${filePath}\nlocator-only\nUse this locator to recover the tracked source file.`,
      tokens: estimateTokens(`${filePath}\nlocator-only\nUse this locator to recover the tracked source file.`),
      tags: locatorTerms(filePath, body)
    });

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

  const locatorRecords = locators.map((locator) => ({
    id: locator.id,
    kind: 'observation',
    workspaceId: 'ws_context_recall',
    title: `${locator.path} locator`,
    text: locator.text,
    tags: locator.tags,
    relations: locator.tags.slice(0, 40),
    scope: 'workspace-private',
    dataClass: 'workspace-private',
    trustClass: 'observed',
    status: 'active',
    source: 'git-tracked-oaf-file-locator',
    tokens: locator.tokens,
    confidence: 0.7,
    authority: locator.path.startsWith('docs/architecture/') ? 0.95 : 0.7,
    updatedAt: FIXED_TIME,
    metadata: { path: locator.path, representation: 'locator-only' }
  }));

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

  return { trackedSet, records: [...locatorRecords, ...records], trackedTextFiles, chunks: chunks.length, fileLocators: locatorRecords.length, fullCorpusTokens };
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

function summarizeCase(testCase, selected, fullCorpusTokens, { budget, durationMs = 0 } = {}) {
  const selectedPaths = [...new Set(selected.map((item) => item.metadata?.path).filter(Boolean))];
  const hitGold = testCase.goldFiles.filter((filePath) => selectedPaths.includes(filePath));
  const omittedRequiredFiles = testCase.goldFiles.filter((filePath) => !hitGold.includes(filePath));
  const returnedTokens = selected.reduce((sum, item) => sum + item.tokens, 0);
  return {
    id: testCase.id,
    hit: hitGold.length > 0,
    fileRecall: testCase.goldFiles.length ? hitGold.length / testCase.goldFiles.length : 0,
    goldCount: testCase.goldFiles.length,
    hitGold,
    omittedRequiredFiles,
    omittedRequiredFileCount: omittedRequiredFiles.length,
    selectedPaths,
    selectedCount: selected.length,
    returnedTokens,
    windowUtilization: budget > 0 ? returnedTokens / budget : 0,
    savingsRatio: 1 - (returnedTokens / fullCorpusTokens),
    durationMs
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

function workspaceRelative(root, filePath) {
  const relative = path.relative(root, path.resolve(root, filePath)).split(path.sep).join('/');
  return relative && !relative.startsWith('../') ? relative : null;
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

function summarizeExternalCase(testCase, row, fullCorpusTokens, { durationMs = 0 } = {}) {
  const hitGold = testCase.goldFiles.filter((filePath) => row.selectedPaths.includes(filePath));
  const omittedRequiredFiles = testCase.goldFiles.filter((filePath) => !hitGold.includes(filePath));
  return {
    id: testCase.id,
    hit: hitGold.length > 0,
    fileRecall: testCase.goldFiles.length ? hitGold.length / testCase.goldFiles.length : 0,
    goldCount: testCase.goldFiles.length,
    hitGold,
    omittedRequiredFiles,
    omittedRequiredFileCount: omittedRequiredFiles.length,
    selectedPaths: row.selectedPaths,
    selectedCount: row.selectedPaths.length,
    returnedTokens: row.returnedTokens,
    windowUtilization: row.budget > 0 ? row.returnedTokens / row.budget : 0,
    savingsRatio: 1 - (row.returnedTokens / fullCorpusTokens),
    durationMs
  };
}

function summarizeBudget({ budget, cases, fullCorpusTokens }) {
  const hitCases = cases.filter((item) => item.hit).length;
  const durationMs = cases.reduce((sum, item) => sum + item.durationMs, 0);
  return {
    budget,
    metrics: {
      hitRate: hitCases / cases.length,
      avgFileRecall: cases.reduce((sum, item) => sum + item.fileRecall, 0) / cases.length,
      avgReturnedTokens: Math.round(cases.reduce((sum, item) => sum + item.returnedTokens, 0) / cases.length),
      avgWindowUtilization: cases.reduce((sum, item) => sum + item.windowUtilization, 0) / cases.length,
      avgSavingsRatio: cases.reduce((sum, item) => sum + item.savingsRatio, 0) / cases.length,
      totalOmittedRequiredFileCount: cases.reduce((sum, item) => sum + item.omittedRequiredFileCount, 0),
      durationMs,
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
  const suiteStarted = process.hrtime.bigint();
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

  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const datasetRelativePath = workspaceRelative(root, datasetPath);
  const corpus = await buildCorpus({ root, excludePaths: datasetRelativePath ? [datasetRelativePath] : [] });
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
      const caseStarted = process.hrtime.bigint();
      if (mode === 'external-baseline-json') {
        const row = externalBaseline.rows.get(resultKey(testCase.id, budget));
        if (!row) throw new Error(`missing baseline result: ${resultKey(testCase.id, budget)}`);
        const durationMs = Math.max(0, Math.round(Number(process.hrtime.bigint() - caseStarted) / 1_000_000));
        caseResults.push(summarizeExternalCase(testCase, row, corpus.fullCorpusTokens, { durationMs }));
      } else {
        const selected = await selectRows({ mode, testCase, budget, candidateLimit, reader, recordsById });
        const durationMs = Math.max(0, Math.round(Number(process.hrtime.bigint() - caseStarted) / 1_000_000));
        caseResults.push(summarizeCase(testCase, selected, corpus.fullCorpusTokens, { budget, durationMs }));
      }
    }
    results.push(summarizeBudget({ budget, cases: caseResults, fullCorpusTokens: corpus.fullCorpusTokens }));
  }

  const target = results.find((item) => item.budget === targetBudget) ?? results[0];
  const failures = gateResult(target, dataset.thresholds);
  const passingBudgets = results.filter((item) => gateResult(item, dataset.thresholds).length === 0).map((item) => item.budget).sort((a, b) => a - b);
  const suiteDurationMs = Math.max(0, Math.round(Number(process.hrtime.bigint() - suiteStarted) / 1_000_000));
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
      fileLocators: corpus.fileLocators,
      fullCorpusTokens: corpus.fullCorpusTokens
    },
    candidateLimit,
    thresholds: dataset.thresholds,
    gate: {
      budget: target.budget,
      failures,
      minPassingBudget: passingBudgets[0] ?? null
    },
    gateDecision: failures.length ? 'fail' : 'pass',
    suiteDurationMs,
    results
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 2;
});
