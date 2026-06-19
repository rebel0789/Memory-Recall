#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { compileContext } from '../../packages/context-compiler/src/index.mjs';
const [command='help',...args]=process.argv.slice(2);
const commands=new Map([['doctor',['scripts/doctor.mjs']],['demo',['scripts/demo.mjs',...args]],['serve',['services/control-api/src/server.mjs']],['check',['scripts/check.mjs']],['eval',['scripts/run-evals.mjs']],['manifest',['scripts/generate-manifest.mjs']],['status',['scripts/status.mjs']],['task',['scripts/task.mjs',...args]]]);
if(commands.has(command))process.exitCode=await runNode(commands.get(command));else if(command==='context')await contextCommand(args);else if(['help','--help','-h'].includes(command))help();else if(['version','--version','-v'].includes(command)){const pkg=JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8'));console.log(pkg.version)}else{console.error(`Unknown command: ${command}\n`);help();process.exitCode=2}
async function contextCommand(values){const requestPath=option(values,'--request'),recordsPath=option(values,'--records');if(!requestPath||!recordsPath){console.error('context requires --request <json> and --records <json>');process.exitCode=2;return}const request=JSON.parse(await readFile(requestPath,'utf8')),records=JSON.parse(await readFile(recordsPath,'utf8'));console.log(JSON.stringify(compileContext(request,records),null,2))}
function option(values,name){const index=values.indexOf(name);return index>=0?values[index+1]:null}
function runNode(nodeArgs){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,nodeArgs,{stdio:'inherit',env:process.env});child.on('error',reject);child.on('exit',code=>resolve(code??1))})}
function help(){console.log(`Open Agent Fabric CLI\n\nUsage:\n  oaf doctor\n  oaf status\n  oaf task OAF-004\n  oaf demo [objective]\n  oaf serve\n  oaf check\n  oaf eval\n  oaf manifest\n  oaf context --request request.json --records records.json\n  oaf version\n\nThe default bootstrap is local-only and enables no external writes.`)}
