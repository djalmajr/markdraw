---
description: Create a GitHub issue with label
---

Create a GitHub issue in `zommehq/platform` and apply the appropriate label.

## Labels

| Label | When to use |
|-------|-------------|
| `skedly` | Skedly app (scheduling) |
| `kashes` | Kashes app (finances) |
| `identity` | Identity Service (auth) |
| `infra` | Infrastructure and operations |
| `ui` | UI components (@zomme/ui) |

## Steps

1. Ask the user what the issue is about (if not provided as argument)
2. Determine the appropriate label from the table above
3. Create the issue:

```bash
gh issue create --repo zommehq/platform \
  --title "<title>" \
  --body "<body>" \
  --label "<label>"
```

4. Report the issue URL back to the user

## Body format for plan issues

```markdown
## Contexto
(why)

## Arquivos
(create / modify / remove)

## Tarefas
- [ ] Item 1
- [ ] Item 2

## Verificacao
(how to test)
```

For simple issues, a concise description is fine — no need for the full plan format.
