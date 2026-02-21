---
description: Run quality checks (types, lint, tests)
---

Run all quality checks for the current app and report results.

## Steps

1. **Type checking**: Run `bun run lint:types` from the app directory
2. **Linting**: Run `bun run lint:format` from the app directory
3. **Tests**: Run `bun test` from the app directory

## Report format

```
## Quality Check Results

- Types: ✅ 0 errors (or ❌ N errors — list them)
- Lint: ✅ 0 new errors (or ❌ N errors — list new ones only)
- Tests: ✅ N pass, 0 fail (or ❌ N pass, M fail — list failures)
```

Run from the relevant app directory (e.g., `apps/skedly/`). If unclear which app, ask the user.
