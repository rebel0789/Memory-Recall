# OAF-017 Native Versioned Memory Note

## Intent

OAF-017 upgrades `packages/memory-core` from proposal scoring into a deterministic native memory write gate. The gate owns lifecycle transitions and export-safe records while the existing SQLite provider remains the native storage/search implementation.

## Trust Boundaries

- Model, tool, external, and retrieved content may propose memory only.
- Active memory requires deterministic verification or a human-confirmed source.
- Secrets are rejected or quarantined and are not written as raw memory text.
- External adapters, external writes, hosted memory providers, graph databases, vector databases, embeddings, and browser automation remain disabled.

## Implementation Summary

Implemented pure lifecycle helpers in `packages/memory-core/src/index.mjs`, extended the memory record schema/example with decision, reason, evidence, conflict, and lifecycle fields, and added focused tests for preferences, facts, duplicates, secrets, conflicts, export filtering, supersession, rejection, retraction, and expiry.

The write gate remains local and deterministic. It does not persist raw secrets, activate unverified model output, enable external adapters, or introduce hosted memory providers.
