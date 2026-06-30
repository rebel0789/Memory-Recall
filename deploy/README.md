# Deployment Scaffolding

The default is `npm run dev`. Compose services are optional development profiles. Images use readable tags here for approachability; **pin reviewed digests before any release**. The bootstrap container has no production authentication and must not be exposed to an untrusted network.

```bash
docker compose --profile app up --build
docker compose --profile postgres up -d
docker compose --profile ollama up -d
docker compose --profile observability up -d
```

## OAF-029 profile verification

`npm run ops:smoke` verifies the development compose profile text for loopback
ports, disabled external writes, disabled network defaults, read-only app
filesystem, pgvector PostgreSQL, loopback Ollama, and loopback OpenTelemetry
collector endpoints.

These compose services remain development scaffolding. Production deployment
still requires digest pinning, production authentication, TLS/reverse proxy,
secret management, database dump/restore rehearsal, retention policy, monitoring,
and incident ownership.
