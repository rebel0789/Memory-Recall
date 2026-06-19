# Data Classification

## Classes

### Public

Approved public source data and release documentation. Still subject to integrity, provenance, and license rules.

### Workspace private

Default for user prompts, runs, drafts, internal files, preferences, and evidence not explicitly public. Accessible only inside the workspace.

### Sensitive

Personal data, confidential business data, unpublished strategy, private source bodies, or data with contractual restrictions. Requires explicit purpose, reduced retention, and restricted tools.

### Secret

Credentials, tokens, cookies, private keys, recovery codes, or encryption material. Never enters model context, events, normal logs, fixtures, or artifacts. Only a secret reference may cross service boundaries.

### Prohibited

Data the system is not authorized to store or process. Reject or delete according to documented incident procedure.

## Rules

- Inherit the most restrictive class when combining records.
- A summary is not automatically less sensitive than its source.
- Export preserves classification metadata.
- Adapters declare accepted classes.
- Context requests declare allowed classes.
- Declassification requires explicit human authority and an event.
