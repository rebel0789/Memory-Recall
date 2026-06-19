# Deployment Scaffolding

The default is `npm run dev`. Compose services are optional development profiles. Images use readable tags here for approachability; **pin reviewed digests before any release**. The bootstrap container has no production authentication and must not be exposed to an untrusted network.

```bash
docker compose --profile app up --build
docker compose --profile postgres up -d
docker compose --profile ollama up -d
docker compose --profile observability up -d
```
