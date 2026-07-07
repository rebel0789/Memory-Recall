import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const required=['AGENTS.md','PROJECT_STATUS.json','PRODUCT.md','DESIGN.md','BRAND.md','planning/backlog.json','packages/protocol/schemas/event.schema.json','packages/context-compiler/src/index.mjs','packages/agentpack/src/index.mjs','providers/native/memory-sqlite/provider.json','providers/native/artifact-filesystem/provider.json','workflows/content-intelligence/workflow.json'];
for(const relative of required)await access(path.join(root,relative));
await mkdir(path.join(root,'.local'),{recursive:true,mode:0o700});
await mkdir(path.join(root,'.local','artifacts'),{recursive:true,mode:0o700});
const statePath=path.join(root,'.local/state.json');
try{await access(statePath)}catch{await writeFile(statePath,JSON.stringify({schemaVersion:'1.0.0',runs:[],events:[],memories:[],approvals:[],artifacts:[]},null,2)+'\n',{mode:0o600})}
const envPath=path.join(root,'.env');try{await access(envPath)}catch{await copyFile(path.join(root,'.env.example'),envPath)}
const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
console.log(`Open Agent Fabric ${pkg.version} bootstrap is ready.`);console.log('');console.log('Local state: .local/state.json');console.log('Native memory: .local/memory.sqlite (created on first use)');console.log('Artifacts: .local/artifacts');console.log('Model mode: deterministic (no key, no network)');console.log('External writes: disabled');console.log('');console.log('Next:');console.log('  npm run doctor');console.log('  npm run ci');console.log('  npm run protocol:validate');console.log('  npm run native:smoke');console.log('  npm run demo');console.log('  npm run status');console.log('  npm run oaf -- skill catalog --read-only --root . --format summary');console.log('  docs/usage/local-agent-handoff.md');console.log('  npm run task -- <OAF-ID> (only when status names a next task)');console.log('  npm run dev');console.log('  open http://127.0.0.1:4310');
