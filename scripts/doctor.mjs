import process from 'node:process';
import { access, readFile } from 'node:fs/promises';
import os from 'node:os';

const checks = [];
const nodeMajor = Number(process.versions.node.split('.')[0]);
checks.push({ name: 'Node.js >= 22', passed: nodeMajor >= 22, value: process.versions.node });
checks.push({ name: 'Loopback default', passed: (process.env.OAF_HOST ?? '127.0.0.1') === '127.0.0.1', value: process.env.OAF_HOST ?? '127.0.0.1' });
checks.push({ name: 'Network denied by default', passed: (process.env.OAF_ALLOW_NETWORK ?? 'false') !== 'true' });
checks.push({ name: 'External writes disabled', passed: (process.env.OAF_ALLOW_EXTERNAL_WRITES ?? 'false') !== 'true' });
checks.push({ name: 'Deterministic model default', passed: (process.env.OAF_MODEL_MODE ?? 'deterministic') === 'deterministic' });
for (const file of ['AGENTS.md', 'PROJECT_STATUS.json', 'PRODUCT.md', 'DESIGN.md', 'docs/implementation/BUILD_ORDER.md', 'planning/backlog.json', 'providers/native/catalog.json']) {
  checks.push({ name: `Required ${file}`, passed: await access(file).then(() => true).catch(() => false) });
}
const state = await readFile('.local/state.json', 'utf8').then(JSON.parse).catch(() => null);
checks.push({ name: 'Bootstrap state readable', passed: Boolean(state), value: state ? `${state.runs?.length ?? 0} runs` : 'run npm run bootstrap' });
try {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE VIRTUAL TABLE smoke_fts USING fts5(text);');
  database.close();
  checks.push({ name: 'Native SQLite with FTS5', passed: true, value: 'available' });
} catch (error) {
  checks.push({ name: 'Native SQLite with FTS5', passed: false, value: error.message });
}
console.log(`Environment: ${os.platform()} ${os.release()} ${os.arch()}`);
for (const check of checks) console.log(`${check.passed ? 'PASS' : 'FAIL'} ${check.name}${check.value ? ` — ${check.value}` : ''}`);
if (checks.some((check) => !check.passed)) process.exitCode = 1;
