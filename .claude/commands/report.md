---
description: Generate post-implementation impact report
---

Generate an implementation impact report for the changes made in this session.

## Format

```markdown
## Implementation Impact

### Files Changed
- `path/to/file.ts` — Brief description

### Breaking Changes
- No breaking changes (or list them with migration path)

### Tests
- Run `bun test` and report: X pass, Y fail

### Type Checking
- Run `bun run lint:types` and report result

### Linting
- Run `bun run lint:format` and report result

### Database
- No migrations needed (or: migration applied)

### Dependencies
- No new dependencies (or: list packages)

### Next Steps
- [ ] Any follow-up items
```

Run the actual commands (`bun test`, `bun run lint:types`) and report real results. Never guess.
