import { describe, expect, it } from "bun:test";
import vectors from "./secret-scrub.vectors.json";
import { replaceUnrestoredPlaceholders, restoreSecrets, scrubSecrets } from "./secret-scrub.ts";

// The nonce is random per map, so every assertion goes through this shape
// instead of a hardcoded placeholder string.
const PLACEHOLDER = /\[secret-([a-z0-9]{6,8})-(\d+)\]/;

/** Map entries that are placeholders (excludes the reserved nonce entry). */
function placeholderKeys(map: Map<string, string>): string[] {
  return [...map.keys()].filter((k) => k.startsWith("[secret-"));
}

describe("scrubSecrets", () => {
  it("scrubs vendor-prefixed keys and restores them", () => {
    const input = "use key sk-w7a4JDfGvnZklepfHyg1unjtehDPpY0b in the header";
    const { map, text } = scrubSecrets(input);
    expect(text).toMatch(/^use key \[secret-[a-z0-9]{6,8}-1\] in the header$/);
    expect(restoreSecrets(text, map)).toBe(input);
  });

  it("is deterministic: the same secret reuses its placeholder across calls", () => {
    const { map, text: first } = scrubSecrets("a sk-aaaaaaaaaaaaaaaaaaaa b");
    const { text: second } = scrubSecrets("again sk-aaaaaaaaaaaaaaaaaaaa", map);
    const placeholder = first.match(PLACEHOLDER)?.[0];
    expect(placeholder).toBeDefined();
    expect(second).toContain(placeholder!);
    expect(placeholderKeys(map)).toHaveLength(1);
  });

  it("derives ONE nonce per map, shared by every placeholder", () => {
    const map = new Map<string, string>();
    const { text: first } = scrubSecrets("k1=sk-aaaaaaaaaaaaaaaaaaaa", map);
    const { text: second } = scrubSecrets("k2=ghp_bbbbbbbbbbbbbbbbbbbbbb", map);
    const firstNonce = first.match(PLACEHOLDER)?.[1];
    const secondNonce = second.match(PLACEHOLDER)?.[1];
    expect(firstNonce).toBeDefined();
    expect(secondNonce).toBe(firstNonce!);
  });

  it("numbers distinct secrets independently", () => {
    const { map, text } = scrubSecrets(
      "k1=sk-aaaaaaaaaaaaaaaaaaaa k2=ghp_bbbbbbbbbbbbbbbbbbbbbb",
    );
    expect(placeholderKeys(map)).toHaveLength(2);
    expect(text).toMatch(/\[secret-[a-z0-9]{6,8}-1\]/);
    expect(text).toMatch(/\[secret-[a-z0-9]{6,8}-2\]/);
  });

  it("scrubs Bearer tokens, AWS ids and PEM blocks", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----";
    const input = `Authorization: Bearer abcdef1234567890XYZ\nAKIAABCDEFGHIJKLMNOP\n${pem}`;
    const { map, text } = scrubSecrets(input);
    expect(placeholderKeys(map)).toHaveLength(3);
    expect(text).not.toContain("Bearer abcdef");
    expect(text).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(text).not.toContain("BEGIN PRIVATE KEY");
    expect(restoreSecrets(text, map)).toBe(input);
  });

  it("scrubs explicit secret assignments but leaves ordinary prose alone", () => {
    const { map, text } = scrubSecrets(
      'config: api_key = "abc123def456ghi789" — markdown is a markup language',
    );
    expect(placeholderKeys(map)).toHaveLength(1);
    expect(text).toContain("markdown is a markup language");
    expect(text).not.toContain("abc123def456ghi789");
  });

  it("leaves secret-free text untouched (no map entries, no nonce)", () => {
    const input = "# Notes\nJust regular markdown with code `let x = 1`.";
    const { map, text } = scrubSecrets(input);
    expect(text).toBe(input);
    expect(map.size).toBe(0);
  });
});

describe("restoreSecrets — collision and legacy safety", () => {
  it("a literal [secret-1] in user text survives scrub+restore byte-identical", () => {
    // The nonce exists precisely for this: the session's placeholders are
    // `[secret-<nonce>-N]`, so the unrelated literal can never hit a map key
    // and get rewritten into a REAL secret.
    const map = new Map<string, string>();
    scrubSecrets("real sk-aaaaaaaaaaaaaaaaaaaa", map);
    const doc = "doc quoting a literal [secret-1] token";
    const { text } = scrubSecrets(doc, map);
    expect(text).toBe(doc);
    expect(restoreSecrets(text, map)).toBe(doc);
  });

  it("still restores legacy [secret-N] entries present in the map", () => {
    // Entries are keyed by their full placeholder string, so a map persisted
    // before the nonce format restores exactly the same way.
    const map = new Map([["[secret-1]", "sk-legacyvalue1234567890"]]);
    expect(restoreSecrets("use [secret-1] now", map)).toBe("use sk-legacyvalue1234567890 now");
  });

  it("skips the reserved nonce entry instead of pasting the nonce into text", () => {
    const map = new Map<string, string>();
    const { text } = scrubSecrets("key sk-aaaaaaaaaaaaaaaaaaaa", map);
    const nonce = text.match(PLACEHOLDER)?.[1];
    expect(nonce).toBeDefined();
    const reservedKey = [...map.keys()].find((k) => !k.startsWith("[secret-"));
    expect(reservedKey).toBeDefined();
    expect(restoreSecrets(`mentions ${reservedKey!} here`, map)).toBe(
      `mentions ${reservedKey!} here`,
    );
  });
});

describe("replaceUnrestoredPlaceholders", () => {
  it("labels both legacy and nonce-format placeholders", () => {
    const input = "old [secret-3] and new [secret-ab12cd34-1] here";
    expect(replaceUnrestoredPlaceholders(input, "[expired]")).toBe(
      "old [expired] and new [expired] here",
    );
  });

  it("leaves non-placeholder bracket text alone", () => {
    const input = "[secret-x] [secrets-1] [secret-] plain";
    expect(replaceUnrestoredPlaceholders(input, "[expired]")).toBe(input);
  });

  it("is a no-op on text whose placeholders were all restored", () => {
    const { map, text } = scrubSecrets("key sk-aaaaaaaaaaaaaaaaaaaa");
    const restored = restoreSecrets(text, map);
    expect(replaceUnrestoredPlaceholders(restored, "[expired]")).toBe(restored);
  });
});

describe("shared Rust/TS secret vectors", () => {
  for (const vector of vectors) {
    it(vector.name, () => {
      const { text, map } = scrubSecrets(vector.input);
      expect(text !== vector.input).toBe(vector.masked);
      expect(text.replace(/\[secret-[a-z0-9]{6,8}-\d+\]/g, "[secret]")).toBe(vector.expected);
      expect(restoreSecrets(text, map)).toBe(vector.input);
    });
  }
});
