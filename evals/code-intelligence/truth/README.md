# Code intelligence truth review

This directory holds the reviewed facts used to measure language support. An
engine result is never its own ground truth.

## Evidence classes

- Fixture truth covers every declaration and applicable relationship in the
  fixture. Fixture review coverage is normally `exhaustive`.
- Repository truth covers one bounded scope from a pinned corpus repository.
  Its source reference records the corpus ID, exact 40-character commit, and
  workspace-relative scope.
- Each Tier 1 language needs fixture truth and reviewed truth from all three
  pinned repositories before a capability can move beyond `unmeasured`.
- A single report is case evidence. Language and capability claims are decided
  from the complete evidence set, never from the best case or a macro average.

## Selecting repository facts

For each pinned repository, select stable facts that exercise the language and
framework behavior under review:

- declarations across top-level and nested scopes;
- imports, exports, re-exports, modules, packages, or includes as applicable;
- inheritance, implementation, traits, protocols, mixins, and type relations;
- resolved and intentionally unresolved calls, including receiver-sensitive
  cases;
- routes, handlers, framework components, configuration resources, and process
  steps when the repository contains them;
- explicit negative facts for reviewed false-positive precision samples.

The sample must include ordinary code and hard cases. Do not select only facts
already found by the current engine. Keep the bounded scope stable unless a
reviewed corpus update explains why it changed.

## Review procedure

1. Pin the repository to the corpus commit and record the bounded relative
   scope in `source.ref`.
2. A generator may propose candidate locators, but it may not label truth or
   use the engine under evaluation as the authority.
3. Review every checked-in item against source at its recorded locator. Confirm
   its kind, name, relationship endpoints, expected presence or absence, and
   resolution class.
4. Set declaration, relationship, and call coverage separately to
   `exhaustive`, `sampled`, or `not-applicable`.
5. Record the reviewer identity and UTC review time. Recompute the canonical
   truth fingerprint after the final edit.
6. Run the schema validator, semantic truth audit, and the graph evaluator at
   least twice against identical input.

Generated source text, copied engine output, unreviewed inferred relationships,
absolute paths, environment values, credentials, and raw parser errors are not
allowed in truth records.

## Metric and claim rules

- Declaration recall is matched expected declarations divided by reviewed
  expected declarations.
- Relationship recall excludes calls and uses reviewed expected relationships.
- Reviewed call precision is matched expected calls divided by matched expected
  calls plus reviewed present-but-forbidden calls.
- A denominator of zero produces `null`, not 0 or 1.
- Any duplicate canonical symbol, repository parse failure, nondeterministic
  graph fingerprint, or truth mismatch fails the case.
- Published floors are declaration and symbol recall at least 0.95, resolved
  call precision at least 0.90, duplicate canonical symbols equal to zero,
  repository parse failures equal to zero, and deterministic output.
- Missing or partial evidence stays explicit. Grammar availability alone is
  not language support.
- Per-language status uses the weakest required applicable capability across
  all required fixtures and repository cases.
- Parity and leadership are release-level decisions. No individual truth or
  language report may claim them.

## Change review

Truth changes require the same scrutiny as parser changes. A change should state
which pinned source locator changed, why the previous fact was wrong or stale,
and whether the change affects historical comparison. Never weaken truth to make
a failing engine pass.
