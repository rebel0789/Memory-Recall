import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations, getMigrationStatus, redactPostgresUrl } from '../packages/storage/src/postgres-migrations.mjs';
import { PsqlSessionPool } from '../packages/storage/src/psql-session-client.mjs';

function usage() {
  return [
    'Usage:',
    '  OAF_POSTGRES_URL=postgres://... npm run db:status',
    '  OAF_POSTGRES_URL=postgres://... npm run db:migrate',
    '',
    'Options:',
    '  --migrations <directory>   Explicit migration directory',
    '  --url <postgres-url>       Explicit PostgreSQL URL; OAF_POSTGRES_URL is also accepted'
  ].join('\n');
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  const parsed = { command, migrations: null, url: process.env.OAF_POSTGRES_URL ?? null };
  while (args.length) {
    const arg = args.shift();
    if (arg === '--migrations') parsed.migrations = args.shift();
    else if (arg === '--url') parsed.url = args.shift();
    else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function omitSql(value) {
  if (Array.isArray(value)) return value.map(omitSql);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'sql') continue;
    output[key] = omitSql(item);
  }
  return output;
}

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

try {
  const { command, migrations, url } = parseArgs(process.argv.slice(2));
  if (!['status', 'migrate'].includes(command)) throw new Error(`unknown command: ${command ?? '<missing>'}`);
  if (!url) throw new Error('OAF_POSTGRES_URL or --url is required; no production database is inferred');
  if (!migrations) throw new Error('--migrations is required');

  const directory = path.isAbsolute(migrations) ? migrations : path.join(root, migrations);
  const pool = new PsqlSessionPool({ connectionUrl: url });
  if (command === 'status') {
    const client = await pool.connect();
    try {
      const result = await getMigrationStatus({ client, directory });
      console.log(JSON.stringify(omitSql(result), null, 2));
      if (result.ok === false) process.exitCode = 1;
    } finally {
      client.release();
    }
  } else {
    const result = await applyMigrations({ pool, directory });
    console.log(JSON.stringify(omitSql(result), null, 2));
    if (result.ok === false) process.exitCode = 1;
  }
} catch (error) {
  console.error(redactPostgresUrl(error.message));
  console.error(usage());
  process.exitCode = 2;
}
