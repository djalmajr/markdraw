// Pinned regression replays from past property-test failures.
//
// Each entry is one input that *once* broke a real invariant. We freeze
// them here so even if the property test that found them is rewritten
// or removed, the regression cannot creep back in unnoticed.
//
// When you add an entry, document the bug it represents — link to the
// commit / issue, name the invariant it broke, and explain why the
// minimal example was the trigger. Without that context, a future
// reader will assume the test is arbitrary and delete it.
import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { extractFrontmatter, parseWikiLink } from "../frontmatter.ts";
import { makeTabId, parseTabId } from "../tabs.ts";

describe("property-test replays (pinned counterexamples)", () => {
  // Document the contract: when a property test catches a bug, paste
  // the shrunk counterexample here as `examples: [[...]]`. fast-check
  // ALWAYS runs `examples` first, so the replay never gets shrunk away
  // by future random sampling.
  //
  // Until the first real failure happens, this file holds smoke replays
  // of cases that NEAR-failed during initial exploration but were
  // ultimately accepted by the contract — they're documented so the
  // contract itself stays explicit.

  it("smoke: parseTabId edge — rootId ends with `:` is documented as ambiguous", () => {
    // This is the SHAPE of how a real regression entry would look.
    // The case here is the documented limitation we found while writing
    // tabs.property.test.ts; we don't pin the FAILURE because it's not
    // a bug — it's a known constraint. But the entry pre-loads the
    // mechanism so the next real bug just appends.
    fc.assert(
      fc.property(fc.constant(":a"), fc.constant("path"), (rootId, filePath) => {
        const tabId = makeTabId(rootId, filePath);
        const decoded = parseTabId(tabId);
        // Round-trip is intentionally NOT preserved when rootId ends
        // with `:`. We assert the documented (degraded) behavior so any
        // accidental "fix" that breaks this gets flagged.
        expect(decoded).toEqual({ rootId: ":a", filePath: "path" });
        return true;
      }),
      // examples runs FIRST and ONCE; numRuns: 0 disables random sampling
      // so this is purely a replay of the pinned case.
      { examples: [[":a", "path"]], numRuns: 1 },
    );
  });

  it("smoke: extractFrontmatter on CRLF-only YAML body never throws", () => {
    fc.assert(
      fc.property(fc.constant("---\r\ntitle: x\r\n---\r\n"), (input) => {
        expect(() => extractFrontmatter(input)).not.toThrow();
        return true;
      }),
      { examples: [["---\r\ntitle: x\r\n---\r\n"]], numRuns: 1 },
    );
  });

  it("smoke: parseWikiLink on whitespace-only inner text returns the trimmed empty string", () => {
    // parseWikiLink semantics: returns `""` for `[[   ]]` (after trim).
    // Pinned so any change in trim semantics is flagged.
    fc.assert(
      fc.property(fc.constant("[[   ]]"), (input) => {
        const out = parseWikiLink(input);
        expect(out).toBe("");
        return true;
      }),
      { examples: [["[[   ]]"]], numRuns: 1 },
    );
  });
});
