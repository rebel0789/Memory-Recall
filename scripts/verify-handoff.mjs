import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const commands = [
  ['npm run check', ['run', 'check']],
  ['npm run protocol:validate', ['run', 'protocol:validate']],
  ['npm test', ['test']],
  ['npm run eval', ['run', 'eval']],
  ['npm run demo', ['run', 'demo']],
  ['npm run native:smoke', ['run', 'native:smoke']]
];
const results = [];
for (const [label, args] of commands) {
  console.log(`\n== ${label} ==`);
  const started = Date.now();
  const result = spawnSync(npm, args, { stdio: 'inherit', env: { ...process.env, OAF_ALLOW_NETWORK: 'false', OAF_ALLOW_EXTERNAL_WRITES: 'false', OAF_MODEL_MODE: 'deterministic' } });
  results.push({ command: label, exitCode: result.status ?? 1, durationMs: Date.now() - started });
  if (result.status !== 0) {
    console.error(`Handoff verification stopped at ${label}.`);
    process.exit(result.status ?? 1);
  }
}
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const report = {
  schemaVersion: '1.0.0',
  project: packageJson.name,
  version: packageJson.version,
  verifiedAt: new Date().toISOString(),
  environment: { platform: os.platform(), release: os.release(), architecture: os.arch(), node: process.versions.node },
  safety: { network: 'denied', externalWrites: false, modelMode: 'deterministic' },
  commands: results,
  result: 'passed'
};
await writeFile('HANDOFF_VERIFICATION.json', `${JSON.stringify(report, null, 2)}\n`);
const manifest = spawnSync(npm, ['run', 'manifest'], { stdio: 'inherit' });
if (manifest.status !== 0) process.exit(manifest.status ?? 1);
console.log('\nHandoff verification passed. HANDOFF_VERIFICATION.json and REPOSITORY_MANIFEST.json are current.');
