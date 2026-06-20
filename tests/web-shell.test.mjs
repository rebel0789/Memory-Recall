import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ROUTES,
  SHELL_STATES,
  classifyDashboardState,
  legacyViewPath,
  navItems,
  resolveRoute,
  shellStatusLabel
} from '../apps/web/app.js';

test('web shell exposes stable path routes with legacy query compatibility',()=>{
  assert.deepEqual(navItems.map(item=>item.path),['/','/runs','/workflows','/context','/memory','/evidence','/approvals','/content','/agents-tools','/settings']);
  assert.equal(resolveRoute('http://127.0.0.1:4310/runs').id,'runs');
  assert.equal(resolveRoute('http://127.0.0.1:4310/context?manifest=ctx_1').id,'context');
  assert.equal(resolveRoute('http://127.0.0.1:4310/?view=evidence').id,'evidence');
  assert.equal(resolveRoute('http://127.0.0.1:4310/not-a-route').id,'home');
  assert.equal(legacyViewPath('design'),'/settings');
  assert.equal(ROUTES.some(route=>route.id==='content'),true);
});

test('web shell classifies loading, empty, partial, stale, success, denied, and error states',()=>{
  assert.deepEqual([...SHELL_STATES].sort(),['denied','empty','error','loading','partial','stale','success']);
  assert.equal(classifyDashboardState(null).kind,'loading');
  assert.equal(classifyDashboardState({error:{status:401}}).kind,'denied');
  assert.equal(classifyDashboardState({error:{message:'offline'}}).kind,'error');
  assert.equal(classifyDashboardState({metrics:{runs:0},runs:[],approvals:[],latestManifest:null}).kind,'empty');
  assert.equal(classifyDashboardState({metrics:{runs:1},runs:[{id:'run_1'}],approvals:[],latestManifest:null}).kind,'partial');
  assert.equal(classifyDashboardState({metrics:{runs:1},runs:[{id:'run_1'}],approvals:[],latestManifest:{id:'ctx_1'},stale:true}).kind,'stale');
  assert.equal(classifyDashboardState({metrics:{runs:1},runs:[{id:'run_1'}],approvals:[],latestManifest:{id:'ctx_1'}}).kind,'success');
});

test('status labels include text and do not rely on color alone',()=>{
  assert.equal(shellStatusLabel({network:'deny',externalWrites:false,modelMode:'deterministic'}),'Local-only · Network denied · External writes disabled · Deterministic model');
  assert.equal(shellStatusLabel({network:'allow',externalWrites:true,modelMode:'ollama'}),'Network allowed · External writes enabled · ollama model');
});

test('web shell markup keeps accessibility anchors and mobile navigation landmarks',async()=>{
  const html=await readFile('apps/web/index.html','utf8');
  const css=await readFile('apps/web/styles.css','utf8');
  assert.match(html,/href="#main"/);
  assert.match(html,/aria-label="Primary navigation"/);
  assert.match(html,/aria-label="Mobile navigation"/);
  assert.match(html,/aria-live="polite"/);
  assert.match(css,/prefers-reduced-motion/);
  assert.match(css,/min-height:44px/);
  assert.match(css,/focus-visible/);
  assert.match(css,/bottom-nav/);
});
