# Task-First Workbench Implementation Plan

> Execute with test-driven development. Preserve the existing visual system and verify every primary route in the in-app browser.

**Goal:** Make the workbench immediately understandable, make Map truthful and readable, and remove misleading or legacy UI.

**Architecture:** Keep the existing browser shell, orientation model/view, source-map view, and graph viewport. Add small pure view-model helpers where behavior needs unit coverage. No new frontend framework or design dependency.

## Task 1: Task-oriented navigation and first screen

**Files:** `apps/web/shell-model.js`, `apps/web/app.js`, `apps/web/orientation-view.js`, `tests/web-shell.test.mjs`, `tests/web-orientation.test.mjs`

1. Change tests to require `Start`, `Explore code`, `Review memory`, `Prepare handoff`, and `Settings` in desktop navigation, with the first four on mobile.
2. Add tests that Overview exposes direct actions for exploring code, reviewing memory, and preparing a handoff.
3. Run the focused tests and observe the expected failures.
4. Update navigation labels and concise route descriptions without changing stable paths.
5. Simplify Overview copy and actions around the three developer jobs.
6. Run focused tests to green.

## Task 2: Default Map graph and query semantics

**Files:** `apps/web/source-map-view.js`, `apps/web/app.js`, `apps/web/graph-viewport.js`, `tests/web-source-map.test.mjs`, `tests/web-shell.test.mjs`

1. Add failing tests that empty-query output includes a repository architecture canvas and group outline.
2. Add failing tests that the primary submit action is `Search code`, while `Refresh scan` is separate.
3. Implement a default architecture graph derived from repository groups and their bounded relationships.
4. Keep focused query/change/group behavior and stable URL state.
5. Run the focused tests to green.

## Task 3: Progressive labels and legible outline

**Files:** `apps/web/graph-viewport.js`, `apps/web/source-map-view.js`, `apps/web/styles.css`, `tests/web-source-map.test.mjs`

1. Add failing pure tests for a bounded visible-label policy: selected node, hovered node, immediate neighbors, then a small high-value budget.
2. Add failing markup/style tests for stacked outline copy, `min-width:0`, and controlled locator overflow.
3. Replace the `nodes.length <= 60` all-label rule with the tested visibility policy.
4. Render outline rows with dedicated label and locator elements and fix grid sizing.
5. Run focused tests to green.

## Task 4: Truthful Memory metrics

**Files:** `apps/web/app.js`, `tests/web-shell.test.mjs`

1. Add failing tests for missing or zero baseline returning `Not measured`.
2. Add model state that distinguishes measured reduction, measured overhead, no reduction, and unmeasured.
3. Update the Memory header and disclosure copy to explain unmeasured state.
4. Run focused tests to green.

## Task 5: Real Settings and concise Handoffs

**Files:** `apps/web/app.js`, `apps/web/styles.css`, `tests/web-shell.test.mjs`

1. Add failing tests requiring a Settings H1, local storage/scan/privacy sections, and no token swatch gallery.
2. Add failing tests requiring Handoffs to lead with one recommended flow and user-facing `recall` commands.
3. Replace Settings with actual local runtime information already available to the shell.
4. Reorder Handoffs so build, pin, verify, and receive are the primary path; move reference detail into disclosure.
5. Convert public command strings from `npm run oaf --` to `recall`, retaining internal test/dev commands only where explicitly labeled.
6. Run focused tests to green.

## Task 6: Browser verification

1. Run `node --test tests/web-orientation.test.mjs tests/web-source-map.test.mjs tests/web-memory-graph.test.mjs tests/web-shell.test.mjs`.
2. Open Overview, Map default, Map focused, Memory, Handoffs, and Settings in the user's in-app browser.
3. Click every primary action, verify URL/state synchronization, inspect console errors, and capture desktop plus narrow screenshots.
4. Compare the focused Map screenshot against the supplied overlap screenshot and fix remaining collisions.
5. Re-run focused tests after visual fixes.
