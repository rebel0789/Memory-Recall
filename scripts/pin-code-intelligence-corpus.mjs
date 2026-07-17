import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { CODE_INTELLIGENCE_TIER_1_LANGUAGES } from '../packages/protocol/src/code-intelligence-contract.mjs';
import { validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';

const execFileAsync = promisify(execFile);
const CANDIDATES_PATH = 'evals/code-intelligence/corpus-candidates.v1.json';
const CORPUS_PATH = 'evals/code-intelligence/corpus.v1.json';
const SCHEMA_PATH = 'packages/protocol/schemas/code-intelligence-benchmark-manifest.schema.json';
const HTTPS_GIT_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/u;
const HTTPS_LICENSE_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:blob|tree)\/HEAD\//u;
const COMMIT_RE = /^[a-f0-9]{40}$/u;
const LANGUAGE_ORDER = new Map(CODE_INTELLIGENCE_TIER_1_LANGUAGES.map((language, index) => [language, index]));

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function comparableRepository(repository) {
  const { commit: _commit, ...metadata } = repository;
  return metadata;
}

function compareRepositories(left, right) {
  return LANGUAGE_ORDER.get(left.primaryLanguage) - LANGUAGE_ORDER.get(right.primaryLanguage)
    || left.id.localeCompare(right.id);
}

function validateCandidates(candidates) {
  if (candidates?.schemaVersion !== '1.0.0' || candidates?.candidateVersion !== 'memory-recall-code-intelligence-candidates-1') {
    throw new Error('candidate_contract_invalid');
  }
  if (!Array.isArray(candidates.repositories) || candidates.repositories.length !== 43) throw new Error('candidate_count_invalid');
  const ids = new Set();
  const urls = new Set();
  for (const repository of candidates.repositories) {
    if (!repository?.id || ids.has(repository.id)) throw new Error('candidate_id_duplicate_or_missing');
    if (!HTTPS_GIT_RE.test(repository.url) || urls.has(repository.url)) throw new Error('candidate_url_invalid_or_duplicate');
    if (!LANGUAGE_ORDER.has(repository.primaryLanguage)) throw new Error('candidate_language_invalid');
    if (!['small', 'medium', 'large'].includes(repository.sizeClass) || !repository.role) throw new Error('candidate_metadata_missing');
    if (!repository.licenseExpression || !HTTPS_LICENSE_RE.test(repository.licenseUrl)) throw new Error('candidate_license_evidence_missing');
    const repositoryPrefix = repository.url.slice(0, -4);
    if (!repository.licenseUrl.startsWith(`${repositoryPrefix}/`)) throw new Error('candidate_license_repository_mismatch');
    if (Object.hasOwn(repository, 'commit')) throw new Error('candidate_commit_not_allowed');
    ids.add(repository.id);
    urls.add(repository.url);
  }
  for (const language of CODE_INTELLIGENCE_TIER_1_LANGUAGES) {
    if (candidates.repositories.filter((item) => item.primaryLanguage === language).length < 3) {
      throw new Error(`candidate_language_cardinality_invalid:${language}`);
    }
  }
}

async function resolveCommit(repository) {
  const { stdout } = await execFileAsync('git', ['ls-remote', repository.url, 'HEAD'], {
    encoding: 'utf8',
    maxBuffer: 65536,
    timeout: 30000,
    windowsHide: true
  });
  const match = String(stdout).match(/^([a-f0-9]{40})\tHEAD\n?$/u);
  if (!match || !COMMIT_RE.test(match[1])) throw new Error(`candidate_remote_head_invalid:${repository.id}`);
  return { ...repository, commit: match[1] };
}

async function resolveAll(repositories, previous, { refresh = false, concurrency = 6 } = {}) {
  const previousById = new Map((previous?.repositories ?? []).map((item) => [item.id, item]));
  const output = new Array(repositories.length);
  let next = 0;
  async function worker() {
    while (next < repositories.length) {
      const index = next;
      next += 1;
      const repository = repositories[index];
      const pinned = previousById.get(repository.id);
      output[index] = !refresh
        && pinned
        && JSON.stringify(comparableRepository(pinned)) === JSON.stringify(repository)
        ? pinned
        : await resolveCommit(repository);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, repositories.length) }, worker));
  return output.sort(compareRepositories);
}

function buildCorpus(candidates, repositories, previous = null) {
  const sourceCandidatesFingerprint = sha256(JSON.stringify(candidates));
  const stablePrevious = previous
    && previous.sourceCandidatesFingerprint === sourceCandidatesFingerprint
    && JSON.stringify(previous.repositories) === JSON.stringify(repositories);
  const payload = {
    schemaVersion: '1.0.0',
    corpusVersion: 'memory-recall-code-intelligence-corpus-1',
    generatedAt: stablePrevious ? previous.generatedAt : new Date().toISOString(),
    sourceCandidatesFingerprint,
    repositories
  };
  return { ...payload, corpusFingerprint: sha256(JSON.stringify(payload)) };
}

async function validateCorpus(corpus, candidates, schema) {
  const result = validateJsonSchema(schema, corpus);
  if (!result.valid) throw new Error(`corpus_schema_invalid:${result.errors.map((item) => item.path).join(',')}`);
  const expectedFingerprint = sha256(JSON.stringify(candidates));
  if (corpus.sourceCandidatesFingerprint !== expectedFingerprint) throw new Error('corpus_candidates_fingerprint_mismatch');
  const { corpusFingerprint: _fingerprint, ...payload } = corpus;
  if (corpus.corpusFingerprint !== sha256(JSON.stringify(payload))) throw new Error('corpus_fingerprint_mismatch');
  const expected = [...candidates.repositories].sort(compareRepositories);
  if (corpus.repositories.length !== expected.length) throw new Error('corpus_repository_count_mismatch');
  for (let index = 0; index < expected.length; index += 1) {
    const actual = corpus.repositories[index];
    if (JSON.stringify(comparableRepository(actual)) !== JSON.stringify(expected[index])) throw new Error(`corpus_metadata_mismatch:${expected[index].id}`);
    if (!COMMIT_RE.test(actual.commit)) throw new Error(`corpus_commit_invalid:${actual.id}`);
  }
}

async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, json(value), { mode: 0o600 });
  await rename(temporary, file);
}

async function readExistingCorpus() {
  try {
    return await readJson(CORPUS_PATH);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

const mode = process.argv[2];
if (!['--write', '--check', '--refresh'].includes(mode) || process.argv.length !== 3) {
  throw new Error('usage: node scripts/pin-code-intelligence-corpus.mjs --write|--check|--refresh');
}

const candidates = await readJson(CANDIDATES_PATH);
const schema = await readJson(SCHEMA_PATH);
validateCandidates(candidates);

if (mode === '--check') {
  const corpus = await readJson(CORPUS_PATH);
  await validateCorpus(corpus, candidates, schema);
  console.log(`Code-intelligence corpus check passed: ${corpus.repositories.length} immutable repository pins.`);
} else {
  const previous = await readExistingCorpus();
  const repositories = await resolveAll(candidates.repositories, previous, { refresh: mode === '--refresh' });
  const corpus = buildCorpus(candidates, repositories, previous);
  await validateCorpus(corpus, candidates, schema);
  if (mode === '--refresh') {
    const previousCommits = new Map((previous?.repositories ?? []).map((item) => [item.id, item.commit]));
    const changes = repositories
      .filter((item) => previousCommits.get(item.id) !== item.commit)
      .map((item) => ({ id: item.id, from: previousCommits.get(item.id) ?? null, to: item.commit }));
    console.log(json({ writeRequired: changes.length > 0, changes }).trimEnd());
  } else {
    await atomicWrite(CORPUS_PATH, corpus);
    console.log(`Pinned ${corpus.repositories.length} repositories in ${CORPUS_PATH}.`);
  }
}
