/**
 * Formats a byte count as a human-readable string using SI-style units
 * (MB / GB), rounded to one decimal place. Stops at KB for sub-MB
 * values so the progress hint never shows a fraction like "0.0 MB" on
 * tiny downloads or a delta that hasn't moved the needle yet.
 *
 * Mutation-survival contracts (locked in by `format-bytes.test.ts`):
 *   - Swapping the 1024 base for 1000 fails the boundary tests (1 KB,
 *     1 MB, 1 GB), since the user-facing convention in the updater
 *     uses binary prefixes despite the SI labels.
 *   - Dropping the `bytes < 0` guard makes "-100 B" render as a positive
 *     value and fails the negative-input assertion.
 *   - Removing the `Number.isFinite` guard would let `Infinity` render
 *     as "Infinity GB" and fail the sentinel test.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}
