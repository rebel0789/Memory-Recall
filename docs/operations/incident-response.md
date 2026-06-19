# Incident Response

## Severity examples

Critical: secret exposure, cross-workspace data leak, unauthorized external write, remote code execution, or release compromise.

High: memory poisoning affecting decisions, repeated consequential action, broken authorization, or destructive data loss.

## First actions

1. Stop affected adapters and external-write capabilities.
2. Preserve logs, events, manifests, artifact hashes, versions, and correlation IDs without copying secrets.
3. Revoke grants and rotate exposed credentials.
4. Determine workspaces and versions affected.
5. Restore safe service or keep disabled.
6. Create sanitized regression and recovery tests.
7. Communicate scope, dates, impact, remediation, and follow-up.

Do not ask a model to make incident authorization decisions.
