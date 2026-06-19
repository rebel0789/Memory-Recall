# Backup and Restore

## Bootstrap

Stop the server and copy `.local/state.json`. It contains synthetic/reference state only. Validate JSON before restore.

## Target profile

Back up PostgreSQL and content-addressed artifact storage as one consistency set. Record schema version, migration checksums, application version, encryption/key references, and object inventory.

## Restore rehearsal

- restore to an isolated environment;
- verify migration checksums before startup;
- validate workspace counts and event sequences;
- verify artifact hashes;
- run read-only health and representative queries;
- never allow external writes during rehearsal;
- record recovery time and data-loss window.

A backup that has not passed a restore rehearsal is not a completed backup system.
