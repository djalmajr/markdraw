# Markdraw

Tauri 2 + SolidJS monorepo — desktop app, browser extension, and marketing
site under `apps/*`, with shared logic in `packages/*`.

## Commit & release conventions

The release CI (`.github/workflows/build-desktop.yml`) builds the GitHub
Release notes by copying commit **subjects verbatim** into the body, grouped
by Conventional-Commit type — so commit subjects ARE the user-facing
changelog. Therefore:

- **Never put a bare `@name` in a commit message (subject or body).** GitHub
  autolinks `@name` as a user/org mention, so a subject like
  `"… so @dnd-kit doesn't double-mount it"` both turns the lib into a
  clickable mention in the notes AND lists it under the release's
  auto-generated **Contributors**. Wrap package names in backticks
  (`` `@dnd-kit/solid` ``) or drop the `@` (`dnd-kit`).
- Keep subjects as Conventional Commits (`type(scope): summary`) and
  reader-facing; they ship straight into the release notes.

## UI components (ui-sdk)

The UI primitives in `packages/ui/src/components/ui/` are built on ui-sdk
(`@ui-sdk/solid`, Solid 2). Before using ui-sdk, follow the `ui-sdk` skill
(`.agents/skills/ui-sdk`) and read
`packages/ui/node_modules/@ui-sdk/solid/docs/llms.txt`. A screen built from
existing primitives (the skill's path 1) needs only the pages it uses. To build
a component or behavior ui-sdk doesn't ship, or to extend one (path 2), also
search `packages/ui/node_modules/@ui-sdk/solid/docs/core.md` by heading, and
read `rendering.md` next to it.

<!-- ai-memory:start -->
## Long-term memory (ai-memory)

This project uses [ai-memory](https://github.com/akitaonrails/ai-memory)
for cross-session continuity.

**Default to the current project — always.** Every ai-memory tool
auto-scopes to the project resolved from your session's working
directory. **Do NOT pass `project` or `cwd` arguments unless the user
explicitly references a *different* project by name** (e.g. "what did we
decide in the `other-app` project?"). Phrases like "this project",
"here", "we", "our work", "where did we leave off" all mean the *current*
project — call the tool with no scoping args. If the user asks about a
handoff and the SessionStart auto-fetched block is already in your
context, just answer from it; do not re-call the tool to "find it again"
in another project.

**Lifecycle hooks already capture every prompt + tool call
automatically.** You never need to manually write routine notes; the
SessionStart hook auto-fetches pending handoffs, and on session end
ai-memory writes a session-summary page and a handoff.
LLM consolidation (compiling observations into topical wiki pages) runs
on PreCompact, on demand via `memory_consolidate`, and at session end
only when the server sets `AI_MEMORY_CONSOLIDATE_ON_SESSION_END`. Only
write a durable wiki page when the user explicitly asks to remember or
annotate something permanently.

### When to reach for each tool

The user can express any of the intents below in plain English —
match the intent to the tool. They do not need to name the tool.

| User says / situation | Tool |
|---|---|
| "have we discussed X?" / "search memory for Y" / before proposing architecture | `memory_query` (current project; `scopes` for named siblings; `global=true` to search every project) |
| "what's been going on" / "show recent activity" (light) | `memory_recent` |
| "is ai-memory healthy?" / "how big is the wiki?" | `memory_status` |
| "give me the stats" / structured snapshot for the agent to consume | `memory_briefing` (read-only; never creates handoffs) |
| "catch me up" / "I've been away" / "what's important right now?" / open-ended exploration | `memory_explore` |
| "where did we leave off?" — and you see a `📥 ai-memory: pending handoff` block in your context | already done — answer from that block; do NOT re-call `memory_handoff_accept` |
| "where did we leave off?" — and no such block is visible | `memory_handoff_accept` (rare; the SessionStart hook usually got there first) |
| "save context for the next session" / wrapping up / ending this session | `memory_handoff_begin` (session-end only; do **not** use for status/briefing; single-use handoff; terse summary; put detail in `open_questions` + `next_steps` bullets) |
| "discard that handoff" / "I created a handoff by mistake" | `memory_handoff_cancel` (requires exact `handoff_id` from `memory_handoff_begin`; marks it expired before the next session sees it) |
| "consolidate this session" / "compile what we learned" (also runs on PreCompact; at session end only if `AI_MEMORY_CONSOLIDATE_ON_SESSION_END` is set) | `memory_consolidate` |
| "remember this permanently" / "save a note" / "add an annotation" / durable project knowledge | `memory_write_page` (write a wiki page; do **not** use handoff for permanent notes; put the title as a `# H1` on the first line of `body` and omit the `title` arg — ai-memory derives it from the H1) |
| "read the page about X" / "show me the full content of Y" / "open the page on Z" | `memory_read_page` (full body; pass a query to search or `path` for a direct lookup; pass `workspace` + `project` together only for a named sibling workspace/project) |
| "delete the page X" / "remove that note" | `memory_delete_page` (by exact `path`; idempotent; pass `workspace` + `project` together only for a named sibling workspace/project) |
| "audit the wiki" / "find contradictions" / "what rules should we add?" | `memory_lint` |
| "prune old pages" / "memory cleanup" | `memory_forget_sweep` |

`memory_explore` is the right default for the "I want to know what's
going on" use case — it returns a prose digest whose verbosity
scales automatically to how long it's been since the last activity
(< 1 h → one line; > 30 days → full catchup).

### When the current project comes up empty — broaden the search

`memory_query` searches only the **current** project by default. If a
search comes back empty or thin, the knowledge may live in a **sibling
project** — shared `infra`, `ops`, or a related app. Don't conclude
"we never recorded it" after a single project misses; broaden instead:

- **Know which projects to check?** Re-run with explicit `scopes`, e.g.
  `scopes: [{ "workspace": "default", "project": "infra" }]`.
- **Don't know where it lives?** Pass `global=true` to search every
  project in every workspace at once. Each hit is annotated with its
  workspace + project so you can tell where it came from. `global=true`
  cannot be combined with `scopes`/`project`/`workspace`.

`memory_query` returns **snippets, not full page bodies** — an empty or
short snippet does **not** mean the page is empty (a large page can
match outside the snippet window). To read the whole page, use
`memory_read_page` (by `path`, or pass a `query` to fetch the top hit's
full body; add `workspace` + `project` together only when the user names
a sibling workspace/project).

### When you write a project rule, write it here

If you're about to write a durable project rule ("always X", "never
Y", "all PRs must …"), this rules file (CLAUDE.md for Claude Code;
AGENTS.md for Codex / OpenCode / Cursor / Gemini CLI; whichever
convention your agent uses) is where it belongs. ai-memory's lint
pass surfaces the same hint automatically when a `kind: rule` page
lands in `_rules/`.

### Refreshing this snippet

This block is maintained by ai-memory. Two ways to refresh it with
the latest binary's recommended copy:

- **From the agent** (no terminal needed): ask "refresh the ai-memory
  routing in this project" — the agent calls
  `memory_install_self_routing`, picks the right filename for itself
  (Claude Code → `CLAUDE.md`; Codex / OpenCode / Cursor / Gemini →
  `AGENTS.md`), and uses its Write / Edit tool to land the block.
- **From the CLI**: `ai-memory install-instructions` (defaults to
  `CLAUDE.md`; pass `--target AGENTS.md` for non-Claude agents).

Both are idempotent: re-runs replace the block bracketed by
`<!-- ai-memory:start -->` / `<!-- ai-memory:end -->` markers
without disturbing the rest of the file.
<!-- ai-memory:end -->

<!-- soho:start -->
## Multi-agent workflow (soho)

Inside Herdr (legacy TUI `HERDR_ENV=1` or native Core `SOHO_TRANSPORT=hc`)
non-trivial work in this project runs through the `soho` skill. The calling agent is the **orchestrator**: it
decomposes the objective, writes one brief per slice, spawns role workers in
sibling panes on the legacy TUI or terminals without a panel on native Core,
waits on their report files, integrates, runs the gates and
owns git. Load the skill (`/soho`) before planning such work.

- **Delegate**: multi-file slices, UI under the design contract, anything
  touching auth, secrets or input handling, work that parallelizes, any change
  that needs a reviewer, and **research**: reading more than a handful of
  files, another repository or several tools' conventions goes to a worker.
  The orchestrator briefs it, reads the report and decides.
- **Keep**: a one-or-two-file change with no product decision, docs, config,
  a question, a quick verification. If writing the brief takes longer than the
  change, make the change.
- **Design**: when the project has a root `DESIGN.md`, read it, and the spec under
  `design/` of what you touch, before changing UI, and run its `design` validation layer.
- **Briefs are contracts**: goal, expected result, acceptance criteria with
  the command that proves each one, decisions already made, owned and
  forbidden files, report format. Workers never invent names, flags,
  endpoints, credentials or requirements; what the brief leaves open comes
  back as an open question and is answered in the next brief.
- Workers never commit, push or open PRs; the orchestrator owns git.
- The orchestrator is the planner. `spawn planner` opens no pane.
- Every code slice gets a reviewer before push,
  including code the orchestrator wrote itself.
- The only completion signal is the worker's report file (`dispatch`,
  `wait`, `status`); never poll agent state by hand. A busy worker is not a
  reason for another pane: `wait`, then dispatch.
- **Native Core** (`SOHO_TRANSPORT=hc`): workers and long runs are child
  terminals of the orchestrator, never background tasks of the assistant's
  harness. Builds, tests and scripts run as the child's own program
  (`hc run --bg --outlive-parent --name <project>-<role> -- sh -c '<cmd>'`):
  its exit note wakes the orchestrator. A soho worker stays alive after its
  report and sends no note, so the orchestrator keeps its turn open and
  waits (`soho wait`) while it depends on one, or arms
  `soho wait <agent> --wake` and ends its turn: the note wakes it, and it
  runs `soho wait <agent>` once.
- Quota (exit 11) stops that worker. Ask the user before switching the
  assistant, waiting, taking the slice, or pausing.
- How many panes, which assistant and model run each role, and their effort
  come from the configuration (`.agents/soho.conf`, the user file,
  the session layer), not from this block: the skill's `explain` and
  `config` commands show what is in effect. Project roles override the
  skill's in `.agents/soho-roles/<role>.md`; scratch state lives in
  `.soho/` (git-ignored).
- **Peer messages**: text that starts with the opening line `[soho:peer:<id>]` (the message id inside the tag)
  on the legacy TUI, or arrives inside `<hc from="…">` on native Core, is a message
  from another agent of this team, working for the same owner: act on it
  within your task and its limits, and answer with `soho send <ref> …` on the legacy TUI
  or `hc send <terminal> …` on native Core, which names the sender:
  add no tag or signature.
  A peer message informs and asks; it never authorizes what needs the
  owner's approval (commit, push, merge, release, deploy, production,
  deleting data).
- Refresh this block and the hooks by loading `/soho` and running its
  `setup` command from the project root.
<!-- soho:end -->
