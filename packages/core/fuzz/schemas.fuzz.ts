// Jazzer.js harness for Valibot schema parsing of localStorage payloads.
// Models the real-world attack surface: an attacker (or a buggy older app
// version) writes arbitrary JSON to a known storage key and we must not
// crash on read.
import {
  FavoriteFileSchema,
  PersistedTabSchema,
  PersistedTabSessionSchema,
  RecentFileSchema,
  RecentFolderSchema,
  tryParse,
} from "../src/schemas.ts";

export function fuzz(data: Buffer): void {
  const input = data.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return; // not our concern — JSON.parse rejecting is fine
  }

  // tryParse never throws — that's its whole contract. If any of these throws,
  // we have a real bug.
  tryParse(RecentFileSchema, parsed);
  tryParse(RecentFolderSchema, parsed);
  tryParse(FavoriteFileSchema, parsed);
  tryParse(PersistedTabSchema, parsed);
  tryParse(PersistedTabSessionSchema, parsed);
}
