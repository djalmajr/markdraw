import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { isSupportedKrokiType, renderKroki, setKrokiRequestTimeoutMs, SUPPORTED_TYPES } from "./kroki.ts";

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

  it("limits concurrent cache misses to four, deduplicates in-flight work and retries failures", async () => {
    let active = 0;
    let maximum = 0;
    const calls: string[] = [];
    const releases: Array<() => void> = [];
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const source = String(init?.body);
      calls.push(source);
      maximum = Math.max(maximum, ++active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return new Response(source === "limit-failure" ? "bad" : `<svg>${source}</svg>`, {
        status: source === "limit-failure" ? 500 : 200,
      });
    }) as typeof fetch;

    const requests = [0, 1, 2, 3, 4, 5].map((i) => renderKroki("plantuml", `limit-${i}`));
    const duplicate = renderKroki("plantuml", "limit-0");
    await Promise.resolve();
    expect(calls).toEqual(["limit-0", "limit-1", "limit-2", "limit-3"]);
    expect(maximum).toBe(4);
    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toContain("limit-4");
    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toContain("limit-5");
    for (const release of releases.splice(0)) release();
    expect(await duplicate).toBe(await requests[0]);
    await Promise.all(requests);
    expect(calls.filter((s) => s === "limit-0")).toHaveLength(1);
    await renderKroki("plantuml", "limit-0");
    expect(calls).toHaveLength(6);

    let failures = 0;
    globalThis.fetch = mock(async () => {
      failures++;
      return new Response("bad", { status: 500 });
    }) as typeof fetch;
    await expect(renderKroki("plantuml", "limit-failure")).rejects.toThrow("Kroki error (500)");
    await expect(renderKroki("plantuml", "limit-failure")).rejects.toThrow("Kroki error (500)");
    expect(failures).toBe(2);
  });

  it("skips abandoned queued work but keeps work shared with an active consumer", async () => {
    const calls: string[] = [];
    const releases: Array<() => void> = [];
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const source = String(init?.body);
      calls.push(source);
      if (source.startsWith("cancel-block-")) {
        await new Promise<void>((resolve) => releases.push(resolve));
      }
      return new Response(`<svg>${source}</svg>`);
    }) as typeof fetch;

    const old = new AbortController();
    const blockers = Array.from({ length: 4 }, (_, i) => renderKroki("plantuml", `cancel-block-${i}`));
    const abandoned = renderKroki("plantuml", "cancel-abandoned", old.signal);
    const rejected = abandoned.then(() => "resolved", (error: Error) => error.name);
    const sharedOld = renderKroki("plantuml", "cancel-shared", old.signal).catch((error: Error) => error.name);
    const sharedNew = renderKroki("plantuml", "cancel-shared");
    const current = renderKroki("plantuml", "cancel-current");
    try {
      await Promise.resolve();
      expect(calls).toEqual(["cancel-block-0", "cancel-block-1", "cancel-block-2", "cancel-block-3"]);
      old.abort();
      for (const release of releases) release();
      await Promise.all(blockers);
      expect(await rejected).toBe("AbortError");
      expect(await sharedOld).toBe("AbortError");
      expect(await sharedNew).toContain("cancel-shared");
      await current;
      expect(calls.slice(4)).toEqual(["cancel-shared", "cancel-current"]);
      expect(await renderKroki("plantuml", "cancel-abandoned")).toContain("cancel-abandoned");
      expect(calls.at(-1)).toBe("cancel-abandoned");
    } finally {
      for (const release of releases) release();
    }
  });

  it("aborts four abandoned POSTs and starts the current document without network replies", async () => {
    const old = new AbortController();
    const posts: string[] = [];
    const aborted: string[] = [];
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const source = String(init?.body);
      posts.push(source);
      if (source.startsWith("held-old-")) {
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted.push(source);
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      }
      return new Response(`<svg>${source}</svg>`);
    }) as typeof fetch;
    const requests = Array.from({ length: 4 }, (_, i) =>
      renderKroki("plantuml", `held-old-${i}`, old.signal).catch((error: Error) => error.name));
    try {
      await Promise.resolve();
      expect(posts).toEqual(["held-old-0", "held-old-1", "held-old-2", "held-old-3"]);
      old.abort();
      const current = await renderKroki("plantuml", "held-current");
      expect(current).toBe("<svg>held-current</svg>");
      expect(aborted).toEqual(["held-old-0", "held-old-1", "held-old-2", "held-old-3"]);
      expect(await Promise.all(requests)).toEqual(Array(4).fill("AbortError"));
      expect(posts).toEqual(["held-old-0", "held-old-1", "held-old-2", "held-old-3", "held-current"]);
    } finally { old.abort(); }
  });

  it("keeps a shared POST alive until the last consumer leaves, then retries without caching abort", async () => {
    const first = new AbortController();
    const second = new AbortController();
    let postSignal: AbortSignal | null | undefined;
    let respond!: (value: Response) => void;
    let calls = 0;
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      if (calls > 1) return new Response("<svg>retry</svg>");
      postSignal = init?.signal;
      return await new Promise<Response>((resolve, reject) => {
        respond = resolve;
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as typeof fetch;
    const a = renderKroki("plantuml", "held-shared", first.signal).catch((error: Error) => error.name);
    const b = renderKroki("plantuml", "held-shared", second.signal).catch((error: Error) => error.name);
    try {
      await Promise.resolve();
      expect(calls).toBe(1);
      first.abort();
      expect(await a).toBe("AbortError");
      expect(postSignal?.aborted).toBe(false);
      second.abort();
      expect(await b).toBe("AbortError");
      expect(postSignal?.aborted).toBe(true);
      expect(await renderKroki("plantuml", "held-shared")).toBe("<svg>retry</svg>");
      expect(calls).toBe(2);
    } finally {
      first.abort();
      second.abort();
      respond?.(new Response("<svg>cleanup</svg>"));
    }
  });

  it("aborts while reading the response body and does not cache a late body", async () => {
    const consumer = new AbortController();
    let finishBody!: (body: string) => void;
    let postSignal: AbortSignal | null | undefined;
    let calls = 0;
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      postSignal = init?.signal;
      if (calls > 1) return new Response("<svg>fresh</svg>");
      return { ok: true, text: () => new Promise<string>((resolve) => { finishBody = resolve; }) } as Response;
    }) as typeof fetch;
    const pending = renderKroki("plantuml", "held-body", consumer.signal).catch((error: Error) => error.name);
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      consumer.abort();
      expect(postSignal?.aborted).toBe(true);
      expect(await pending).toBe("AbortError");
      finishBody("<svg>stale</svg>");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(await renderKroki("plantuml", "held-body")).toBe("<svg>fresh</svg>");
      expect(calls).toBe(2);
    } finally { consumer.abort(); finishBody?.("<svg>cleanup</svg>"); }
  });

  it("throws an error containing status code on non-OK response", async () => {
    globalThis.fetch = mock(
      async () => new Response("invalid syntax", { status: 400 }),
    ) as typeof fetch;

    await expect(renderKroki("mermaid", "graph TD; broken<<<")).rejects.toThrow(
      /Kroki error \(400\): invalid syntax/,
    );
  });

  it("gives the slot back when a POST stalls past the timeout", async () => {
    setKrokiRequestTimeoutMs(40);
    try {
      let started = 0;
      globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
        started++;
        const body = String(init?.body ?? "");
        if (body.startsWith("stall")) {
          // Never answers on its own: only the abort ends it.
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          });
        }
        return new Response(`<svg>${body}</svg>`, { status: 200 });
      }) as unknown as typeof fetch;

      const stalled = [0, 1, 2, 3].map((i) =>
        renderKroki("plantuml", `stall-timeout-${i}-${Date.now()}`).then(
          () => "resolved",
          (e: unknown) => (e instanceof DOMException ? e.name : String(e)),
        ),
      );
      const next = renderKroki("plantuml", `after-stall-${Date.now()}`);

      expect(await Promise.all(stalled)).toEqual(["TimeoutError", "TimeoutError", "TimeoutError", "TimeoutError"]);
      expect(await next).toContain("<svg>after-stall-");
      expect(started).toBe(5);
    } finally {
      setKrokiRequestTimeoutMs(20_000);
    }
  });
});
