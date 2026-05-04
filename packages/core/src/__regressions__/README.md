# Regression replay

When `fast-check` finds a counterexample (a failing input), it prints
the seed and the shrunk minimal example. We capture those here as
**permanent regression tests**: every replay is a single explicit case
that was once a real bug. They run in milliseconds and never go away
even if the property test that found them is later removed.

## How to use

When a `fc.assert(fc.property(...))` fails, fast-check prints something
like:

```
Counterexample: [{...}]
Shrunk 5 time(s)
Got error: ...
```

To freeze that case as a regression test:

1. Copy the counterexample.
2. Add a new entry to `replay.test.ts` describing the bug, the date,
   and the property test that found it.
3. Pass the counterexample as `examples: [...]` to a fast-check property
   that runs in `numRuns: 1` mode, so the replay always exercises that
   exact input first.

This way the property test keeps exploring random inputs (and may find
new failures), while the regression test pins the specific one that
once broke.

## Layout

- `replay.test.ts` — pinned counterexamples
- This README

There are no captured replays yet — the property tests have all been
green so far. The first failure to come back here is the moment this
directory starts paying off.
