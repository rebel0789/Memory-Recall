import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeContentPatterns,
  assessContentObservation,
  observationRecordKind
} from '../packages/content-intelligence/src/index.mjs';

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

test('pattern analysis separates raw metrics from inference and relative performance',()=>{
  const result=analyzeContentPatterns([
    {
      id:'obs_relative',
      text:'A six-step recovery checklist showing retries got more saves and cut debugging time.',
      collectedAt:'2026-06-20T00:00:00.000Z',
      publishedAt:'2026-06-19T00:00:00.000Z',
      metrics:{views:12000,replies:80,saves:450},
      baselines:{views:4000,replies:20,saves:100},
      inferred:{pattern:'reusable artifact'}
    }
  ],{generatedAt:'2026-06-20T00:00:00.000Z'});

  const analysis=result.observations[0];
  assert.equal(analysis.metrics.raw.views,12000);
  assert.equal(analysis.metrics.relativePerformance.state,'above_baseline');
  assert.equal(analysis.inference.pattern.format,'checklist');
  assert.equal(analysis.inference.lifecycle,'accelerating');
  assert.equal(analysis.inference.proofNeeded.length,0);
  assert.equal(analysis.inference.uncertainty.level,'low');
  assert.equal(analysis.inference.views,undefined);
  assert.equal(result.safeguards.metricsSeparatedFromInference,true);
});

test('pattern analysis reports proof needs and avoids treating baseline-free metrics as truth',()=>{
  const result=analyzeContentPatterns([
    {
      id:'obs_uncertain',
      text:'A broad prediction about agents changing everything soon.',
      collectedAt:'2026-06-20T00:00:00.000Z',
      metrics:{views:90000},
      inferred:{pattern:'generic prediction'}
    }
  ],{generatedAt:'2026-06-20T00:00:00.000Z'});

  const analysis=result.observations[0];
  assert.equal(analysis.metrics.relativePerformance.state,'insufficient_baseline');
  assert(analysis.inference.proofNeeded.includes('creator_or_format_baseline'));
  assert.equal(analysis.inference.uncertainty.level,'high');
  assert(analysis.inference.reasonCodes.includes('raw_metrics_not_comparable'));
});

test('pattern analysis clusters similar sources and flags copying risk without copying source text',()=>{
  const result=analyzeContentPatterns([
    {id:'obs_a',text:'Show the failed tool calls and retries so readers trust the local agent workflow.',collectedAt:'2026-06-20T00:00:00.000Z',metrics:{views:1000,saves:10},baselines:{views:1000,saves:10},inferred:{pattern:'reusable artifact'}},
    {id:'obs_b',text:'Show the failed tool calls and retries so readers trust the local agent workflow.',collectedAt:'2026-06-20T00:01:00.000Z',metrics:{views:1100,saves:12},baselines:{views:1000,saves:10},inferred:{pattern:'reusable artifact'}},
    {id:'obs_c',text:'A permissions checklist helped teams reproduce recovery tests.',collectedAt:'2026-06-20T00:02:00.000Z',metrics:{views:900,saves:9},baselines:{views:1000,saves:10},inferred:{pattern:'reusable artifact'}}
  ],{generatedAt:'2026-06-20T00:02:00.000Z'});

  const highRisk=result.observations.find(item=>item.observationId==='obs_b');
  assert.equal(result.clusters.length>=1,true);
  assert.equal(highRisk.inference.copyingRisk.level,'high');
  assert.equal(highRisk.inference.similarity.maxScore,1);
  assert(!JSON.stringify(result.clusters).includes('failed tool calls and retries'));
});
