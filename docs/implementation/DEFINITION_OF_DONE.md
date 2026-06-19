# Definition of Done

## Behavior

- Acceptance criteria are observable and met.
- Success, empty, boundary, denial, failure, timeout, retry, and cancellation paths are considered.
- Public behavior is typed and documented.

## Architecture

- Domain contracts remain provider-neutral.
- Events, context manifests, and idempotency are recorded where required.
- No direct UI-to-storage or domain-to-adapter dependency is introduced.

## Security and privacy

- Actor, workspace, permission, data class, and side-effect class are explicit.
- External input is validated, bounded, and untrusted.
- Secrets do not enter prompts, logs, events, fixtures, or errors.
- New dependency or adapter has pin, license, owner, and threat review.

## Data

- Schema change has migration, compatibility, backup, and rollback or compensation.
- Provenance and temporal fields are preserved.
- Deletion and retention are explicit.

## Quality

- Tests fail before and pass after the fix where practical.
- Relevant evaluation cases exist.
- `npm run ci` passes.
- Documentation, status, and examples match implementation.

## User experience

- Empty, loading, waiting, success, warning, denied, and error states exist.
- Keyboard, focus, mobile, dark/light, reduced-motion, and non-color status checks pass.
- Claims and uncertainty appear near evidence.

## Handoff

The pull request states changed files, verification, security, migration, limitations, rollback, and safest next task.
