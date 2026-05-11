import { describe, expect, it } from "bun:test";
import * as v from "valibot";
import {
  FontPrefsSchema,
  PartialFontPrefsSchema,
  RecentCommandIdsSchema,
  formatValibotError,
  safeJsonParse,
  tryParse,
} from "./schemas.ts";

describe("safeJsonParse", () => {
  it("returns the validated value for well-formed input that matches the schema", () => {
    const result = safeJsonParse(
      JSON.stringify({ fontSize: 18, fontFamily: "serif" }),
      FontPrefsSchema,
    );
    expect(result).toEqual({ fontSize: 18, fontFamily: "serif" });
  });

  it("returns null for malformed JSON", () => {
    // Mutation captured: removing the try/catch around JSON.parse
    // would propagate the SyntaxError up to every storage read.
    expect(safeJsonParse("{not json", FontPrefsSchema)).toBeNull();
  });

  it("returns null when the parsed value fails the schema (shape mismatch)", () => {
    // Mutation captured: skipping the tryParse call lets the caller
    // receive `{ foo: 1 }` typed as FontPrefs and the downstream
    // setStyle call breaks at runtime.
    expect(safeJsonParse(JSON.stringify({ foo: 1 }), FontPrefsSchema)).toBeNull();
  });

  it("returns null when raw is null (no key in storage)", () => {
    // Regression guard: the helper takes the result of
    // `localStorage.getItem` which is `string | null`.
    expect(safeJsonParse(null, FontPrefsSchema)).toBeNull();
  });

  it("PartialFontPrefsSchema accepts a partial object so legacy storage upgrades", () => {
    // Round-trip from the FontPrefs migration path: an older client
    // persisted only `fontSize`; the new client must still upgrade
    // it cleanly by merging with the canonical defaults.
    const result = safeJsonParse(JSON.stringify({ fontSize: 18 }), PartialFontPrefsSchema);
    expect(result).toEqual({ fontSize: 18 });
  });

  it("RecentCommandIdsSchema rejects an array with non-string entries", () => {
    // Domain rule: command ids that aren't strings cannot be
    // redispatched — schema rejects them at read time so the palette
    // never lands an "[object Object]" entry in front of the user.
    expect(safeJsonParse(JSON.stringify([1, "ok"]), RecentCommandIdsSchema)).toBeNull();
  });
});

describe("formatValibotError", () => {
  it("returns the source error message for non-ValiError inputs", () => {
    expect(formatValibotError(new Error("oops"))).toBe("oops");
    expect(formatValibotError("plain string")).toBe("plain string");
  });

  it("renders the first issue's field path when the schema is an object", () => {
    // Mutation captured: dropping the `path.map` join would lose
    // the field name and the user would see "input invalid type"
    // for every shape mismatch.
    try {
      v.parse(FontPrefsSchema, { fontSize: "not a number", fontFamily: "ok" });
      throw new Error("should have thrown");
    } catch (e) {
      const msg = formatValibotError(e);
      expect(msg).toContain("fontSize");
    }
  });

  it("falls back to 'input' when no path is available (root-level mismatch)", () => {
    try {
      v.parse(FontPrefsSchema, 42);
      throw new Error("should have thrown");
    } catch (e) {
      const msg = formatValibotError(e);
      expect(msg.startsWith("input ")).toBe(true);
    }
  });

  it("returns 'Schema validation failed' for a ValiError with no issues (defensive)", () => {
    // Constructed defensively because ValiError always carries at
    // least one issue in practice; guarding the empty case keeps the
    // helper total.
    const fake = Object.create(v.ValiError.prototype) as v.ValiError<
      typeof FontPrefsSchema
    >;
    (fake as { issues?: unknown }).issues = [];
    expect(formatValibotError(fake)).toBe("Schema validation failed");
  });
});

describe("tryParse (regression guard)", () => {
  it("returns the validated value on success and null on failure", () => {
    expect(tryParse(FontPrefsSchema, { fontSize: 15, fontFamily: "sans" })).toEqual({
      fontSize: 15,
      fontFamily: "sans",
    });
    expect(tryParse(FontPrefsSchema, { fontSize: "no" })).toBeNull();
  });
});
