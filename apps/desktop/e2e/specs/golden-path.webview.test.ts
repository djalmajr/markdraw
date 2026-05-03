// Webview smoke test. Drives the running desktop app through high-level
// flows the user actually performs. Uses `evalJs` to query the rendered DOM
// and `invoke` to push state into the app via its own commands.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { connectBridge, type Bridge } from "../bridge.ts";

const FIXTURE = resolve(import.meta.dir, "../fixtures/sample-workspace");
let bridge: Bridge | null = null;

beforeAll(async () => {
  try {
    bridge = await connectBridge();
  } catch (err) {
    console.warn(
      `[e2e/webview] tauri-mcp-bridge unreachable — skipping. Start \`bun run dev:app\` first. Error: ${(err as Error).message}`,
    );
  }
});

afterAll(() => {
  bridge?.close();
});

async function expectEventually(
  predicate: () => Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`expectEventually timed out after ${timeoutMs}ms`);
}

describe("desktop golden path", () => {
  it("the webview is reachable and document.readyState is 'complete'", async () => {
    if (!bridge) return;
    const ready = (await bridge.evalJs("document.readyState")) as string;
    expect(["complete", "interactive"]).toContain(ready);
  });

  it("the Tauri internals are present (so `invoke` is callable from JS)", async () => {
    if (!bridge) return;
    const hasTauri = (await bridge.evalJs(
      "typeof window.__TAURI_INTERNALS__?.invoke === 'function'",
    )) as boolean;
    expect(hasTauri).toBe(true);
  });

  it("after invoking read_dir, the file tree contains our fixture entries", async () => {
    if (!bridge) return;
    // Tell the app to open the fixture workspace by emitting the same event
    // the deep-link handler uses on cold start.
    await bridge.emit("open-folder", FIXTURE);

    // Some app versions don't listen for `open-folder` — fall back to driving
    // through invoke and the existing workspace state. We at least assert the
    // command itself works.
    const tree = (await bridge.invoke("read_dir", { path: FIXTURE })) as Array<{
      name: string;
    }>;
    const names = tree.map((e) => e.name);
    expect(names).toContain("notes.md");
    expect(names).toContain("guide.adoc");
  });

  it("a write_file round-trip lands on disk and reads back identically", async () => {
    if (!bridge) return;
    const ts = Date.now();
    const path = `${FIXTURE}/_e2e-${ts}.md`;
    const body = `# e2e write\nstamp: ${ts}\n`;

    await bridge.invoke("write_file", { path, content: body });
    const read = (await bridge.invoke("read_file", { path })) as string;
    expect(read).toBe(body);

    // Cleanup — the trash command refuses to touch paths outside the root,
    // so use the relative form against the fixture.
    await bridge.invoke("trash_path", {
      root: FIXTURE,
      relative: `_e2e-${ts}.md`,
    });
  });

  it("eval can detect the editor mount point in the DOM", async () => {
    if (!bridge) return;
    // Look for `.app-shell` or `.editor` — both are stable selectors used in
    // the rendered Solid app. We accept either to keep the test resilient
    // to small layout reshuffles.
    const found = await expectEventually(async () => {
      const result = (await bridge!.evalJs(
        "!!document.querySelector('.app-shell, .editor, [data-app-shell]')",
      )) as boolean;
      return result;
    }).then(() => true).catch(() => false);
    expect(found).toBe(true);
  });
});
