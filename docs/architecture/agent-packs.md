# Portable Agent Packs

An Agent Pack is the reproducible, reviewable description of an agent or coordinated agent team. It is not a prompt dump and does not carry secrets.

## Required sections

- `metadata`: stable name, version, description, license, provenance;
- `runtime`: runner kind and local-only requirement;
- `models`: named roles and required capabilities;
- `context`: compiler policy and budgets;
- `memory`: provider preference and write policy;
- `capabilities`: requested capability IDs;
- `skills`: versioned skill references;
- `workflows`: versioned workflow references;
- `permissions`: declared data, network, filesystem, and consequence bounds;
- `evaluations`: datasets or suites required before activation.

## Activation

1. Parse and schema-validate.
2. Verify referenced skills, workflows, and tools.
3. Compute a deterministic fingerprint.
4. Resolve provider capabilities without changing the pack.
5. Evaluate requested permissions against workspace policy.
6. Record activation as an event.

A valid pack can still be denied if it requests authority the workspace does not grant.
