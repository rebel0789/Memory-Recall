# Product Writing and Content Style

## Tone

Direct, factual, calm, and specific. State what happened, why, and what action is safe next.

## Preferred patterns

- “Publishing is disabled in local mode.”
- “3 records were excluded because they were superseded.”
- “Approval expired; review the current payload before approving again.”
- “This recommendation is supported by 2 selected observations.”

## Avoid

- “The AI is thinking.”
- “Magic,” “autopilot,” “fully autonomous,” or “superintelligent.”
- Generic “Something went wrong” without a correlation ID or safe next step.
- Confidence language that hides evidence quality.

## Errors

Use: action + cause + preserved state + next safe step. Do not expose stack traces, credentials, source bodies, or internal paths.

## Dates and numbers

Use absolute dates when ambiguity matters, localize display, preserve UTC in APIs, and label estimates. Distinguish collected time, published time, valid time, and metric time.
