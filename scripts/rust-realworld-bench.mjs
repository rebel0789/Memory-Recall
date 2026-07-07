import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { peakRssMb, timedSpawn } from './timing.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUST_BIN = path.join(ROOT, 'rust/target/release/oaf');
const FIXED_NOW = '2026-06-30T02:00:00.000Z';
const BASELINE_FILE_CAP = 8;
const BASELINE_CONTEXT_LINES = 30;
const SMALL_FILE_LINES = 140;

const REPOS = [
  {
    label: 'dtolnay/itoa',
    dir: 'itoa',
    url: 'https://github.com/dtolnay/itoa.git',
    question: {
      id: 'buffer-format-helper',
      query: 'buffer format helper',
      searchTerm: 'pub fn format',
      expected: ['method:Buffer_format', 'function:write']
    }
  },
  {
    label: 'pallets/flask',
    dir: 'flask',
    url: 'https://github.com/pallets/flask.git',
    question: {
      id: 'flask-route-dispatch',
      query: 'route dispatch',
      searchTerm: 'dispatch_request',
      expected: ['method:Flask_dispatch_request', 'method:Scaffold_method_route']
    }
  },
  {
    label: 'expressjs/express',
    dir: 'express',
    url: 'https://github.com/expressjs/express.git',
    question: {
      id: 'express-router-middleware',
      query: 'router middleware',
      searchTerm: 'middleware',
      expected: ['route:GET_middleware', 'module:examples_route_middleware_index']
    }
  },
  {
    label: 'sinatra/sinatra',
    dir: 'sinatra',
    url: 'https://github.com/sinatra/sinatra.git',
    question: {
      id: 'sinatra-base-route',
      query: 'base route',
      searchTerm: 'def route',
      expected: ['method:Base_route', 'function:routes']
    }
  },
  {
    label: 'antirez/kilo',
    dir: 'kilo',
    url: 'https://github.com/antirez/kilo.git',
    question: {
      id: 'kilo-refresh-screen',
      query: 'editor refresh screen',
      searchTerm: 'editorRefreshScreen',
      expected: ['function:editorRefreshScreen', 'function:abAppend']
    }
  }
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW },
    ...options
  });
  assert.equal(result.status, options.expectedStatus ?? 0, `${command} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  return result;
}

function timedJson(command, args, options = {}) {
  const started = performance.now();
  const result = timedSpawn(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW },
    ...options
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return {
    value: JSON.parse(result.stdout),
    ms: Number((performance.now() - started).toFixed(3)),
    peakRssMb: peakRssMb(result.stderr)
  };
}

function runJson(command, args, options = {}) {
  return JSON.parse(run(command, args, options).stdout);
}

function oaf(root, sqlite, args) {
  return runJson(RUST_BIN, [...args, '--root', root, '--sqlite', sqlite, '--format', 'json']);
}

function rows(sqlite, sql) {
  const db = new DatabaseSync(sqlite);
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

function cloneRepo(repo, parent) {
  const target = path.join(parent, repo.dir);
  run('git', ['clone', '--depth', '1', repo.url, target], { cwd: parent });
  return target;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function startUi(root, sqlite, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(RUST_BIN, ['ui', '--root', root, '--sqlite', sqlite, '--port', String(port), '--format', 'json'], {
      cwd: ROOT,
      env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (settled) return;
      try {
        const info = JSON.parse(stdout);
        settled = true;
        resolve({ child, info });
      } catch {
        // wait for full JSON startup receipt
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!settled) reject(new Error(`oaf ui exited early ${code}: ${stderr || stdout}`));
    });
  });
}

function ingestRepo(root) {
  const sqlite = path.join(root, '.local', 'realworld.sqlite');
  const timed = timedJson(RUST_BIN, [
    'ingest',
    '--root', root,
    '--sqlite', sqlite,
    '--format', 'json',
    '--workers', '4',
    '--max-memory', '350',
    '--max-file-mb', '2'
  ]);
  assert.equal(timed.value.safeguards.proposalGated, true);
  assert.equal(timed.value.safeguards.singleWriterCommit, true);
  assert.equal(timed.value.safeguards.unsafeBlocks, 0);
  oaf(root, sqlite, ['memory', 'approve', '--all']);
  return { sqlite, timed };
}

function evaluateSearch(root, sqlite, question, mode) {
  const args = ['search', '--query', question.query, '--mode', mode, '--limit', '8'];
  if (mode !== 'keyword') args.push('--semantic');
  const report = oaf(root, sqlite, args);
  const body = JSON.stringify(report.hits);
  const hits = question.expected.filter((needle) => body.includes(needle)).length;
  return {
    grade: hits === question.expected.length ? 'PASS' : hits > 0 ? 'PARTIAL' : 'FAIL',
    hits,
    tokens: estimateTokens(JSON.stringify(report)),
    toolCalls: 1,
    topSubjects: report.hits.slice(0, 5).map((hit) => hit.fact.subject),
    topValues: report.hits.slice(0, 5).map((hit) => hit.fact.value),
    semantic: report.semantic
  };
}

function fileBaseline(root, question) {
  const grep = spawnSync('git', ['grep', '-n', '-I', '-F', '--', question.searchTerm], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  assert.ok(grep.status === 0 || grep.status === 1, grep.stderr || grep.stdout);
  const matches = parseGrep(grep.stdout.trim());
  const files = [...new Set(matches.map((match) => match.file))]
    .filter((file) => existsSync(path.join(root, file)))
    .slice(0, BASELINE_FILE_CAP);
  const snippets = files.map((file) => matchedSnippet(root, file, matches.filter((match) => match.file === file).map((match) => match.line)));
  const combined = [grep.stdout.trim(), ...snippets].join('\n');
  const hits = question.expected.filter((needle) => combined.includes(needle.replace(/^(function|method|module|route):/, '').replaceAll('_', '')) || combined.includes(needle.replace(/^(function|method|module|route):/, ''))).length;
  return {
    grade: hits === question.expected.length ? 'PASS' : hits > 0 ? 'PARTIAL' : 'MISS',
    hits,
    tokens: estimateTokens(combined),
    toolCalls: 1 + files.length,
    searchTerm: question.searchTerm,
    grepMatchCount: matches.length,
    matchedFileCount: new Set(matches.map((match) => match.file)).size,
    filesRead: files,
    fileCap: BASELINE_FILE_CAP,
    contextLines: BASELINE_CONTEXT_LINES
  };
}

function parseGrep(output) {
  if (!output) return [];
  return output.split(/\r?\n/u).flatMap((line) => {
    const match = /^(.*?):(\d+):(.*)$/u.exec(line);
    return match ? [{ file: match[1], line: Number(match[2]) }] : [];
  });
}

function matchedSnippet(root, file, matchLines) {
  const lines = readFileSync(path.join(root, file), 'utf8').split(/\r?\n/u);
  if (lines.length <= SMALL_FILE_LINES) {
    return `--- ${file}:1-${lines.length} ---\n${lines.join('\n')}`;
  }
  return mergeWindows(matchLines.map((line) => ({
    start: Math.max(1, line - BASELINE_CONTEXT_LINES),
    end: Math.min(lines.length, line + BASELINE_CONTEXT_LINES)
  }))).map((window) => {
    const body = lines.slice(window.start - 1, window.end).join('\n');
    return `--- ${file}:${window.start}-${window.end} ---\n${body}`;
  }).join('\n');
}

function mergeWindows(windows) {
  const merged = [];
  for (const window of windows.sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (!last || window.start > last.end + 1) {
      merged.push({ ...window });
    } else {
      last.end = Math.max(last.end, window.end);
    }
  }
  return merged;
}

function languageCounts(sqlite) {
  const counts = {};
  for (const row of rows(sqlite, `
    SELECT source, count(*) AS count
    FROM memory_facts
    WHERE predicate = 'IS_A' AND subject LIKE 'file:%'
    GROUP BY source
  `)) {
    const ext = path.extname(row.source.replace('workspace://', '')).slice(1) || 'none';
    counts[ext] = (counts[ext] ?? 0) + 1;
  }
  return counts;
}

function aggregateRepoResults(results) {
  const totals = results.reduce((acc, item) => {
    acc.graphTokens += item.quality.hybrid.tokens;
    acc.baselineTokens += item.quality.fileBaseline.tokens;
    acc.graphToolCalls += item.quality.hybrid.toolCalls;
    acc.baselineToolCalls += item.quality.fileBaseline.toolCalls;
    acc.keywordHits += item.quality.keyword.hits;
    acc.hybridHits += item.quality.hybrid.hits;
    return acc;
  }, { graphTokens: 0, baselineTokens: 0, graphToolCalls: 0, baselineToolCalls: 0, keywordHits: 0, hybridHits: 0 });
  return {
    repoCount: results.length,
    graphTokens: totals.graphTokens,
    baselineTokens: totals.baselineTokens,
    graphToolCalls: totals.graphToolCalls,
    baselineToolCalls: totals.baselineToolCalls,
    tokenReduction: Number((1 - totals.graphTokens / Math.max(1, totals.baselineTokens)).toFixed(3)),
    toolCallReduction: Number((1 - totals.graphToolCalls / Math.max(1, totals.baselineToolCalls)).toFixed(3)),
    keywordExpectedHits: totals.keywordHits,
    hybridExpectedHits: totals.hybridHits
  };
}

function runAgentSessionUseCase(kiloRoot, sqlite) {
  const explain = oaf(kiloRoot, sqlite, ['graph', 'explain', '--entity', 'function:editorRefreshScreen', '--depth', '1']);
  const body = JSON.stringify(explain);
  return {
    task: 'Find the screen refresh neighborhood in a real C editor repo.',
    entity: 'function:editorRefreshScreen',
    edgeMentionsAbAppend: body.includes('function:abAppend'),
    tokens: estimateTokens(body),
    toolCalls: 1,
    status: body.includes('function:editorRefreshScreen') ? 'PASS' : 'FAIL'
  };
}

function runConversationUseCase(parent) {
  const root = path.join(parent, 'conversation-usecase');
  const sqlite = path.join(root, '.local', 'memory.sqlite');
  mkdirSync(path.join(root, '.local'), { recursive: true });
  writeFileSync(path.join(root, 'seed.json'), JSON.stringify({
    facts: [
      { subject: 'repo:kilo', predicate: 'PRIMARY_LANGUAGE', object: 'c', source: 'workspace://seed.json', confidence: 'extracted' },
      { subject: 'repo:kilo', predicate: 'HAS_ENTRYPOINT', object: 'main', source: 'workspace://seed.json', confidence: 'extracted' }
    ]
  }, null, 2));
  oaf(root, sqlite, ['memory', 'remember', '--batch', 'seed.json']);
  oaf(root, sqlite, ['memory', 'approve', '--all']);
  writeFileSync(path.join(root, 'chat-export.json'), JSON.stringify({ messages: [{ role: 'user', content: 'Kilo uses editorRefreshScreen as its screen refresh hub.' }] }, null, 2));
  writeFileSync(path.join(root, 'candidates.json'), JSON.stringify({
    transcriptSource: 'workspace://chat-export.json',
    facts: [
      { subject: 'repo:kilo', predicate: 'HAS_ENTRYPOINT', object: 'main', source: 'workspace://chat-export.json', confidence: 'extracted' },
      { subject: 'repo:kilo', predicate: 'SCREEN_REFRESH_HUB', object: 'editorRefreshScreen', source: 'workspace://chat-export.json', confidence: 'extracted' }
    ]
  }, null, 2));
  const report = oaf(root, sqlite, ['memory', 'consolidate', '--batch', 'candidates.json']);
  assert.equal(report.safeguards.modelCalls, 0);
  assert.equal(report.safeguards.networkCalls, 0);
  return {
    task: 'Consolidate host-extracted repo notes from a chat export.',
    operationCounts: report.summary.operationCounts,
    proposalCount: report.summary.proposalCount,
    transcriptContentTrusted: report.safeguards.transcriptContentTrusted,
    semanticModel: report.consolidationReceipt.semanticRetrieval.model,
    status: report.summary.operationCounts.ADD === 1 && report.summary.operationCounts.NOOP === 1 ? 'PASS' : 'FAIL'
  };
}

async function runWikiUseCase(kiloRoot, sqlite) {
  const port = await freePort();
  let child;
  try {
    const started = await startUi(kiloRoot, sqlite, port);
    child = started.child;
    const html = await fetch(`${started.info.url}/wiki`).then((response) => response.text());
    const wiki = await fetch(`${started.info.url}/api/wiki`).then((response) => response.json());
    assert.match(html, /OAF Knowledge Wiki/u);
    assert.equal(/https?:\/\//u.test(html), false);
    assert.equal(/cdn\./iu.test(html), false);
    assert.equal(wiki.summary.zeroCdn, true);
    assert.equal(wiki.summary.modelCalls, 0);
    assert.equal(wiki.summary.networkCalls, 0);
    return {
      task: 'Serve the local wiki over a real approved repo graph.',
      entityPageCount: wiki.summary.entityPageCount,
      decisionPageCount: wiki.summary.decisionPageCount,
      currentFactCount: wiki.summary.currentFactCount,
      htmlBytes: html.length,
      zeroCdn: wiki.summary.zeroCdn,
      networkCalls: wiki.summary.networkCalls,
      status: wiki.summary.zeroCdn ? 'PASS' : 'FAIL'
    };
  } finally {
    if (child) child.kill();
  }
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text).length / 4));
}

assert.equal(existsSync(RUST_BIN), true, 'rust/target/release/oaf must exist; run cargo build --release --manifest-path rust/Cargo.toml first');

const temp = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-realworld-'));
try {
  const repoResults = [];
  let kiloRuntime = null;
  for (const repo of REPOS) {
    const root = cloneRepo(repo, temp);
    const ingest = ingestRepo(root);
    const keyword = evaluateSearch(root, ingest.sqlite, repo.question, 'keyword');
    const hybrid = evaluateSearch(root, ingest.sqlite, repo.question, 'hybrid');
    const fileBaselineReport = fileBaseline(root, repo.question);
    const result = {
      label: repo.label,
      cloneUrl: repo.url,
      question: repo.question,
      ingest: {
        wallMs: ingest.timed.ms,
        extractionMs: ingest.timed.value.summary.elapsedMs,
        peakRssMb: ingest.timed.peakRssMb,
        parsedFileCount: ingest.timed.value.summary.parsedFileCount,
        skippedFileCount: ingest.timed.value.summary.skippedFileCount,
        generatedFactCount: ingest.timed.value.summary.generatedFactCount,
        proposalCount: ingest.timed.value.summary.proposalCount,
        generatedCallCount: ingest.timed.value.summary.generatedCallCount,
        languageCounts: languageCounts(ingest.sqlite)
      },
      quality: {
        keyword,
        hybrid,
        fileBaseline: fileBaselineReport,
        tokenReduction: Number((1 - hybrid.tokens / Math.max(1, fileBaselineReport.tokens)).toFixed(3)),
        toolCallReduction: Number((1 - hybrid.toolCalls / Math.max(1, fileBaselineReport.toolCalls)).toFixed(3))
      }
    };
    repoResults.push(result);
    if (repo.dir === 'kilo') {
      kiloRuntime = { root, sqlite: ingest.sqlite };
    }
  }
  assert.ok(kiloRuntime, 'kilo repo must be available for use cases');
  const useCases = {
    agentSession: runAgentSessionUseCase(kiloRuntime.root, kiloRuntime.sqlite),
    conversationalConsolidate: runConversationUseCase(temp),
    wiki: await runWikiUseCase(kiloRuntime.root, kiloRuntime.sqlite)
  };
  const aggregate = aggregateRepoResults(repoResults);
  assert.ok(repoResults.every((item) => item.quality.hybrid.grade !== 'FAIL'), 'hybrid search must find at least one expected key per real repo');
  assert.ok(useCases.agentSession.status === 'PASS');
  assert.ok(useCases.conversationalConsolidate.status === 'PASS');
  assert.ok(useCases.wiki.status === 'PASS');
  console.log(JSON.stringify({
    schemaVersion: '1.0.0',
    command: 'rust realworld bench',
    methodology: 'Fresh shallow clones of five public repos; runtime is local-only after clone. Ingest is timed with platform /usr/bin/time RSS output. Quality compares one hybrid semantic search per repo against keyword search and a realistic git-grep plus capped-snippet baseline; no model calls, cloud, external DB, or network at OAF runtime.',
    repos: repoResults,
    aggregate,
    useCases,
    bugHunt: {
      exercised: ['mixed language repos', 'single large C file', 'route-heavy Python/JS/Ruby repos', 'proposal approval after real ingest', 'local wiki over real graph'],
      foundOpenInThisHarness: []
    },
    safeguards: {
      modelCalls: 0,
      externalDatabase: false,
      networkAtRuntimeAfterClone: false,
      proposalGated: true
    },
    status: 'PASS'
  }, null, 2));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
