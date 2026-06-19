import test from 'node:test';
import assert from 'node:assert/strict';
import { assessContentObservation, observationRecordKind } from '../packages/content-intelligence/src/index.mjs';

test('marks unrelated material ineligible despite high engagement',()=>{
  const result=assessContentObservation({text:'A recipe with no connection to software agents.',metrics:{views:50000,saves:1000},inferred:{pattern:'unrelated'}});
  assert.equal(result.candidateEligible,false);
  assert.equal(result.polarity,'irrelevant');
  assert.equal(result.retrievalPenalty,1);
});

test('preserves anti-patterns as negative context rather than positive evidence',()=>{
  const result=assessContentObservation({text:'Unlimited memory solves everything.',metrics:{views:3000},inferred:{pattern:'absolute claim'}});
  assert.equal(result.candidateEligible,true);
  assert.equal(observationRecordKind(result),'negative-context');
  assert(result.reasonCodes.includes('anti_pattern'));
});

test('rewards specific outcome-backed workflow evidence',()=>{
  const result=assessContentObservation({text:'A six-step checklist showing retries got more saves and cut our debugging time.',metrics:{views:9000,replies:50,saves:300},inferred:{pattern:'reusable artifact'}});
  assert.equal(result.candidateEligible,true);
  assert(result.importance>.65);
  assert(result.outcomeEvidence>=.6);
});
