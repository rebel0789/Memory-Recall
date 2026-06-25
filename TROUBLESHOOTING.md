# Troubleshooting

## Node is too old

Run `node --version`. The bootstrap requires Node.js 22 or newer.

## Port 4310 is busy

```bash
OAF_PORT=4311 npm run dev
```

## State is invalid

The bootstrap file is `.local/state.json`. Browser users should sign in to the
local owner account and use **Reset demo**. The `/api/reset` route is protected
by the browser session and CSRF checks, so unauthenticated `curl` requests are
expected to fail.

For a CLI-only reset, stop `npm run dev` if it is running, back up local state,
then regenerate deterministic demo state:

```bash
mv .local/state.json ".local/state.json.bak.$(date +%s)"
npm run bootstrap
npm run demo
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
