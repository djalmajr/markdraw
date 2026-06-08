import { describe, expect, it } from "vitest";
import { buildContextPreamble, type AiContextItem } from "./ai-context.ts";

describe("buildContextPreamble", () => {
  it("returns undefined when there are no items (message unchanged)", () => {
    expect(buildContextPreamble([])).toBeUndefined();
  });

  it("wraps each item in a labelled context block", () => {
    const items: AiContextItem[] = [
      { id: "f1", kind: "file", label: "a.md", content: "hello" },
      { id: "s1", kind: "selection", label: "b.md:1-2", content: "world" },
    ];
    const out = buildContextPreamble(items)!;
    expect(out).toContain('<context kind="file" source="a.md">');
    expect(out).toContain("hello");
    expect(out).toContain('<context kind="selection" source="b.md:1-2">');
    expect(out).toContain("world");
  });

  it("escapes quotes in the source label", () => {
    const out = buildContextPreamble([{ id: "x", kind: "file", label: 'a"b.md', content: "c" }])!;
    expect(out).toContain("a&quot;b.md");
  });
});
