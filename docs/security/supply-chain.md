# Supply-Chain Security

## Dependencies

The bootstrap has no runtime npm dependency. Any dependency requires an ADR explaining why the standard library or an existing component is insufficient, its license, ownership, maintenance, transitive risk, and removal path.

## Adapters and skills

- pin repository and commit;
- verify archive checksum;
- record license at that commit;
- inspect install and update scripts;
- declare network, filesystem, process, and secret access;
- do not execute instructions fetched from a moving branch;
- review changes through a pull request;
- produce SBOM and provenance for releases;
- sign or verify manifests when the registry is implemented.

## Containers and models

Pin image digests for releases. Record model file source, checksum, license, architecture, quantization, and capability evaluation. Do not auto-download model weights in the default bootstrap.
