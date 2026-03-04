---
description: Plan implementation and/or create GitHub issue
---

Use this command for:

- planning an implementation task in plan mode, and/or
- creating a GitHub issue in `djalmajr/asciimark`.

## Labels

| Label | When to use |
|-------|-------------|
| `desktop` | Desktop app (Tauri) |
| `site` | Public site |
| `core` | Core package |
| `ui` | UI components |
| `infra` | CI/CD, build, deploy |

Always pick at least one scope label from the table above.

## Workflow (Plan -> Issue)

1. **Enter plan mode** — explore the codebase, design the approach
2. **Write plan** to `.claude/plans/` (local draft, gitignored)
3. **Exit plan mode** — present plan for user approval
4. **After approval** — create a GitHub issue with the plan content:

```bash
gh issue create --repo djalmajr/asciimark \
  --title "<plan title>" \
  --body "<plan content>" \
  --label "<appropriate label>"
```

5. **Report** the issue URL to the user
6. **Implement** — reference the issue number when relevant

## Workflow (Issue-only)

Use this when the user asks to create an issue without asking for full plan mode.

1. Ask what the issue is about (if not provided)
2. Choose the appropriate scope label(s)
3. Create the issue:

```bash
gh issue create --repo djalmajr/asciimark \
  --title "<title>" \
  --body "<body>" \
  --label "<label>"
```

4. Report the issue URL to the user

## Issue body format

```markdown
## Context
(from plan)

## Files
(from plan)

## Details
(from plan)

## Tasks
- [ ] Items from plan

## Verification
(from plan)
```

For simple issues, a concise description is acceptable and `Details` can be omitted.

The local `.claude/plans/` file is a temporary draft. The GitHub issue is the source of truth.
