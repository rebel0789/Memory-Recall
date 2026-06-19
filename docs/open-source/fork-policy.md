# Fork Policy

Open Agent Fabric prefers upstream contribution, then adapters, then a small reviewed patch layer. A maintained fork is the last option.

## Required RFC evidence

- exact upstream project, tag, and commit;
- missing capability and failed upstream path;
- license and trademark review;
- security ownership and patch cadence;
- local diff size and automated reconciliation test;
- maintainer and succession plan;
- exit or upstream-merge strategy.

## Repository layout for an approved fork

```text
vendor/<project>/UPSTREAM.md
patches/<project>/*.patch
scripts/sync-<project>.*
```

Do not make undocumented edits inside vendored source. CI must prove the patch series applies to the pinned upstream revision.
