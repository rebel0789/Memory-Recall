# Native Source Graph Before External Code-Memory Adapters

OAF will build source-graph context as a native capability before adopting any external
code-memory adapter as a runtime dependency. External projects can be useful references and
benchmark targets when they demonstrate fast local indexing, graph search, BM25-style
lookup, structural filters, call/data-flow tracing, architecture summaries, graph-augmented
code search, git diff impact mapping, compact result modes, pagination/truncation signals,
and shareable graph artifacts. OAF should learn from those capabilities and reproduce the
ones that pass OAF's context-manifest, policy, artifact, and evaluation gates.

OAF will not make an external code-memory adapter canonical source, memory, event, policy,
artifact, or tool state. Any future adapter must remain disabled by default, pinned by
commit and checksum, license-reviewed, conformance-tested, read-only unless an exact
operation grant exists, and unable to mutate OAF state without OAF policy evaluation and
canonical events. OAF also will not repeat external token-saving or latency claims until
they are reproduced by OAF benchmarks against checked-in fixtures.
