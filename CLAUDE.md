# AsciiMark

Tauri 2 + SolidJS monorepo — desktop app, browser extension, and marketing
site under `apps/*`, with shared logic in `packages/*`.

<!-- ai-memory:start -->
## LLM Memory (ai-memory)

Durable project knowledge and the agent operating rules live in **ai-memory**,
not in this repo. They're recalled through the ai-memory MCP, scoped to this
project by the operator-local `.ai-memory.toml` marker (git-ignored). On a
checkout without that marker, work from the code and its tests.

Recall before acting on durable knowledge; write canonical findings back:

1. **Recall** the project's rules, decisions, and gotchas (`memory_query` /
   `memory_recent`) before proposing designs or explaining why something works
   the way it does. Shared, cross-project engineering rules are recalled
   cross-scope per the operator's global configuration.
2. **Read** a page directly when you already know its topic.
3. **Write back** — when you discover a canonical rule, decision, gotcha,
   schema, or operational constraint, persist it with `memory_write_page` and
   link related pages with `[[...]]`.
<!-- ai-memory:end -->
