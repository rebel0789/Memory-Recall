import test from 'node:test';import assert from 'node:assert/strict';import { readFile } from 'node:fs/promises';
const backlog=JSON.parse(await readFile('planning/backlog.json','utf8')),status=JSON.parse(await readFile('PROJECT_STATUS.json','utf8'));
test('backlog has unique ordered task identifiers',()=>{const ids=backlog.tasks.map(t=>t.id);assert.equal(ids.length,30);assert.equal(new Set(ids).size,30);assert.deepEqual(ids,Array.from({length:30},(_,i)=>`OAF-${String(i+1).padStart(3,'0')}`))});
test('dependencies exist and precede dependents',()=>{const index=new Map(backlog.tasks.map((t,i)=>[t.id,i]));for(const task of backlog.tasks)for(const dep of task.dependsOn){assert(index.has(dep));assert(index.get(dep)<index.get(task.id))}});
test('project status next task exists',()=>{assert(backlog.tasks.some(task=>task.id===status.nextTask));assert.equal(status.defaults.externalWrites,false)});
