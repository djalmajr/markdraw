# AsciiMark

Tauri 2 + SolidJS monorepo — desktop app, browser extension, and marketing
site under `apps/*`, with shared logic in `packages/*`.

Durable project knowledge and the agent operating rules are **not** kept in
this repo. For the maintainer they live in a private ai-memory instance and
are recalled through the ai-memory MCP, wired by an operator-local
`.ai-memory.toml` marker (git-ignored). On a checkout without that marker this
repo carries no extra agent instructions — work from the code and its tests.
