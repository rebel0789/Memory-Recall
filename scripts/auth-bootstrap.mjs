#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { pathToFileURL } from 'node:url';
import { LocalIdentityStore } from '../providers/native/identity-local/src/index.mjs';

function parseArgs(argv) {
  const out = { dataDir: path.join('.local', 'identity'), workspaceId: 'ws_local', workspaceName: 'Local Workspace' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--password') throw new Error('--password is not supported; use --password-stdin or the hidden prompt');
    if (arg === '--password-stdin') out.passwordStdin = true;
    else if (arg === '--username') out.username = argv[++index];
    else if (arg === '--display-name') out.displayName = argv[++index];
    else if (arg === '--data-dir') out.dataDir = argv[++index];
    else if (arg === '--workspace-id') out.workspaceId = argv[++index];
    else if (arg === '--workspace-name') out.workspaceName = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.username) throw new Error('--username is required');
  if (!out.displayName) throw new Error('--display-name is required');
  return out;
}

async function readPassword({ passwordStdin }, stdin = process.stdin, terminalOutput = output) {
  if (passwordStdin) {
    let raw = '';
    for await (const chunk of stdin) raw += chunk;
    return raw.replace(/\r?\n$/, '');
  }
  const terminal = readline.createInterface({ input: stdin, output: terminalOutput });
  try {
    return await terminal.question('Password: ');
  } finally {
    terminal.close();
  }
}

export async function runAuthBootstrapCli({ argv = process.argv.slice(2), stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const args = parseArgs(argv);
    const password = await readPassword(args, stdin, stdout);
    const store = await new LocalIdentityStore({ directory: args.dataDir }).init();
    const result = await store.bootstrapOwner({
      username: args.username,
      displayName: args.displayName,
      password,
      workspaceId: args.workspaceId,
      workspaceName: args.workspaceName
    });
    stdout.write(`${JSON.stringify({
      schemaVersion: '1.0.0',
      bootstrapped: true,
      userId: result.user.id,
      workspaceId: result.workspace.id,
      role: result.membership.role
    }, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error.code ?? 'auth_bootstrap_failed'}: ${error.message}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(await runAuthBootstrapCli());
}
