# Initial Design Plan Snapshot

> **Status:** Historical research input captured on June 19, 2026. It is not implementation status, legal advice, or a current compatibility claim. Re-verify upstream repositories, licenses, releases, install scripts, and network behavior at an exact commit before integration.

---

## Introduction

This document outlines a complete design for an open‑source, local‑first “super agent” tool.  The goal is to integrate best‑in‑class components for memory, knowledge graphs, design, research and multi‑model evaluation into a cohesive system.  The metaphor of a “cure to cancer” emphasizes the ambition to build a platform that is robust, modular and radically useful—without relying on proprietary hosted services.

## Core Goals

1. **Local‑first**: All major functionality should run on the user’s machine. External calls (e.g. to social APIs or LLM providers) are optional and should occur through explicit modules and user‑provided keys.
2. **Open‑source & community‑driven**: Use permissive licenses (Apache 2.0 for the core) and transparent contribution guidelines to foster collaboration.
3. **Modularity & replaceability**: Architect the system so that models, tools, memory stores and workflows can be replaced without breaking the rest of the platform.
4. **Evidence‑driven workflows**: Agents must provide citations for their decisions and produce context manifests for each step.  This improves traceability and accountability.
5. **Security & privacy**: Default to minimal permissions, sandbox untrusted code, and prevent prompt‑injection by treating retrieved content as data rather than instructions.

## Architecture Overview

The platform builds on the **Agent Intelligence Fabric** design summarised previously.  It contains four core layers:

1. **Context Compiler** – selects only the smallest necessary context for each model call and produces a machine‑readable manifest.  It integrates multiple memory back‑ends and applies forced inclusion, candidate generation, reranking, diversity and budgeting steps.
2. **Durable execution & event plane** – a workflow runtime (e.g. Temporal) that handles scheduling, retries, approvals, idempotency and event logging.  It ensures every action is recorded and resumable.
3. **Permissioned capability fabric** – connects models, tools, skills, sandboxes, and external APIs through stable interfaces with explicit declarations of network and file access, side‑effect class, cost budgets and approval requirements.
4. **Evidence‑first product interface** – a UI that surfaces outcomes, sources, decisions, memory versions, costs, approvals and uncertainty without revealing hidden chain‑of‑thought.  Progressive disclosure allows users to drill from outcomes down to raw traces.

## Module Integration

### Persistent Memory with **claude‑mem**

Claude‑mem provides a local memory layer for coding agents.  Its key features include **persistent memory** that survives across sessions, **progressive disclosure** for token‑efficient retrieval, a **mem‑search** tool for natural language queries, a **web viewer UI**, and privacy controls via `<private>` tags.  Under the hood, claude‑mem uses lifecycle hooks, a Bun‑based worker service, SQLite storage and a Chroma vector index.

**Integration**: Use claude‑mem as a pluggable memory backend.  When the Context Compiler needs historical context, it calls claude‑mem’s `search`, `timeline` and `get_observations` tools in the prescribed order.  This returns a concise index first, then timelines around interesting IDs, and finally full observation details—limiting token usage.  Persist important observations into claude‑mem via its API; mark sensitive data as `<private>` to exclude it from storage.

### Knowledge Graphs via **graphify**

Graphify converts a folder of code, SQL schemas, scripts, docs and media into a queryable knowledge graph.  It outputs an interactive `graph.html`, a `GRAPH_REPORT.md` summarising key concepts and a machine‑readable `graph.json`.  It supports numerous agent platforms (Claude Code, Codex, Copilot CLI, Cursor, Gemini CLI and more) and offers optional extras for PDFs, Office docs, video transcription and pushing graphs to Neo4j or FalkorDB.

**Integration**: Use Graphify to precompute knowledge graphs for codebases and documentation.  Load `graph.json` into the platform’s data layer and expose graph traversal functions (e.g. find neighbours, shortest paths) as part of the Context Compiler.  Provide the interactive `graph.html` via the UI so developers can explore architecture and dependencies.  Graphify’s MIT license permits embedding its code directly.

### Local Design & Prototyping with **Open Design**

Open Design is a **local‑first alternative to Claude Design**.  It ships a native desktop app that supports more than **100 skills** and over **150 design systems**; it generates web, desktop and mobile prototypes, live dashboards, slides, images, videos and HyperFrames, exporting them to **HTML, PDF, PPTX and MP4**.  The agent loop includes discovering the brief, locking the direction, streaming the artifact and iterating based on feedback.  It has no telemetry and supports BYOK for model providers.

**Integration**: Use Open Design’s MCP tools to create user interfaces and visual assets from `DESIGN.md` design contracts.  Set up a `design` module in the tool registry that calls Open Design to generate prototypes, HyperFrames, slides and images.  Use the exported HTML or PPTX directly in the product dashboard.  Because Open Design runs locally and uses Apache‑2.0 licensing, it can be included as a component of the platform without hosting dependencies.

### Cross‑Platform Research with **last30days‑skill**

last30days‑skill searches Reddit, X/Twitter, YouTube, TikTok, Hacker News, Polymarket, GitHub and other sources, scoring results by **what people actually engage with**—upvotes, likes, views and prediction market odds.  It synthesizes the findings into a single brief and can reveal news or opinions that search engines miss.  The skill is MIT‑licensed and has no tracking or analytics.

**Integration**: Use last30days as the research backend for content‑intelligence agents.  Provide the necessary API keys and session cookies locally (stored securely).  After each run, store the raw observations and the synthesized brief as events in the data layer.  These can feed into the Context Compiler and appear in the evidence explorer.  A scheduled workflow in Temporal can run last30days regularly and update pattern libraries.

### Multi‑Model Evaluation with **Oracle**

Oracle is a CLI that bundles prompts and files, then calls multiple LLMs (GPT‑5.x, Gemini, Claude, etc.) with the same context.  It can run in browser mode without API keys or in API mode with user keys.  Oracle supports multi‑model panels, follow‑ups, partial success and performance tracing.

**Integration**: Use Oracle as a tool for cross‑model evaluation.  Register it as a skill so that evaluators can send prompts and code files to several models and compare their outputs.  For instance, after generating code via one model, run Oracle with the same prompt against other models to detect divergence or hallucination.  Browser mode can leverage ChatGPT or Gemini with manual login, while API mode works with user‑supplied keys.  Results should be captured in the event ledger for auditing and benchmarking.

## Implementation Plan

### 1. Repository setup

* **License and governance**: Adopt Apache 2.0 for the core codebase and ensure compliance with third‑party modules (claude‑mem, graphify, open‑design, last30days‑skill and Oracle all permit inclusion via MIT or Apache licenses).  Create `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` and `SECURITY.md` files.
* **Repo structure**: Use the skeleton proposed in the Open Agent Fabric design, with `apps/` for web and CLI, `services/` for control‑plane microservices (workflow worker, context compiler, etc.), `packages/` for SDKs and UIs, `adapters/` for memory, tool and agent connectors, `skills/` for task‑specific instructions and `workflows/` for ready‑made processes (e.g. content intelligence).  Include `docs/` and `rfcs/` folders for design documentation.

### 2. Core services

* **Event ledger and database**: Set up PostgreSQL with `pgvector` for hybrid retrieval.  Define tables for events, artifacts, facts, entities, preferences, observations, decisions and policies.  Use object storage (local or S3) for large artifacts.
* **Workflow engine**: Deploy Temporal locally (Docker or binary) for durable execution.  Implement the control API in a language like TypeScript or Go that enforces typed messages.  Include endpoints for starting, resuming and cancelling runs.
* **Model gateway**: Wrap LiteLLM or your own connectors in a `ModelGateway` service with routing based on capabilities, cost and privacy requirements.  Provide local model support through vLLM or llama.cpp.
* **Context compiler**: Implement a service that receives structured requests (workspace, actor, task, step, budget, required entities and artifacts) and returns context manifests.  Integrate claude‑mem as one memory backend; allow switching to Mem0 or OpenViking through adapters.  Use Graphify graphs and pgvector as retrieval sources.
* **Tool registry and policy engine**: Define a manifest schema for tools and skills (network domain, file paths, cost budgets, side‑effect classification, approval requirements).  Implement policy evaluation with OpenFGA and OPA.

### 3. Module adapters

* **claude‑mem**: Write a wrapper around the `search`, `timeline` and `get_observations` endpoints.  Provide a `persist` function that writes observations into claude‑mem’s SQLite via its HTTP API.  Expose `<private>` tagging to the agents.
* **Graphify**: Provide a CLI wrapper to generate graphs from a given repository path.  After running Graphify, parse `graph.json` and ingest nodes and edges into the data layer.  Expose a tool that returns graph neighbours and paths to the context compiler.
* **Open Design**: Run its MCP server as a subprocess and register its skills (prototype generation, HyperFrames, decks, images).  Provide a tool interface for each artifact type, passing the `DESIGN.md` and any user instructions as input.
* **last30days‑skill**: Install the skill locally and register its main function as a tool (e.g. `last30days.search`).  Wrap it to handle credential lookup and to ensure that returned data is stored into the event ledger with source metadata.
* **Oracle**: Provide a wrapper script that runs the Oracle CLI with the desired models and context files.  Capture stdout and store the responses.  Offer tool parameters for selecting models, enabling browser mode and specifying follow‑up prompts.

### 4. Frontend & UX

* Build a Next.js application using shadcn/open-code components.  Incorporate React Flow for workflow visualisation.  Integrate AG‑UI to stream agent events and progress.  Respect Vercel’s web interface guidelines for accessibility, deep linking, keyboard navigation, reduced motion, and responsive design.
* Include views for: **Dashboard** (ongoing runs, scheduled tasks, approvals), **Evidence Explorer** (sources, transcripts, metrics), **Pattern Library**, **Graph Explorer** (interactive graphify output), **Design Studio** (Open Design artifacts) and **Run Timeline** (event trace and context manifest).

### 5. Security & privacy

* Enforce sandboxing for code execution and file reading.  Use Firecracker‑based containers (via E2B or Daytona) for untrusted tasks.
* Prompt injection defense: treat all external content as data; do not embed it directly in system prompts.  Use the context compiler to select relevant information and summarise it into a safe format.
* Implement identity and access control with OpenFGA, mapping users, workspaces, roles and resources.  Evaluate policies with OPA before executing tools or performing external writes.

### 6. Launch and open‑source

* **Repository hosting**: Host on GitHub or a self‑hosted Git server.  Provide clear instructions for running locally (Docker Compose or a `dev.sh` script) and for contributing (pre‑commit hooks, test suites, style guides).
* **Initial release**: Start with the content intelligence workflow.  Ship a working pipeline: scheduled research via last30days, pattern extraction, angle generation, human approval, draft creation via a model call, multi‑model verification with Oracle, and publication via Postiz (optional).  Record context manifests and events.  Use Graphify and Understand Anything to visualise code relationships for this repository itself.
* **Community engagement**: Write an RFC about the context compiler and memory layer.  Invite contributions on adapters for additional memory back‑ends, new skills and alternate workflow engines.  Use a Developer Certificate of Origin to ensure contributions are legally clear.

## Conclusion

By combining a **durable execution plane**, a **context compiler**, a **permissioned tool registry**, and specialized modules for memory, graphs, design, research and evaluation, this platform can deliver a local, open‑source agent tool that is as transformative for agent developers as a “cure” would be for a disease.  It balances modularity with structure, prioritises evidence and reproducibility over hype, and invites community collaboration from day one.  Adhering to these principles should produce a robust foundation for the next generation of agentic applications.
