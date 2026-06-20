# OAF-019 File and RSS Ingestion Note

OAF-019 adds a native read-only ingestion utility in `packages/evidence` and an optional Content Intelligence workflow input path.

Implemented behavior:

- accepts caller-supplied bounded text, Markdown, JSON, RSS, and Atom bodies;
- creates immutable source snapshots for accepted sources;
- normalizes documents, JSON records, RSS items, and Atom entries into observations linked to their source snapshots;
- keeps observation inference empty during ingestion;
- collapses duplicate observations by content hash while retaining source snapshots;
- reports malformed JSON/RSS/Atom, oversized sources, and credential-bearing source locators as structured failures;
- records explicit `externalAccess` booleans showing network, cookies, paid APIs, browser automation, and external writes remain disabled.

Boundaries:

- no URL fetching, crawler, authenticated social connector, public API client, paid API client, cookie handling, browser automation, external adapter, external write, publishing, memory write, vector database, graph database, or embedding store was added;
- RSS and Atom support is a dependency-free bootstrap parser for bounded feed bodies, not a full XML crawler;
- source bodies remain untrusted evidence and must flow through later citation, context, and review gates before model use.

Verification:

- `node --test tests/research-ingestion.test.mjs`
- `npm run protocol:validate`
- `npm test`
- `npm run eval`
