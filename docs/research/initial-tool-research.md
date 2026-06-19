# Initial Tool Research Snapshot

> **Status:** Historical research input captured on June 19, 2026. It is not implementation status, legal advice, or a current compatibility claim. Re-verify upstream repositories, licenses, releases, install scripts, and network behavior at an exact commit before integration.

---

## Objective

The goal is to assemble a **local‐first, open‑source "super‑agent" platform** that gives power users and developers a complete stack for code, content and design agents **without purchasing proprietary services** or sending data off‑site.  All major components should run on the user’s machine, use permissive licenses, and integrate seamlessly with existing agent frameworks.

## Why local and open source?

The HydraDB article reminded us that long‑context models alone cannot solve agent drift; intelligent selection and structured memory are essential.  A local platform avoids vendor lock‑in and allows users to control data residency and customization.  Using open‑source tools across the stack preserves flexibility and encourages community contributions.  The libraries examined below can serve as building blocks for such a platform.

## Key technologies and how they fit

### 1. **claude‑mem** – persistent local memory

* **Purpose:** Provides a **persistent memory compression system** for coding agents.  It automatically captures tool output and observations, stores them in a local SQLite database, and injects only the most relevant context back into the next model call using a **progressive disclosure** scheme.  
* **Features:**
  * **Persistent Memory** – context survives across sessions.  
  * **Progressive Disclosure** – layered memory retrieval that reveals coarse indexes first, then timelines and full observation details, saving tokens and reducing noise.  
  * **Skill‑Based Search:** a `mem-search` skill allows natural language queries against stored observations.  
  * **Web Viewer UI:** a web interface running on `localhost:37777` streams your memory in real time and allows retrieval by ID.  
  * **Privacy Controls:** `<private>` tags exclude sensitive content from storage.  
  * **Architecture:** uses five lifecycle hooks, a Bun‑based worker service, a SQLite database and a Chroma vector index for hybrid semantic/keyword search.  

* **Integration:** Use claude‑mem as the local memory back‑end for agent sessions.  It stores observations in SQLite (easy to embed) and returns only the minimal necessary context via its progressive disclosure API.  The platform’s **Context Compiler** can call claude‑mem’s search tools to build context manifests for each step, thereby avoiding context bloat.  Privacy tags allow the user to exclude data from persistent memory.  The open‑source licensing (Apache‑2.0) lets us adapt the worker service and UI for our platform.

### 2. **graphify** – turning code and docs into a knowledge graph

* **Purpose:** Graphify is a **skill that analyses a folder of code, SQL schemas, scripts, documentation, images and videos** and builds a knowledge graph that can be queried instead of manually grepping through files.  It outputs three files: `graph.html` (interactive graph), `GRAPH_REPORT.md` (key concepts and suggested questions) and `graph.json` (machine‑readable graph).
* **Platform support:** Works with Claude Code, Codex, OpenCode, Cursor, Gemini CLI, GitHub Copilot, VS Code Copilot Chat and many other agent platforms.  
* **Optional extras:** supports PDF extraction, Office files, video transcription, MCP server integration, and pushing graphs to Neo4j or FalkorDB.

* **Integration:** Graphify can serve as the **knowledge‑graph provider** for our super‑agent.  When ingesting a repository or project, Graphify will generate a graph that our agents can traverse for context.  The generated `graph.json` can be loaded into memory and used as a structured knowledge base.  The interactive `graph.html` can be integrated into the UI for developers to explore relationships.  Because Graphify is written in Python and licensed under MIT, we can embed it as a library rather than a separate skill.  For large codebases, Graphify complements the *Understand Anything* graphs we already planned to use.

### 3. **Open Design** – local‑first design and prototyping

* **Purpose:** Open Design is a **local‑first alternative to Anthropic’s Claude Design**.  It is a native desktop app that runs on macOS, Windows and optional Linux, with **over 100 design skills and more than 150 design systems** built into a single tool.  It can generate **web, desktop and mobile prototypes, dashboards, slides, images, videos and animated HyperFrames** and export them to **HTML, PDF, PPTX or MP4**.
* **Workflow:** The platform introduces an **agent‑native design loop** where the agent discovers the brief, locks direction, streams artifacts, receives critique and delivers final assets.  It uses your project’s `DESIGN.md` as a brand contract.  
* **Local and BYOK:** Open Design emphasises local execution with **no telemetry** and BYOK (bring your own key) for models.
* **Compatibility:** It integrates with many agent CLIs through an **MCP server**; once installed, you can call its design tools from Claude Code, Codex, Copilot and other environments.

* **Integration:** Use Open Design as the **UI and artifact generation module**.  Design agents can call its MCP tools to produce prototypes, slides and graphics that adhere to a `DESIGN.md`.  This ensures that all generated interfaces follow a consistent brand and accessible design guidelines.  Because it runs locally and exports real CSS and assets, it fits well into a local product pipeline.  You can also supply templates for agent dashboards and reports.  The license (Apache‑2.0) allows use in a permissively licensed project.

### 4. **last30days‑skill** – cross‑platform research and trend detection

* **Purpose:** This skill searches **Reddit, X/Twitter, YouTube, TikTok, Hacker News, Polymarket, GitHub and other sources** to find what people are actually talking about.  It scores sources by **people’s engagement**—upvotes, likes, comments, views and prediction market odds—then synthesizes a grounded summary.  Each report merges posts and videos into a single cluster with citations and context.
* **Why it matters:** Google and ChatGPT can’t search across these walled gardens; last30days bridges them by letting you bring your own API keys and sessions.  This gives a more accurate view of what the community cares about.  The skill emphasises recency, relevance and freshness and produces one coherent brief rather than a list of links.  It is licensed under MIT and does not send analytics.

* **Integration:** Use last30days‑skill as the **research layer** of your content and strategy agents.  For example, the content‑intelligence workflow can call last30days to gather posts, comments and market signals on a topic, then feed them into your Context Compiler.  Its scoring approach (engagement rather than SEO) makes it more relevant for social content creation.  Because the skill uses Python and Node and is open source, you can embed it directly.  You’ll need to manage API credentials locally; the platform should store them securely and only send them when retrieving new data.

### 5. **Oracle** – multi‑model query runner

* **Purpose:** Oracle is a **CLI that bundles a prompt and files so multiple LLMs can answer with the same context**.  It supports **GPT‑5.5 Pro, GPT‑5.4, GPT‑5.1, Gemini 3 Pro/Flash, Claude Sonnet 4.6, Claude Opus and more**, and can run multiple models in one run for cross‑checking.  It offers two engines:
  * **Browser mode:** automates your Chrome session so you can use ChatGPT or Gemini without an API key.  
  * **API mode:** uses your own API keys to call models directly.  

* **Workflow:** You run the CLI with a prompt and optional files; it bundles them, queries one or more models, and returns the answers.  You can specify models, use `--allow-partial` for partial success, and even generate follow‑up prompts or multi‑turn consultations.  Oracle also exposes a TUI for interactive use and can record sessions for later replay.

* **Integration:** Use Oracle as the **multi‑model judge** in evaluation workflows.  For tasks where reliability matters (e.g., code generation, design critique), run the same query through several open‑source or proprietary models and compare their outputs.  This can surface disagreements and reduce hallucinations.  Because Oracle supports browser mode, you can even use it with ChatGPT or Gemini using manual login while keeping the rest of your stack local.  The MIT license means it can be embedded or wrapped as part of a service.  You will need to supply API keys or ensure the user logs in manually once, but the rest of the operations remain local.

## Putting it all together

The previously proposed **Agent Intelligence Fabric** separated the platform into a context compiler, a durable execution plane, a tool and model gateway, and a horizontal memory layer.  The new components fit into this architecture as follows:

| Layer | Role | Proposed integration |
|------|------|--------------------|
| **Durable runtime & workflow** | Long‑running workflows with retries, approvals and scheduling | Use **Temporal** as before, running locally or self‑hosted.  Last30days and Oracle tasks can be scheduled here and their outputs stored as events. |
| **Agent runtime layer** | Bounded model reasoning and state graphs | Continue to support native runner, LangGraph and other frameworks.  Oracle can be exposed as a tool that spawns multi‑model queries.  Graphify operates offline and feeds knowledge graphs into the context compiler. |
| **Context compiler & memory** | Select minimal context, manage memory & provenance | Add a **claude‑mem adapter** that uses its search tools to obtain relevant observations, then integrate them with other memory stores (Mem0, OpenViking).  Progressive disclosure ensures only necessary context enters the model. |
| **Tool/skill gateway** | Connects skills and tools to agents | Register **graphify**, **last30days** and **oracle** as tools.  Use environment variables or secrets for API keys.  Provide wrappers that handle authentication and data formatting. |
| **Knowledge and design** | Visual graphs, reports, design artefacts | Use **graphify** for code and document graphs.  Use **Open Design** for generating prototypes, slides and images; integrate its MCP server into the tool gateway.  
| **Front‑end & UI** | Present runs, context, evidence and design assets | Extend the UI to support interactive graph exploration (`graph.html`) and embed prototypes or slides produced by Open Design. |
| **Research & signals** | Trend detection and content insights | Add a **Research module** that calls **last30days‑skill** to gather evidence about topics, people and tools.  It outputs a brief with citations and engagement scores, which feed into the Content Intelligence workflow. |
| **Evaluation & multi‑model cross‑check** | Validation using multiple models | Introduce **Oracle** as a tool to run cross‑model evaluations.  Use it in test suites or manual review steps to compare LLM outputs. |

## Recommendations for a complete local stack

1. **Choose local models first.**  Use open‑source LLMs (e.g., LLaMA‑3, Mistral, DeepSeek) via a local inference server (vLLM, llama.cpp) when possible.  Where proprietary models are necessary (e.g., for evaluation or design tasks), use BYOK connectors or Oracle’s browser mode so that the platform remains vendor‑neutral.

2. **Persist memory using claude‑mem and other back‑ends.**  Store observations, summaries and decisions in the claude‑mem SQLite database.  Add adapters for Mem0 or OpenViking to experiment with alternative memory architectures.  Use `private` tags to avoid persisting sensitive data.  Expose explicit `memorize` and `forget` actions to users.

3. **Apply retrieval and selection best practices.**  Use graph traversal, temporal filtering, lexical and semantic search, then rerank according to task relevance.  Progressive disclosure (index → timeline → full data) should be the default memory retrieval pattern.  Record a **context manifest** for every model call to allow debugging and evaluation.

4. **Plan for secure local operations.**  Store API keys (Twitter, YouTube, etc.) in a local secrets vault.  Only the research module should access them, and network connections should be restricted by default.  Tools like last30days must respect rate limits and terms of service.

5. **Design agent experiences using Open Design.**  Document design systems in `DESIGN.md` files and keep them versioned in Git.  Use Open Design to generate prototypes, dashboards and slides that adhere to accessibility and responsive guidelines.  Provide your agents with design‑review skills that audit generated artifacts against the `DESIGN.md` contract.

6. **Create evaluators and cross‑model panels.**  Use Oracle to run prompts through multiple models when evaluating tasks that require correctness (e.g., code generation).  Compare outputs and choose consensus answers or request human review when models disagree.  Record evaluation metrics using OpenTelemetry and Langfuse or OpenLIT.

7. **Respect licensing and modularity.**  All selected projects (claude‑mem, graphify, open‑design, last30days‑skill and oracle) are MIT or Apache licensed, so they can be included in an Apache‑licensed core.  Keep them as optional modules to avoid bloating the core.  Document clear instructions for installation, dependencies (Node, Bun, Python) and how to update them.

## Conclusion

A fully local, open‑source super‑agent platform is feasible by combining a **durable execution engine**, a **context compiler** and **horizontal memory**, with specialized modules for memory (claude‑mem), knowledge graphs (graphify), design (Open Design), research (last30days‑skill) and multi‑model evaluation (Oracle).  This approach avoids cloud lock‑in, respects user privacy and leverages the strengths of each tool to produce agents that are **context‑aware**, **evidence‑backed**, **visually polished** and **adaptively reliable**.
