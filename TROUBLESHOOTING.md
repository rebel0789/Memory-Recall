# Troubleshooting

## Node is too old

Run `node --version`. The bootstrap requires Node.js 22 or newer.

## Port 4310 is busy

```bash
OAF_PORT=4311 npm run dev
```

## State is invalid

The bootstrap file is `.local/state.json`. Back it up, then reset synthetic data:

```bash
curl -X POST http://127.0.0.1:4310/api/reset
```

## A task is unclear

```bash
npm run task -- OAF-004
```

Read its stop condition and required files. Do not expand scope to compensate for ambiguity; file an RFC or issue.

## An adapter cannot be enabled

That is expected. All researched adapters ship disabled and unpinned. Follow `skills/adapter-addition/SKILL.md` and do not run install scripts before security and license review.

## CI fails after generated local files

`npm run bootstrap` creates `.env` and `.local/`; both are ignored. `npm run check` deliberately ignores them. Do not add them to the repository.
