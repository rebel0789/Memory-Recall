import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const output = 'REPOSITORY_MANIFEST.json';
const excludedDirectories = new Set([
  '.git',
  '.local',
  '.playwright-cli',
  '.scratch',
  '.claude',
  '.cursor',
  '.github',
  'node_modules',
  'coverage',
  'context-packs',
  'graphify-out',
  'output'
]);
const excludedRelativeDirectories = new Set([
  'docs/research',
  'docs/superpowers'
]);
const excludedFiles = new Set([output, '.env']);
const excludedFileNames = new Set(['.DS_Store']);

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function isExcludedDirectory(entryName, relative) {
  return excludedDirectories.has(entryName) || excludedRelativeDirectories.has(relative);
}

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    const relative = toPosix(path.relative(root, full));
    if (entry.isDirectory() && isExcludedDirectory(entry.name, relative)) continue;
    if (entry.isDirectory()) {
      result.push(...await walk(full));
    } else if (!excludedFileNames.has(entry.name) && !excludedFiles.has(relative) && !relative.endsWith('.zip')) {
      result.push({ full, relative });
    }
  }
  return result;
}

const files = (await walk(root)).sort((left, right) => left.relative.localeCompare(right.relative));
const records = [];
for (const file of files) {
  const body = await readFile(file.full);
  const info = await stat(file.full);
  records.push({
    path: file.relative,
    bytes: info.size,
    sha256: createHash('sha256').update(body).digest('hex')
  });
}

const manifest = {
  schemaVersion: '1.0.0',
  project: 'open-agent-fabric',
  generatedAt: new Date().toISOString(),
  fileCount: records.length,
  totalBytes: records.reduce((sum, item) => sum + item.bytes, 0),
  exclusions: [
    '.git/**',
    '.local/**',
    '.playwright-cli/**',
    '.scratch/**',
    '.claude/**',
    '.cursor/**',
    '.github/**',
    'node_modules/**',
    'coverage/**',
    'context-packs/**',
    'graphify-out/**',
    'output/**',
    'docs/research/**',
    'docs/superpowers/**',
    '.env',
    '.DS_Store',
    '*.zip',
    output
  ],
  files: records
};

await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${output}: ${manifest.fileCount} files, ${manifest.totalBytes} bytes.`);
