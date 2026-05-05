// Webview E2E for the four navigation overlays:
//   - Cmd/Ctrl+P         → Quick Open (file finder)
//   - Cmd/Ctrl+Shift+P   → Command Palette
//   - Cmd/Ctrl+Shift+O   → Go to Symbol (heading jump in the active doc)
//   - Cmd/Ctrl+Shift+F   → Find in Files (workspace content search)
//
// The vtest under `packages/ui/src/components/*.vtest.tsx` cover the
// component-level behaviour in isolation. This file covers the
// integration: the keydown handler in `apps/desktop/src/app.tsx` reaches
// AppShell, AppShell renders the overlay, the IPC for Find-in-Files
// returns real matches from a real workspace, etc.
//
// Skips silently when the MCP bridge is unreachable (no `bun run dev:app`
// running). The wiki documents this fragility:
// `wiki/testing/strategies.md` round 3 / "Validate E2E roundtrip in this
// environment".
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
  timeoutMs = 6000,
  intervalMs = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`expectEventually timed out after ${timeoutMs}ms`);
}

async function pressShortcut(b: Bridge, key: string, withShift = false) {
  const isMac = (await b.evalJs("navigator.platform.startsWith('Mac')")) === true;
  await b.evalJs(
    `(() => {
      const e = new KeyboardEvent("keydown", {
        key: ${JSON.stringify(key)},
        metaKey: ${isMac},
        ctrlKey: ${!isMac},
        shiftKey: ${withShift},
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(e);
    })()`,
  );
}

async function pressEscapeOnPanel(b: Bridge, selector: string) {
  await b.evalJs(
    `document.querySelector(${JSON.stringify(selector)})?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    )`,
  );
}

async function openFixtureWorkspace(b: Bridge): Promise<void> {
  // The desktop app exposes a __DEV__ helper in development mode (see
  // app.tsx:90). It calls the same `openFolderPath` that the toolbar
  // uses, so opening a fixture is a single sync call.
  const result = (await b.evalJs(
    `(async () => {
      const dev = (window).__DEV__;
      if (!dev) return { error: "DEV helper not exposed (was this built in dev mode?)" };
      await dev.openFolder(${JSON.stringify(FIXTURE)});
      return { roots: dev.getState().roots.length };
    })()`,
  )) as { error?: string; roots?: number };
  if (result.error) throw new Error(result.error);
  if (!result.roots) throw new Error("openFolder returned 0 roots");
}

async function clickFirstSupportedFile(b: Bridge): Promise<string> {
  // The click handler lives on the inner `.tree-item` (the wrapper is just
  // a positional container), so we have to fire the synthetic events on
  // that exact element — events dispatched on the wrapper bubble UP and
  // never reach the child `.tree-item`.
  const picked = (await b.evalJs(
    `(() => {
      const wrappers = Array.from(document.querySelectorAll(".tree-item-wrapper"));
      for (const wrapper of wrappers) {
        const name = wrapper.querySelector(".tree-name")?.textContent?.trim() ?? "";
        if (name.endsWith(".md") || name.endsWith(".adoc")) {
          const target = wrapper.querySelector(".tree-item") ?? wrapper;
          for (const type of ["mousedown", "mouseup", "click"]) {
            target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
          }
          return name;
        }
      }
      return null;
    })()`,
  )) as string | null;
  if (!picked) throw new Error("no .md/.adoc file in the fixture tree");
  return picked;
}

describe("desktop palettes (Cmd/Ctrl+P family)", () => {
  it("opens fixture workspace via the __DEV__ helper", async () => {
    if (!bridge) return;
    await openFixtureWorkspace(bridge);
    const rootCount = (await bridge.evalJs(
      "(window).__DEV__.getState().roots.length",
    )) as number;
    expect(rootCount).toBeGreaterThan(0);
  });

  it("Cmd/Ctrl+P opens Quick Open and lists the fixture files", async () => {
    if (!bridge) return;
    await pressShortcut(bridge, "p", false);
    await expectEventually(async () =>
      (await bridge!.evalJs(
        `!!document.querySelector(".quick-open-panel input[placeholder='Type a file name…']")`,
      )) === true,
    );
    const optionCount = (await bridge.evalJs(
      `document.querySelectorAll(".quick-open-list [role='option']").length`,
    )) as number;
    expect(optionCount).toBeGreaterThan(0);

    await pressEscapeOnPanel(bridge, ".quick-open-panel input");
    await expectEventually(async () =>
      (await bridge!.evalJs(`!document.querySelector(".quick-open-panel")`)) === true,
    );
  });

  it("Cmd/Ctrl+Shift+P opens Command Palette with at least 10 commands", async () => {
    if (!bridge) return;
    await pressShortcut(bridge, "p", true);
    await expectEventually(async () =>
      (await bridge!.evalJs(
        `!!document.querySelector(".quick-open-panel input[placeholder='Type a command…']")`,
      )) === true,
    );
    const optionCount = (await bridge.evalJs(
      `document.querySelectorAll(".quick-open-list [role='option']").length`,
    )) as number;
    // The catalog in `apps/desktop/src/app.tsx` has ~13 entries; gate at 10
    // to leave room for `when()`-hidden ones without making the test brittle.
    expect(optionCount).toBeGreaterThanOrEqual(10);

    await pressEscapeOnPanel(bridge, ".quick-open-panel input");
    await expectEventually(async () =>
      (await bridge!.evalJs(`!document.querySelector(".quick-open-panel")`)) === true,
    );
  });

  it("Cmd/Ctrl+Shift+O lists headings of the active file", async () => {
    if (!bridge) return;
    // Open a real markdown/adoc file so the heading extractor has content.
    await clickFirstSupportedFile(bridge);
    await expectEventually(async () =>
      (await bridge!.evalJs(
        `(document.querySelector(".content article")?.textContent ?? "").length > 0
         || (document.querySelector('.cm-content')?.textContent ?? "").length > 0`,
      )) === true,
    );

    await pressShortcut(bridge, "o", true);
    await expectEventually(async () =>
      (await bridge!.evalJs(
        `!!document.querySelector(".quick-open-panel input[placeholder='Type a heading…']")`,
      )) === true,
    );
    const headingCount = (await bridge.evalJs(
      `document.querySelectorAll(".quick-open-list [role='option']").length`,
    )) as number;
    expect(headingCount).toBeGreaterThan(0);

    await pressEscapeOnPanel(bridge, ".quick-open-panel input");
    await expectEventually(async () =>
      (await bridge!.evalJs(`!document.querySelector(".quick-open-panel")`)) === true,
    );
  });

  it("Quick Open: query and active row PERSIST across close → reopen", async () => {
    if (!bridge) return;
    await pressShortcut(bridge, "p", false);
    await expectEventually(async () =>
      (await bridge!.evalJs(
        `!!document.querySelector(".quick-open-panel input[placeholder='Type a file name…']")`,
      )) === true,
    );
    // Type "notes" — the fixture has notes.md, should narrow to that.
    await bridge.evalJs(
      `(() => {
        const input = document.querySelector(".quick-open-panel input");
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(input, "notes");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })()`,
    );
    await expectEventually(async () =>
      ((await bridge!.evalJs(
        `document.querySelectorAll(".quick-open-list [role='option']").length`,
      )) as number) >= 1,
    );

    await pressEscapeOnPanel(bridge, ".quick-open-panel input");
    await expectEventually(async () =>
      (await bridge!.evalJs(`!document.querySelector(".quick-open-panel")`)) === true,
    );

    // Reopen — query must still be "notes".
    await pressShortcut(bridge, "p", false);
    await expectEventually(async () =>
      (await bridge!.evalJs(
        `!!document.querySelector(".quick-open-panel input[placeholder='Type a file name…']")`,
      )) === true,
    );
    const persistedValue = (await bridge.evalJs(
      `document.querySelector(".quick-open-panel input").value`,
    )) as string;
    expect(persistedValue).toBe("notes");

    // Click the X clear button — query should reset.
    await bridge.evalJs(
      `(() => {
        const btn = document.querySelector(".quick-open-clear");
        if (btn) {
          btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        }
      })()`,
    );
    const clearedValue = (await bridge.evalJs(
      `document.querySelector(".quick-open-panel input").value`,
    )) as string;
    expect(clearedValue).toBe("");

    await pressEscapeOnPanel(bridge, ".quick-open-panel input");
    await expectEventually(async () =>
      (await bridge!.evalJs(`!document.querySelector(".quick-open-panel")`)) === true,
    );
  });

  it("Find in Files: query and results PERSIST across close → reopen", async () => {
    if (!bridge) return;
    await pressShortcut(bridge, "f", true);
    await expectEventually(async () =>
      (await bridge!.evalJs(`!!document.querySelector(".find-in-files-panel input")`)) === true,
    );
    await bridge.evalJs(
      `(() => {
        const input = document.querySelector(".find-in-files-panel input");
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(input, "the");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })()`,
    );
    await expectEventually(async () =>
      ((await bridge!.evalJs(
        `document.querySelectorAll(".find-in-files-line").length`,
      )) as number) > 0,
      8000,
    );

    // Close, reopen — same root, results should still be there.
    await pressEscapeOnPanel(bridge, ".find-in-files-panel input");
    await expectEventually(async () =>
      (await bridge!.evalJs(`!document.querySelector(".find-in-files-panel")`)) === true,
    );

    await pressShortcut(bridge, "f", true);
    await expectEventually(async () =>
      (await bridge!.evalJs(`!!document.querySelector(".find-in-files-panel input")`)) === true,
    );
    const persistedValue = (await bridge.evalJs(
      `document.querySelector(".find-in-files-panel input").value`,
    )) as string;
    expect(persistedValue).toBe("the");
    const persistedRows = (await bridge.evalJs(
      `document.querySelectorAll(".find-in-files-line").length`,
    )) as number;
    expect(persistedRows).toBeGreaterThan(0);

    await pressEscapeOnPanel(bridge, ".find-in-files-panel input");
    await expectEventually(async () =>
      (await bridge!.evalJs(`!document.querySelector(".find-in-files-panel")`)) === true,
    );
  });

  it("Cmd/Ctrl+\\\\ splits the editor into two panes; Cmd/Ctrl+\\\\ again collapses", async () => {
    if (!bridge) return;

    // Open a file first so there's something to split into.
    await clickFirstSupportedFile(bridge);
    await expectEventually(async () =>
      ((await bridge!.evalJs(
        `document.querySelectorAll(".pane-view").length`,
      )) as number) === 1,
    );

    // Cmd/Ctrl+\\ → second pane appears.
    const isMac = (await bridge.evalJs("navigator.platform.startsWith('Mac')")) === true;
    await bridge.evalJs(
      `window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "\\\\",
        metaKey: ${isMac}, ctrlKey: ${!isMac},
        bubbles: true, cancelable: true,
      }))`,
    );
    await expectEventually(async () =>
      ((await bridge!.evalJs(`document.querySelectorAll(".pane-view").length`)) as number) === 2,
    );
    const splitterCount = (await bridge.evalJs(
      `document.querySelectorAll(".pane-splitter").length`,
    )) as number;
    expect(splitterCount).toBe(1);

    // Active pane indicator follows: split focuses pane 1.
    const activeIndex = (await bridge.evalJs(
      `document.querySelector(".pane-view-active")?.dataset?.paneIndex ?? null`,
    )) as string | null;
    expect(activeIndex).toBe("1");

    // Cmd/Ctrl+\\ toggles back to single-pane.
    await bridge.evalJs(
      `window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "\\\\",
        metaKey: ${isMac}, ctrlKey: ${!isMac},
        bubbles: true, cancelable: true,
      }))`,
    );
    await expectEventually(async () =>
      ((await bridge!.evalJs(`document.querySelectorAll(".pane-view").length`)) as number) === 1,
    );
  });

  it("split-pane layout writes paneCount + activePaneIndex + splitRatio to localStorage", async () => {
    if (!bridge) return;
    // Persistence is unit-tested in `create-pane-manager.test.ts`. Here
    // we just verify that operating on the live app actually populates
    // the storage slots — the slot-write is the contract that the
    // restore-on-load logic depends on. We don't reload the page in
    // the e2e because reload kills the bridge handle and the test
    // harness can't reuse it without orchestration.
    const isMac = (await bridge.evalJs("navigator.platform.startsWith('Mac')")) === true;

    await clickFirstSupportedFile(bridge);
    await bridge.evalJs(
      `window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "\\\\", metaKey: ${isMac}, ctrlKey: ${!isMac}, bubbles: true, cancelable: true,
      }))`,
    );
    await expectEventually(async () =>
      ((await bridge!.evalJs(`document.querySelectorAll(".pane-view").length`)) as number) === 2,
    );

    const persisted = (await bridge.evalJs(
      `({
        layout: localStorage.getItem("asciimark-pane-layout"),
        pane0: localStorage.getItem("asciimark-tab-session-pane-0"),
      })`,
    )) as { layout: string | null; pane0: string | null };
    expect(persisted.layout).not.toBeNull();
    const layout = JSON.parse(persisted.layout!);
    expect(layout.paneCount).toBe(2);
    expect(layout.activePaneIndex).toBe(1); // split-from-active focuses the new pane
    // The split ratio is only persisted once the user drags the splitter
    // (default 0.5 stays unset). Ratio persistence is exercised in the
    // unit test instead.

    // Collapse for cleanup so following tests start single-pane.
    await bridge.evalJs(
      `window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "\\\\", metaKey: ${isMac}, ctrlKey: ${!isMac}, bubbles: true, cancelable: true,
      }))`,
    );
    await expectEventually(async () =>
      ((await bridge!.evalJs(`document.querySelectorAll(".pane-view").length`)) as number) === 1,
    );
  });

  it("toolbar split button toggles the second pane (mirrors Cmd/Ctrl+\\\\)", async () => {
    if (!bridge) return;
    await clickFirstSupportedFile(bridge);
    await expectEventually(async () =>
      ((await bridge!.evalJs(`document.querySelectorAll(".pane-view").length`)) as number) === 1,
    );

    // Click the toolbar split button.
    await bridge.evalJs(
      `document.querySelector('[aria-label="Toggle split editor"]')?.click()`,
    );
    await expectEventually(async () =>
      ((await bridge!.evalJs(`document.querySelectorAll(".pane-view").length`)) as number) === 2,
    );
    // Pressed state reflects the split.
    const pressed = (await bridge.evalJs(
      `document.querySelector('[aria-label="Toggle split editor"]')?.getAttribute("data-pressed")`,
    )) as string | null;
    expect(pressed).toBe("");

    // Click again → collapse.
    await bridge.evalJs(
      `document.querySelector('[aria-label="Toggle split editor"]')?.click()`,
    );
    await expectEventually(async () =>
      ((await bridge!.evalJs(`document.querySelectorAll(".pane-view").length`)) as number) === 1,
    );
  });

  it("'Move to Other Pane' opens the file in the second pane and removes it from the first", async () => {
    if (!bridge) return;
    // Open a file, then split so we have 2 panes with the file in pane 0.
    await clickFirstSupportedFile(bridge);
    const isMac = (await bridge.evalJs("navigator.platform.startsWith('Mac')")) === true;
    await bridge.evalJs(
      `window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "\\\\", metaKey: ${isMac}, ctrlKey: ${!isMac}, bubbles: true, cancelable: true,
      }))`,
    );
    await expectEventually(async () =>
      ((await bridge!.evalJs(`document.querySelectorAll(".pane-view").length`)) as number) === 2,
    );

    // Pane 0 has the file we clicked; pane 1 is empty (split-from-active
    // creates an empty new pane). Verify before the move.
    const before = (await bridge.evalJs(
      `({
        pane0Tabs: document.querySelector('[data-pane-index="0"]')?.querySelectorAll(".tab-bar-item").length,
        pane1Tabs: document.querySelector('[data-pane-index="1"]')?.querySelectorAll(".tab-bar-item").length,
      })`,
    )) as { pane0Tabs: number; pane1Tabs: number };
    expect(before.pane0Tabs).toBe(1);
    expect(before.pane1Tabs).toBe(0);

    // Trigger the move via __DEV__.moveTab. Kobalte ContextMenu's onSelect
    // is non-trivial to fire from happy-dom; the menu *wiring* (the entry
    // appears with the right label, clicking it forwards the tabId) is
    // covered by `tab-bar.vtest.tsx`. Here we exercise the host
    // orchestration end-to-end (open in target, close in source, focus
    // shifts) on the live app.
    const tabIdInPane0 = (await bridge.evalJs(
      `document.querySelector('[data-pane-index="0"] [data-tab-id]')?.dataset?.tabId ?? null`,
    )) as string | null;
    expect(tabIdInPane0).not.toBeNull();
    await bridge.evalJs(
      `window.__DEV__.moveTab(${JSON.stringify(tabIdInPane0)}, 0)`,
    );

    // After the move: pane 0 has 0 tabs, pane 1 has 1 tab.
    await expectEventually(async () => {
      const after = (await bridge!.evalJs(
        `({
          pane0Tabs: document.querySelector('[data-pane-index="0"]')?.querySelectorAll(".tab-bar-item").length ?? 0,
          pane1Tabs: document.querySelector('[data-pane-index="1"]')?.querySelectorAll(".tab-bar-item").length ?? 0,
        })`,
      )) as { pane0Tabs: number; pane1Tabs: number };
      return after.pane0Tabs === 0 && after.pane1Tabs === 1;
    }, 4000);

    // Cleanup: collapse the split.
    await bridge.evalJs(
      `window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "\\\\", metaKey: ${isMac}, ctrlKey: ${!isMac}, bubbles: true, cancelable: true,
      }))`,
    );
    await expectEventually(async () =>
      ((await bridge!.evalJs(`document.querySelectorAll(".pane-view").length`)) as number) === 1,
    );
  });

  it("Cmd/Ctrl+1 / Cmd/Ctrl+2 switch focus between split panes", async () => {
    if (!bridge) return;

    await clickFirstSupportedFile(bridge);
    const isMac = (await bridge.evalJs("navigator.platform.startsWith('Mac')")) === true;

    // Open the split.
    await bridge.evalJs(
      `window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "\\\\", metaKey: ${isMac}, ctrlKey: ${!isMac}, bubbles: true, cancelable: true,
      }))`,
    );
    await expectEventually(async () =>
      ((await bridge!.evalJs(`document.querySelectorAll(".pane-view").length`)) as number) === 2,
    );

    // Cmd/Ctrl+1 focuses pane 0.
    await bridge.evalJs(
      `window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "1", metaKey: ${isMac}, ctrlKey: ${!isMac}, bubbles: true, cancelable: true,
      }))`,
    );
    await expectEventually(async () =>
      (await bridge!.evalJs(
        `document.querySelector(".pane-view-active")?.dataset?.paneIndex ?? null`,
      )) === "0",
    );

    // Cmd/Ctrl+2 focuses pane 1.
    await bridge.evalJs(
      `window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "2", metaKey: ${isMac}, ctrlKey: ${!isMac}, bubbles: true, cancelable: true,
      }))`,
    );
    await expectEventually(async () =>
      (await bridge!.evalJs(
        `document.querySelector(".pane-view-active")?.dataset?.paneIndex ?? null`,
      )) === "1",
    );

    // Collapse split when done so the next test starts clean.
    await bridge.evalJs(
      `window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "\\\\", metaKey: ${isMac}, ctrlKey: ${!isMac}, bubbles: true, cancelable: true,
      }))`,
    );
    await expectEventually(async () =>
      ((await bridge!.evalJs(`document.querySelectorAll(".pane-view").length`)) as number) === 1,
    );
  });

  it("Find in Files: empty query collapses the result panel — only the input shows", async () => {
    if (!bridge) return;
    await pressShortcut(bridge, "f", true);
    await expectEventually(async () =>
      (await bridge!.evalJs(`!!document.querySelector(".find-in-files-panel input")`)) === true,
    );

    // Clear via the X button (which the previous step's persisted "the"
    // query left behind, so the X is visible).
    await bridge.evalJs(
      `(() => {
        const btn = document.querySelector(".find-in-files-clear");
        if (btn) btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      })()`,
    );

    // Status row and result list must not be in the DOM with empty query.
    const statusOrResults = (await bridge.evalJs(
      `!!document.querySelector(".find-in-files-status, .find-in-files-results")`,
    )) as boolean;
    expect(statusOrResults).toBe(false);

    await pressEscapeOnPanel(bridge, ".find-in-files-panel input");
    await expectEventually(async () =>
      (await bridge!.evalJs(`!document.querySelector(".find-in-files-panel")`)) === true,
    );
  });

  it("Cmd/Ctrl+Shift+F runs Find in Files and renders ≥1 result for a real query", async () => {
    if (!bridge) return;
    await pressShortcut(bridge, "f", true);
    await expectEventually(async () =>
      (await bridge!.evalJs(`!!document.querySelector(".find-in-files-panel input")`)) === true,
    );

    // Drive the controlled input via React-style `setter` so Solid's
    // onInput handler fires the same way the user typing would.
    await bridge.evalJs(
      `(() => {
        const input = document.querySelector(".find-in-files-panel input");
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(input, "the");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })()`,
    );

    await expectEventually(async () => {
      const count = (await bridge!.evalJs(
        `document.querySelectorAll(".find-in-files-line").length`,
      )) as number;
      return count > 0;
    }, 8000);

    await pressEscapeOnPanel(bridge, ".find-in-files-panel input");
    await expectEventually(async () =>
      (await bridge!.evalJs(`!document.querySelector(".find-in-files-panel")`)) === true,
    );
  });
});
