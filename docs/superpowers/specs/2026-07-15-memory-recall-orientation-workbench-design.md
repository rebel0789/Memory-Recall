# Memory Recall Orientation Workbench and Large-Repository Graph Design

Date: 2026-07-15

Status: Approved direction, pending written-spec review

## Decision

Memory Recall opens as an orientation-first repository workbench.

The first screen must tell a developer how the repository is organized, where to start, what changed, and whether the available context is trustworthy. It must not open with a raw node graph, a wall of status cards, or a long operational report.

This specification supersedes the `Overview screen`, `Map screen`, and graph-presentation sections of `2026-07-11-memory-recall-product-ui-redesign.md`. It retains that specification's five-destination shell, setup flow, visual system, Memory review queue, Handoffs flow, local-only boundaries, and accessibility requirements.

The work has two required slices:

1. Make the source graph return truthful, bounded results on large repositories.
2. Replace the rejected Overview, Map, and memory-graph presentation with the orientation-first experience defined here.

Neither slice is complete without the other. A polished interface over an invalid graph is misleading. A valid graph hidden behind the current interface does not deliver the approved first impression.

## Evidence behind the decision

A current local audit used a 1,627-file monorepo with 572 directly supported JavaScript and TypeScript files. The source scan reached its 1,000-file cap, created 17,018 nodes and 89,012 edges, then failed strict validation because the public graph schema permits 50,000 edges. A legitimate repository-relative path containing `/users/` also failed a display-label safety rule intended to reject absolute user paths.

The failed preview returned zero files, zero symbols, and zero relations. The web interface announced that the preview was ready instead of showing the validation failure. The submitted query was replaced by the default query. The initial Recall Map request took 13.6 seconds and a second Map request took 11.4 seconds because the graph was rebuilt.

The same audit found that discovery spent work on nested worktrees, agent tooling, virtual environments, and generated output. It reported more than 78,000 unsupported files before reaching the supported-file cap.

Competitor products informed the interaction direction but are not acceptance evidence:

- [codebase-mcp](https://pypi.org/project/codebase-mcp/) starts with one bounded orientation response containing project status, important files, decisions, recent notes, and index freshness.
- [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) exposes a compact architecture overview before its optional graph UI.
- [GitNexus](https://github.com/nxpatterns/gitnexus) precomputes clusters, flows, and impact instead of asking the client to interpret a raw graph.
- [Graphify](https://github.com/Graphify-Labs/graphify) pairs its graph with a report, path queries, search, and evidence labels.

Memory Recall keeps its own product boundary: reviewed temporal memory, source evidence, explicit lifecycle state, deterministic authority, and inspectable handoffs.

## First-ten-seconds contract

After a valid cached scan, a developer must be able to identify these facts without scrolling:

1. Repository name, branch, scan freshness, and coverage state.
2. The repository's main modules or services.
3. Three recommended starting points with plain reasons.
4. Whether local changes affect known modules or symbols.
5. Whether governed memory and the current handoff are current, pending, stale, or unavailable.

The screen may contain counts only when they support one of these decisions. It does not show vanity metrics.

The copy above the work area is one sentence at most:

> Repository structure, current impact, and trusted context.

The product shell contains no slogan.

## Information architecture

The five existing destinations remain:

- `Overview`: orientation-first repository workbench.
- `Map`: focused structure, trace, search, and impact exploration.
- `Memory`: proposal review, current facts, stale facts, history, and the governed memory graph.
- `Handoffs`: prepare, verify, save, and consume context packages.
- `Settings`: local storage, connections, clients, models, security, and advanced operations.

`Overview` is not a second Map page. It presents a bounded architecture summary and the next useful action. `Map` owns detailed relationships and evidence. `Memory` owns fact lifecycle and temporal relationships.

## Overview layout

### Repository truth bar

The existing compact repository bar remains at the top. It shows:

- repository and branch;
- scan state and age;
- coverage as `complete`, `partial`, `stale`, `failed`, or `not scanned`;
- local-only and external-write state;
- the global search field.

Coverage is a text state, not a colored dot without a label.

### Orientation workspace

Desktop uses a 70/30 split beneath the truth bar.

The primary region contains the architecture map. The secondary region contains three compact sections: `Start here`, `Current impact`, and `Trusted context`. These sections use dividers and aligned rows, not three equal cards.

The layout uses the current graphite and cobalt token system. It reduces vertical padding, avoids unused full-width sections, and keeps all primary information within the first desktop viewport at 1440 px.

### Architecture map

The first-screen map shows up to 12 deterministic repository groups. It shows at least 6 when the repository exposes 6 useful groups; smaller repositories show every useful group instead of inventing filler. Groups come from package boundaries, manifests, and stable repository-relative directory prefixes. No model names the groups.

Each group shows:

- name and repository-relative prefix;
- supported file and symbol counts;
- changed-file count;
- up to two ranked entry points;
- partial-coverage state when applicable.

The map does not render every file or symbol. It uses a layered module-dependency layout, not a force-directed node cloud. Strong dependency direction runs left to right. Cyclic groups share a layer. Within a layer, groups sort by repository-relative prefix, so the same snapshot produces the same positions.

Group nodes are keyboard-focusable semantic controls. A generated relationship layer may connect them visually, but the grouped outline is the canonical accessible representation. Selecting a group from either representation updates the secondary region and provides a direct link to its detailed Map view.

Relationships on the Overview are limited to the 20 strongest inter-group imports or calls. Ties resolve by source and target repository-relative prefix. Omitted relationship counts remain visible. Dense relationship detail belongs in Map.

The semantic fallback is a grouped outline containing the same groups, counts, entry points, and selected state. The outline is always present in the accessibility tree.

### Start here

`Start here` contains exactly three ranked entry points when three are available. Every item includes a reason such as:

- package entry point;
- application route;
- executable command;
- changed central module;
- high-confidence inbound dependency hub.

Generic test helpers, generated files, vendored code, and low-signal utility symbols cannot outrank source entry points.

### Current impact

With a clean working tree, the section says `No local changes detected` and does not reserve a large empty area.

With changes, it shows:

- changed files represented by the graph;
- changed files omitted by language or scan bounds;
- affected groups and top affected symbols;
- the current impact depth;
- a link to the detailed impact view.

An unrepresented changed file is never silently treated as safe.

### Trusted context

This section combines only decision-relevant state:

- active, pending, stale, and conflicting memory counts;
- current handoff state and age;
- source verification state;
- measured context-delivery reduction when a current measurement exists.

It does not claim provider billing-token savings. It links to Memory or Handoffs for detail.

### Command bar

One command bar accepts a file, symbol, concept, or path. It offers four deterministic intents:

- explain a module;
- trace a symbol;
- inspect changed-file impact;
- prepare a handoff.

The bar routes to existing read-only operations. It is not a chat interface and does not require a model.

## Map workspace

Map is the detailed repository explorer. Desktop uses three regions:

1. Compact query and scope controls.
2. The relationship view or equivalent outline.
3. A selected-item inspector with source evidence and coverage.

The current form is simplified. `Query` is always visible. `Trace symbol`, `Changed locator`, depth, and limit move behind an `Advanced scope` disclosure unless the current deep link requires them.

Submitting a query preserves the query in the URL and form through success, partial results, recoverable failure, reload, back, and forward navigation.

The default Map result shows grouped modules and ranked entry points. File and symbol nodes appear progressively after the developer selects a group, searches, traces, or opens impact detail.

The detailed graph supports pan, zoom, fit-to-selection, reset, and focus. It never attempts to render the full repository graph at once. The visible payload is bounded to a focused neighborhood, and omitted counts are explicit.

Every canvas or visual graph state has an equivalent keyboard-reachable outline. Selecting an outline row and selecting its visual node produce the same inspector state.

## Governed memory graph

The memory graph remains a secondary view within Memory.

When there are no governed nodes, the interface renders a compact empty state with the checked workspace, provider state, and next available action. It does not render metric cards or an empty 640 px canvas.

When nodes exist, the graph:

- fits visible nodes into the available viewport;
- groups or filters before drawing dense histories;
- distinguishes current and superseded relationships without relying only on color;
- keeps search and history controls compact;
- places the selected fact and provenance in a drawer or inspector;
- provides a complete outline for keyboard and assistive-technology use.

The graph is read-only. Proposal approval remains in the Memory review flow.

## Large-repository graph foundation

### Discovery

Discovery applies exclusions before supported-file limits. Default exclusions include:

- `.git` and nested Git worktrees;
- `.worktrees`;
- `node_modules`;
- `.venv`, `venv`, and Python site packages;
- build, coverage, test-result, cache, and generated-output directories;
- agent-skill and assistant-configuration directories such as `.agents` and `.claude`.

The scanner honors root and descendant `.gitignore` rules. A repository-local `.recallignore` may add product-specific exclusions using gitignore syntax. Explicit CLI includes may override non-security exclusions.

Only supported source files count toward `maxFiles`. Unsupported extensions remain summarized by bounded counts and a bounded extension list. The scanner does not retain tens of thousands of unsupported locators for a public response.

### Locator and label safety

Repository-relative locators and display labels use separate validation rules.

The locator validator rejects absolute paths, traversal, encoded traversal, and known temporary absolute-path prefixes. The display-label validator accepts ordinary repository directories named `users`, `private`, or similar when the complete value is repository-relative.

No response exposes an absolute root, home directory, credential, source body, or remote URL.

### Bounded graph construction

Graph size limits must produce partial results, not an unavailable graph.

The builder applies deterministic budgets during construction:

- preserve file, contains, defined-in, import, export, and call structure first;
- retain high-confidence references next;
- omit low-signal references when the edge budget is reached;
- report represented and omitted node and edge counts by kind;
- mark coverage `partial` with stable reason codes.

The public preview validates only the bounded public envelope. An internal graph exceeding a public preview limit cannot make the entire preview appear empty.

### Reuse and invalidation

Recall Map, Map search, trace, and impact requests share one explicit source-graph snapshot service per server. The service is injected into callers and does not use hidden global state.

A snapshot is identified by the canonical root, graph-builder version, relevant ignore-rule hash, and a deterministic source fingerprint. The fingerprint covers supported repository-relative locators and content hashes.

After the first build, the service watches included source directories and relevant ignore files. A relevant create, change, delete, rename, or watcher overflow marks the root dirty. Requests against a clean root reuse the snapshot without rediscovering or rehashing the repository. A dirty root rebuilds and produces a new fingerprint. Explicit refresh always marks the root dirty.

When recursive watching is unavailable, the service may validate freshness with a bounded metadata manifest before reuse. The interface labels this fallback check as a scan. Map queries against a snapshot already accepted for the current request do not repeat that validation.

The first release implementation may use an in-process cache. Persistent incremental indexes require a separate storage decision and are not implied by this specification.

Concurrent requests for the same canonical root and dirty generation share one in-flight build. Cancellation or failure clears the in-flight entry without poisoning the last valid snapshot.

## UI module boundaries

The current `apps/web/app.js` is too large to remain the owner of routing, API state, view models, renderers, and graph layout.

The redesign introduces these focused modules while preserving static ESM and zero runtime dependencies:

- `apps/web/app.js`: boot, route coordination, and shared shell state.
- `apps/web/api.js`: loopback API requests and bounded error mapping.
- `apps/web/orientation-model.js`: pure Overview view-model construction and action selection.
- `apps/web/orientation-view.js`: Overview rendering and interactions.
- `apps/web/source-map-view.js`: Map rendering, URL state, outline parity, and inspector selection.
- `apps/web/memory-graph-view.js`: governed-memory graph rendering and outline parity.
- `apps/web/graph-layout-worker.js`: bounded layout work for detailed graphs.
- `apps/web/ui-primitives.js`: shared state panels, diagnostics, formatting, and safe escaping.

Modules communicate through explicit data objects and events. Route modules do not read storage, mutate canonical state, or own authentication.

The refactor is limited to code touched by Overview, Map, memory graph, and shared primitives. Other routes remain in place until their existing ownership plan runs.

## Loading, partial, empty, and failure states

### Loading

The repository truth bar and layout skeleton render immediately. The work area states which local operation is running. Repeated requests for one snapshot reuse the in-flight build.

### Partial

Partial coverage shows represented files, omitted files or relationships, reason codes translated into plain language, and the safest next action. Available results remain usable.

### Empty

`No supported source files` and `No governed memory yet` are distinct states. Neither produces a large blank canvas.

### Failure

A graph failure states:

1. what failed;
2. whether the last valid snapshot is still shown;
3. whether local or canonical state changed;
4. the safest retry;
5. the correlation identifier or diagnostic command when available.

The interface cannot announce `ready` after the graph facade returns an unavailable diagnostic. Form values survive recoverable failures.

## Performance requirements

Performance measurements are local implementation gates, not universal hardware claims.

- An unchanged in-process snapshot must avoid a second full graph build.
- Map queries against an unchanged snapshot must complete without walking the repository again.
- The large local audit repository must return a non-empty success or truthful partial result. It must not return a false zero-result success.
- Cold and cached timings must be recorded by the large-repository smoke script. The cached path must be at least 80% faster than the cold path on the same machine and fixture.
- The browser must not run an unbounded quadratic layout loop on the main thread.
- The first-screen architecture map renders at most 12 groups and the detailed graph renders a bounded focused neighborhood.
- No frontend framework, graph library, model call, network service, or runtime dependency is added.

## Security and side effects

- Source scanning and all graph views remain read-only.
- Canonical memory, policy, approvals, and handoffs do not change during orientation or graph exploration.
- No new network access or external writes are enabled.
- Ignore rules cannot broaden filesystem access outside the canonical repository root.
- Retrieved source metadata cannot modify policy, permissions, or permanent memory.
- The UI receives bounded locators and summaries, not raw source bodies.

## Verification

### Source graph tests

Add focused coverage for:

- nested worktrees, agent directories, virtual environments, and generated output excluded before file accounting;
- `.gitignore` and `.recallignore` behavior;
- more than 1,000 supported files returning truthful partial coverage;
- a legitimate repository-relative `/users/` path remaining valid;
- graph construction exceeding 50,000 candidate edges returning bounded partial output;
- structural edges outranking low-signal references when budgets apply;
- concurrent callers sharing one graph build;
- cache reuse and fingerprint invalidation;
- unavailable diagnostics never becoming a zero-result ready state.

### UI tests

Add focused coverage for:

- the first-ten-seconds fields appearing in the first desktop viewport;
- every useful group for fixtures with fewer than 6 groups, and 6 to 12 groups for larger populated fixtures;
- exactly three `Start here` items when available;
- clean, changed, partial, stale, empty, loading, and failure states;
- query and scope state surviving submit, failure, reload, back, and forward;
- the memory graph omitting its canvas when empty;
- visual and outline selection producing the same inspector model;
- keyboard access, visible focus, reduced motion, and screen-reader status;
- no horizontal overflow at 320, 375, 414, 768, and 1440 px;
- light and dark modes.

### End-to-end verification

Run:

- focused source-graph, Recall Map, Control API, and web-shell tests;
- protocol fixture validation;
- a generated large-repository smoke fixture;
- the current 1,627-file local audit repository as a non-CI validation target;
- consumer smoke and consumer browser smoke;
- full `npm run ci`;
- release-readiness checks;
- npm package smoke from a packed artifact installed into a fresh repository.

The browser pass captures Overview, Map, populated memory graph, and empty memory graph at desktop and mobile widths. Every accepted screenshot is inspected before handoff.

## Acceptance criteria

The work is complete when:

- a large repository returns useful bounded graph data or an explicit partial/failure state, never a false empty success;
- repeated Overview and Map operations reuse the same unchanged source snapshot;
- ordinary repository-relative directory names do not trigger absolute-path safety failures;
- Overview presents repository truth, every useful group for small repositories or 6 to 12 groups for larger repositories, three starting points when available, current impact, and trusted context within the first desktop viewport;
- Map progressively reveals group, file, and symbol detail without rendering the full graph;
- empty memory does not render an empty graph canvas or zero-value metric strip;
- all visual graphs have equivalent keyboard-reachable outlines;
- submitted queries and scope survive navigation and recoverable failures;
- the touched frontend code is split into the explicit modules above without adding runtime dependencies;
- security, local-only, proposal-review, and external-write boundaries remain unchanged;
- all focused, protocol, browser, full CI, release-readiness, and packed-package checks pass;
- before-and-after large-repository screenshots and cold/cached timing evidence are attached to the implementation handoff.

## Non-goals

This specification does not add:

- a hosted service or cloud graph database;
- embeddings, model reranking, or a chat interface;
- automatic permanent memory;
- write-capable MCP tools;
- non-JavaScript/TypeScript graph coverage;
- a frontend framework or graph visualization dependency;
- persistent incremental graph storage;
- redesigns of the Memory review queue, Handoffs workflow, Settings, or setup beyond shared-shell compatibility;
- npm publication or GitHub merge as part of implementation.

Publication remains a separate maintainer action after all release gates pass.
