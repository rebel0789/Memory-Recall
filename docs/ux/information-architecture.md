# Information Architecture

## Primary navigation

Home · Runs · Workflows · Context · Evidence · Memory · Content Lab · Agents & Tools · Approvals · Settings

## Resource URLs

```text
/workspaces/:workspaceId
/runs/:runId?step=:stepId
/workflows/:workflowId/versions/:version
/context/:manifestId
/evidence/:observationId
/memory/:memoryId
/approvals/:approvalId
/agents/:agentId
/tools/:toolId
/evaluations/:evaluationId
```

Filter, sort, selected tab, and selected graph node belong in the URL when practical. Sensitive bodies never belong in query strings.

## Disclosure levels

1. **Outcome:** status, result, uncertainty, next action.
2. **Explanation:** evidence, selected context, policy, tools, validation.
3. **Trace:** structured events, attempts, timing, usage, and sanitized payloads.
