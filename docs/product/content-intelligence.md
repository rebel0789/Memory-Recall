# Flagship Product: Content Intelligence

## Principle

Research first. Patterns second. Writing third.

The product is not a “viral post generator.” It is a research operator that prepares evidence, detects patterns, proposes differentiated angles, and learns from outcomes without copying source language.

## Pipeline

1. **Collect:** bounded caller-supplied files and RSS/Atom bodies now; public APIs, transcripts, GitHub, and reviewed read adapters remain future adapter work.
2. **Snapshot:** preserve source ID, URL, body hash, collection method, publication and metric time.
3. **Normalize:** map into `ContentObservation` without mixing inference.
4. **Deduplicate:** detect reposts, cross-posts, quote derivatives, and transcript copies.
5. **Graph evidence:** preserve citation edges, stale observations, and conflicts without overwriting source facts.
6. **Estimate relative performance:** compare against creator, format, age, and topic baselines when data supports it.
7. **Extract patterns:** hook mechanism, claim, evidence, narrative, format, emotion, reader, takeaway, copying risk.
8. **Cluster and age:** emerging, accelerating, established, overused, declining.
9. **Match creator context:** credible topics, products, audience, voice examples, banned phrases, prior outcomes.
10. **Generate candidates:** angle, hook, reader, why now, evidence, difference, proof needed, uncertainty.
11. **Verify:** citations, unsupported claims, similarity, policy, and source freshness.
12. **Approve and draft:** user edits and approves; publication remains a separate consequential capability.
13. **Measure and learn:** record creator-selected outcomes, edit distance, user judgment, and qualitative response.

## Data contract

Observed values and model inference are separate objects. A recommendation cites selected observation IDs. Raw views are not treated as comparable performance without context.

The native evidence service builds deterministic citation graph records from snapshots, observations, and claims. Deduplication, staleness, and conflict findings are graph outputs, not edits to the observed source facts.

OAF-019 adds a read-only native ingestion path for text, Markdown, JSON, RSS, and Atom. It snapshots each bounded source body, normalizes usable entries into `ContentObservation` records with empty inference, collapses repeated observations by content hash, and reports malformed or oversized sources without fetching network content or using cookies, paid APIs, browser automation, external adapters, external writes, or publishing.

OAF-020 adds deterministic pattern analysis after normalization. Raw metrics and baselines stay under `metrics`; lifecycle, relative-performance state, proof-needed reasons, uncertainty, similarity, and copying risk stay under `inference`. When baselines are missing, raw views or saves are not promoted into truth claims. Similar source wording raises copying risk and requires rewriting the mechanism rather than copying phrases.

OAF-021 completes the local creator workflow without a publisher. Candidate approval records preserve the exact editable preview and bind the approval to candidate/evidence fingerprints, prompt and output-schema versions, provider/model metadata, and the persisted context manifest. Local drafts recheck evidence citations and edited-text similarity before recording objective-specific outcomes, edit distance, and `causalClaim: none`.

## Default dashboard

- Today
- Evidence
- Pattern Library
- Saturation
- Voice and Constraints
- Experiments

## Quality criteria

A useful candidate is specific, source-backed, differentiated, credible for the creator, explicit about uncertainty, and adaptable without phrase-level imitation. Engagement is one signal, not truth or value.
