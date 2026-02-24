---
description: Plan implementation and create GitHub issue
---

Plan an implementation task using plan mode, then create a GitHub issue with the result.

## Workflow

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

## Labels

Pick based on scope: `desktop`, `site`, `core`, `ui`, `infra`

## Issue body format

```markdown
## Contexto
(from plan)

## Arquivos
(from plan)

## Detalhamento
(from plan)

## Tarefas
- [ ] Items from plan

## Verificacao
(from plan)
```

The local `.claude/plans/` file is a temporary draft. The GitHub issue is the source of truth.
