import { describe, expect, it } from "vitest";
import { MermaidCache } from "./mermaid-cache.ts";

describe("MermaidCache", () => {
  it("evicts the oldest entry at capacity", () => {
    const cache = new MermaidCache(2);
    cache.set("light:a", "a");
    cache.set("dark:a", "b");
    expect(cache.get("light:a")).toBe("a");
    cache.set("light:b", "c");
    expect(cache.get("light:a")).toBeUndefined();
    expect(cache.get("dark:a")).toBe("b");
    expect(cache.get("light:b")).toBe("c");
  });
});
