# AsciiMark — agent guide

Operating rules and durable project knowledge live in **ai-memory**, not in
this file. Recall them before starting work.

## Where things live

- **Shared engineering rules** → ai-memory **`default` / `development`**, under
  **`_rules/*.md`**: `pre-work`, `code-quality`, `context-management`,
  `edit-safety` (in `safety`), `working-style`, `workflow`, `safety`,
  `code-style`, `communication`, `react`, `plugins`, `testing`. Plus the
  reusable testing reference: `testing/techniques.md`,
  `testing/by-project-type.md`.

  These are **cross-scope** — a repo session is scoped to its own
  `.ai-memory.toml` (`djalmajr`/`asciimark`) and ai-memory's auto-recall is
  per-(workspace, project), so it will **not** surface them automatically.
  Pull them explicitly:
  - `memory_query` with `scopes:[{ workspace: "default", project: "development" }]`
    (or `global: true`), or
  - `memory_read_page` with `workspace: "default"`, `project: "development"`,
    `path: "_rules/<name>.md"`.

- **AsciiMark specifics** → ai-memory **`djalmajr` / `asciimark`**:
  - `architecture/*` — overview, ipc, i18n, preview-pipeline,
    keyboard-shortcuts, media-viewer, desktop-updater.
  - `conventions/solid-ui.md` — use existing solid-ui primitives, never reimplement.
  - `release/*` — flow, pipelines, signing-keys, extension.
  - `process/linear-workflow.md` — Linear is the source of truth for plans.
  - `decisions/*` (ADRs), `testing/*` (strategies, conventions, operations,
    followups), `gotchas/*` (dev-environment), `performance/targets.md`.

<!-- ai-memory:start -->
## LLM Memory (ai-memory)

Before answering or acting on durable project knowledge, recall from the ai-memory MCP
(server `memory-personal`, workspace `djalmajr`, project `asciimark`).

1. Read the project's agent rules — including the shared `_rules/*` in
   `default`/`development` (recall cross-scope, see above).
2. `memory_query` (semantic recall) via the ai-memory MCP, for the relevant workspace/project.
3. Read the page markdown directly (or `/api/v1`) when the target path is known.
4. If a task discovers a canonical rule, gotcha, schema/contract, operational constraint, or
   product decision, persist it via `memory_write_page` and link related pages with `[[path.md]]`
   (page paths carry the `.md` suffix; links resolve by exact path).

Semantic decisions from conversation and debugging belong to the agent — recall before acting,
write back when you learn something canonical.
<!-- ai-memory:end -->
