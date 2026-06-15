// Guards the workspace-indexing card copy: every locale must define all the
// keys, and the user-facing descriptions must stay free of engineering jargon
// (the product requirement is plain language — no BM25/embeddings/vectors/
// rerank/model-downloads). If this fails, simplify the wording, don't relax it.

import { describe, expect, it } from "bun:test";

const LOCALES = ["en", "pt-BR", "es"] as const;

const KEYS = [
  "off_title",
  "off_desc",
  "lite_title",
  "lite_desc",
  "full_title",
  "full_desc",
  "default_badge",
  "embedding_label",
  "full_requires_embed",
].map((k) => `settings_indexing_${k}`);

// Technical terms the cards must never expose to end users (en/pt/es variants).
const JARGON = /\b(bm25|embeddings?|vectors?|vetor\w*|vectorial\w*|rerank\w*|downloads?|descargas?)\b/i;

describe("workspace indexing card copy", () => {
  for (const locale of LOCALES) {
    it(`${locale}: defines every key and keeps descriptions jargon-free`, async () => {
      const msgs = (await Bun.file(new URL(`./messages/${locale}.json`, import.meta.url)).json()) as Record<
        string,
        string
      >;
      for (const key of KEYS) {
        expect(typeof msgs[key], `${locale} missing ${key}`).toBe("string");
      }
      for (const key of KEYS.filter((k) => k.endsWith("_desc"))) {
        expect(JARGON.test(msgs[key] ?? ""), `${locale} ${key} leaks jargon: "${msgs[key]}"`).toBe(false);
      }
    });
  }
});
