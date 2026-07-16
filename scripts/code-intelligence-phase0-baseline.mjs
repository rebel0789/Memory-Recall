import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  CODE_INTELLIGENCE_TIER_1_LANGUAGES,
  CODE_INTELLIGENCE_TIER_2_LANGUAGES
} from '../packages/protocol/src/code-intelligence-contract.mjs';

const execFileAsync = promisify(execFile);
const COMMANDS = Object.freeze([
  ['node', ['--test', 'tests/ast-code-candidate-source.test.mjs', 'tests/source-graph-index-store.test.mjs', 'tests/mcp-code-intelligence.test.mjs']],
  ['cargo', ['build', '--release', '--manifest-path', 'rust/Cargo.toml']],
  ['cargo', ['test', '--manifest-path', 'rust/Cargo.toml']],
  ['node', ['scripts/rust-ingest-quality.mjs']],
  ['node', ['scripts/rust-typed-calls-quality.mjs']],
  ['node', ['scripts/rust-incremental-quality.mjs']]
]);
const COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_OUTPUT = 'evals/code-intelligence/results/phase0-baseline.json';

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function fileFingerprint(file) {
  return sha256(await readFile(file));
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function smallCommand(file, args) {
  const { stdout } = await execFileAsync(file, args, {
    encoding: 'utf8',
    maxBuffer: 65536,
    timeout: 30000,
    windowsHide: true
  });
  return String(stdout).trim();
}

function runCommand(file, args) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const stdoutHash = createHash('sha256');
    const stderrHash = createHash('sha256');
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    const child = spawn(file, args, { cwd: process.cwd(), env: process.env, shell: false, windowsHide: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, COMMAND_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      stdoutHash.update(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      stderrHash.update(chunk);
    });

    function finish(exitCode, signal = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const durationMs = Number((process.hrtime.bigint() - started) / 1000000n);
      resolve({
        command: [file, ...args].join(' '),
        exitCode,
        signal,
        timedOut,
        durationMs,
        stdoutBytes,
        stderrBytes,
        stdoutSha256: `sha256:${stdoutHash.digest('hex')}`,
        stderrSha256: `sha256:${stderrHash.digest('hex')}`
      });
    }

    child.once('error', (error) => {
      stderrHash.update(String(error?.code ?? 'spawn_error'));
      finish(-1);
    });
    child.once('close', (code, signal) => finish(Number.isInteger(code) ? code : -1, signal));
  });
}

function parseOutputPath(argv) {
  if (argv.length === 0) return DEFAULT_OUTPUT;
  if (argv.length !== 2 || argv[0] !== '--out' || !argv[1]) throw new Error(`usage: node scripts/code-intelligence-phase0-baseline.mjs --out ${DEFAULT_OUTPUT}`);
  const repositoryRoot = path.resolve(process.cwd());
  const output = path.resolve(repositoryRoot, argv[1]);
  if (path.isAbsolute(argv[1]) || (output !== repositoryRoot && !output.startsWith(`${repositoryRoot}${path.sep}`))) {
    throw new Error('baseline_output_path_invalid');
  }
  return path.relative(repositoryRoot, output);
}

async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

const outputPath = parseOutputPath(process.argv.slice(2));
const currentCommit = await smallCommand('git', ['rev-parse', 'HEAD']);
if (!/^[a-f0-9]{40}$/u.test(currentCommit)) throw new Error('baseline_commit_invalid');
const dirtyBeforeBaseline = (await smallCommand('git', ['status', '--porcelain'])).length > 0;
const rustVersion = await smallCommand('rustc', ['--version']);
if (!/^rustc [0-9]+\.[0-9]+\.[0-9]+/u.test(rustVersion)) throw new Error('baseline_rust_version_invalid');

const commands = [];
for (const [file, args] of COMMANDS) {
  const receipt = await runCommand(file, args);
  commands.push(receipt);
  if (receipt.exitCode !== 0) throw new Error(`baseline_command_failed:${receipt.command}:${receipt.exitCode}`);
}

const corpus = await readJson('evals/code-intelligence/corpus.v1.json');
const gates = await readJson('evals/code-intelligence/benchmark-gates.v1.json');
const report = {
  schemaVersion: '1.0.0',
  reportVersion: 'memory-recall-code-intelligence-phase0-baseline-1',
  phase: 0,
  generatedAt: new Date().toISOString(),
  environment: {
    platform: os.platform(),
    architecture: os.arch(),
    nodeVersion: process.version,
    rustVersion
  },
  checkout: {
    commit: currentCommit,
    dirtyBeforeBaseline
  },
  inputs: {
    capabilityMatrixFingerprint: await fileFingerprint('evals/code-intelligence/capability-matrix.v1.json'),
    corpusFingerprint: corpus.corpusFingerprint,
    benchmarkGatesFingerprint: await fileFingerprint('evals/code-intelligence/benchmark-gates.v1.json'),
    languageFullGate: gates.languageFull
  },
  publicEngine: {
    id: 'node-bounded-static',
    status: 'implemented',
    productionFacing: true,
    languageIds: ['javascript', 'typescript'],
    limitation: 'The public graph path remains bounded JavaScript and TypeScript static analysis.'
  },
  experimentalEngine: {
    id: 'rust-tree-sitter',
    status: 'experimental',
    productionFacing: false,
    languageIds: [...CODE_INTELLIGENCE_TIER_1_LANGUAGES, ...CODE_INTELLIGENCE_TIER_2_LANGUAGES].sort(),
    limitation: 'The Rust engine is not selected by the public npm CLI, MCP server, or web workbench.'
  },
  competitors: {
    gitnexus: {
      status: 'unmeasured',
      reason: 'No identical-commit head-to-head run is part of Phase 0.'
    },
    codebaseMemoryMcp: {
      status: 'unmeasured',
      reason: 'No identical-commit head-to-head run is part of Phase 0.'
    }
  },
  commands,
  claims: {
    parity: false,
    leadership: false,
    reason: 'Phase 0 verifies current local paths only; competitor and fourteen-language workflow gates remain unmeasured.'
  },
  safeguards: {
    rawCommandOutputStored: false,
    absoluteRepositoryRootStored: false,
    environmentVariablesStored: false,
    competitorClaimsInferred: false
  }
};
const payload = JSON.stringify(report);
report.reportFingerprint = sha256(payload);
await atomicWrite(outputPath, report);
console.log(`Phase 0 baseline passed ${commands.length} commands and wrote ${outputPath}.`);
