# Release Engineering

Releases are source-first, reproducible, signed, and accompanied by checksums, SBOM, provenance, changelog, migration notes, compatibility matrix, and rollback instructions.

The release process must start from a clean tagged commit. Generated artifacts are rebuilt in CI, compared where deterministic, signed by a protected identity, and attached with hashes. Container tags alone are insufficient; publish digests.

Adapters have independent support status and compatibility. A core release must not silently enable or update an adapter.
