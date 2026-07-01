/**
 * djb2 string hash → unsigned 32-bit → base-36 string.
 *
 * Cheap, stable, synchronous, NON-cryptographic. Used for content versions,
 * connection/rule/skill ids, and advisor-note keys. Callers add their own
 * prefix (`v…`, `advisor-…`, `skill:…`, `discovered:…`); this returns only the
 * bare base-36 digest so every call site stays byte-identical to the
 * hand-rolled loops it replaces.
 */
export function djb2(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
