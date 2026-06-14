// Deterministic id/seed generators. Determinism matters: golden snapshots must
// be byte-stable, so we never reach for Math.random()/Date.now() — every run of
// the same spec produces the same ids and seeds.

export type IdGen = () => string;
export type SeedGen = () => number;

/** Monotonic element-id generator: `el-1`, `el-2`, … */
export function createIds(prefix = "el"): IdGen {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

/** Monotonic seed generator (Excalidraw's `seed`/`versionNonce` are arbitrary
 *  integers; stable counting keeps snapshots reproducible). */
export function createSeeds(start = 100001): SeedGen {
  let s = start - 1;
  return () => ++s;
}
