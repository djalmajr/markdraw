import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { isSupportedKrokiType, renderKroki, SUPPORTED_TYPES } from "./kroki.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("isSupportedKrokiType", () => {
  it("recognizes all members of SUPPORTED_TYPES", () => {
    for (const type of SUPPORTED_TYPES) {
      expect(isSupportedKrokiType(type)).toBe(true);
    }
  });

  it("is case-insensitive (so PlantUML and PLANTUML both match)", () => {
    expect(isSupportedKrokiType("PlantUML")).toBe(true);
    expect(isSupportedKrokiType("PLANTUML")).toBe(true);
  });

  it("returns false for unsupported types", () => {
    expect(isSupportedKrokiType("ascii-art")).toBe(false);
    expect(isSupportedKrokiType("")).toBe(false);
  });
});

describe("renderKroki", () => {
  beforeEach(() => {
    // Each test starts with a fresh fetch mock — but cache is module-level
    // and persists across tests. Tests use unique sources to avoid collisions.
  });

  it("posts the source to the correct kroki endpoint and returns the SVG body", async () => {
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return new Response("<svg>render-1</svg>", { status: 200 });
    }) as typeof fetch;

    const svg = await renderKroki("plantuml", "@startuml\nA -> B\n@enduml");
    expect(svg).toBe("<svg>render-1</svg>");
    expect(calls[0]?.url).toBe("https://kroki.io/plantuml/svg");
    expect(calls[0]?.body).toContain("@startuml");
  });

  it("caches identical (type, source) pairs and skips network on second call", async () => {
    let networkCalls = 0;
    globalThis.fetch = mock(async () => {
      networkCalls += 1;
      return new Response("<svg>render-2</svg>", { status: 200 });
    }) as typeof fetch;

    await renderKroki("graphviz", "digraph cache_check {}");
    await renderKroki("graphviz", "digraph cache_check {}");

    expect(networkCalls).toBe(1);
  });

  it("throws an error containing status code on non-OK response", async () => {
    globalThis.fetch = mock(
      async () => new Response("invalid syntax", { status: 400 }),
    ) as typeof fetch;

    await expect(renderKroki("mermaid", "graph TD; broken<<<")).rejects.toThrow(
      /Kroki error \(400\): invalid syntax/,
    );
  });
});
