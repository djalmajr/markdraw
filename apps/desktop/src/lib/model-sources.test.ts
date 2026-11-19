// Colocated tests for the model-source IPC wrappers. `chaos-invoke.ts` is
// mocked (mock.module style, as in pdf-text.test.ts) so no Tauri runtime is
// needed; what is proven is the argument shape sent to Rust and that a
// rejection is normalized without echoing anything unexpected.

import { beforeEach, describe, expect, it, mock } from "bun:test";

const calls: Array<{ cmd: string; args: unknown }> = [];
let next: { ok: unknown } | { err: unknown } = { ok: null };

mock.module("./chaos-invoke.ts", () => ({
  invoke: async (cmd: string, args: unknown) => {
    calls.push({ cmd, args });
    if ("err" in next) throw next.err;
    return next.ok;
  },
}));

const { ModelSourceError, codexModelsCache, httpGetJson, listCliModels } =
  await import("./model-sources.ts");

beforeEach(() => {
  calls.length = 0;
  next = { ok: null };
});

describe("model-sources", () => {
  it("httpGetJson sends only url/headers/timeoutMs under `request`", async () => {
    next = { ok: { status: 200, body: "{}" } };
    const res = await httpGetJson("https://api.x.ai/v1/models", { Authorization: "Bearer k" }, 5000);
    expect(res).toEqual({ status: 200, body: "{}" });
    expect(calls).toEqual([
      {
        cmd: "ai_http_get_json",
        args: {
          request: {
            url: "https://api.x.ai/v1/models",
            headers: { Authorization: "Bearer k" },
            timeoutMs: 5000,
          },
        },
      },
    ]);
  });

  it("listCliModels sends only the provider id", async () => {
    next = { ok: "out" };
    expect(await listCliModels("grok-sub")).toBe("out");
    expect(calls).toEqual([{ cmd: "cli_list_models", args: { provider: "grok-sub" } }]);
  });

  it("codexModelsCache takes no arguments (no path from the webview)", async () => {
    next = { ok: [] };
    await codexModelsCache();
    expect(calls).toEqual([{ cmd: "codex_models_cache", args: {} }]);
  });

  it("turns a typed Rust error into ModelSourceError with its code", async () => {
    next = { err: { code: "too_large", message: "The response is too large." } };
    const e = await httpGetJson("https://x.test/m").catch((x) => x);
    expect(e).toBeInstanceOf(ModelSourceError);
    expect(e.code).toBe("too_large");
    expect(e.message).toBe("The response is too large.");
  });

  it("replaces an untyped rejection with a fixed message instead of echoing it", async () => {
    next = { err: "boom Bearer SECRET-MARKER" };
    const e = await listCliModels("antigravity-sub").catch((x) => x);
    expect(e).toBeInstanceOf(ModelSourceError);
    expect(e.code).toBe("unknown");
    expect(e.message).not.toContain("SECRET-MARKER");
  });
});
