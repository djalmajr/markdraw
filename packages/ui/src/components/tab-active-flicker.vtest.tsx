import { existsSync, readFileSync } from "node:fs";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createRoot, flush } from "solid-js";
import { expect, it } from "vitest";
import { createAppState } from "../composables/create-app-state.ts";
import { AppShell } from "./app-shell.tsx";

it("keeps the active tab styling off the drag overlay", async () => {
  const animations = Object.getOwnPropertyDescriptor(document, "getAnimations");
  Object.defineProperty(document, "getAnimations", { configurable: true, value: () => [] });
  const noop = () => {};
  const convert = async () => ({ html: "", frontmatter: null, toc: null, meta: {} });
  const { dispose, state } = createRoot((dispose) => ({
    dispose,
    state: createAppState({ applyTheme: noop, getStoredTheme: () => "light", convertAdoc: convert, convertMarkdown: convert }),
  }));
  const pane = state.paneManager.activePane();
  const style = document.createElement("style");
  try {
    pane.tabs.openTab({ kind: "file", name: "guide.adoc", path: "guide.adoc" }, "root");
    flush();
    const view = render(() => (
      <AppShell
        state={state}
        hasRoot
        showEditorTabs
        showNavButtons={false}
        showToolbar={false}
        showSidebar={false}
        toolbarFilePath={null}
        toolbarRootName=""
        onGoBack={noop}
        onGoForward={noop}
        onLoadFile={noop}
        onNavigate={noop}
      />
    ));
    const tab = view.getByRole("button", { name: "guide.adoc" });
    const pointer = { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, clientY: 10 };
    fireEvent.pointerDown(tab, { ...pointer, buttons: 1, clientX: 10 });
    fireEvent.pointerMove(tab, { ...pointer, buttons: 1, clientX: 20 });
    try {
      const overlay = await waitFor(() => {
        const element = view.container.querySelector(".tab-bar-drag-overlay");
        expect(element).not.toBeNull();
        return element as HTMLElement;
      });
      const cssPath = ["src/styles/index.css", "packages/ui/src/styles/index.css"].find(existsSync)!;
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(readFileSync(cssPath, "utf8"));
      const tabRules = Array.from(sheet.cssRules)
        .filter((rule): rule is CSSStyleRule => rule.type === CSSRule.STYLE_RULE)
        .filter((rule) => rule.selectorText.startsWith(".tab-bar-"));
      // Happy DOM does not compute pseudo-elements. Read matching ::after
      // content declarations from the real stylesheet in cascade order.
      const afterContent = (element: HTMLElement) => tabRules
        .filter((rule) => rule.selectorText.endsWith("::after") && rule.style.content)
        .filter((rule) => element.matches(rule.selectorText.slice(0, -"::after".length)))
        .at(-1)?.style.content ?? "none";
      style.textContent = tabRules.map((rule) => rule.cssText).join("\n");
      document.head.appendChild(style);
      view.container.style.setProperty("--background", "0 0% 100%");
      view.container.style.setProperty("--sidebar-bg", "0 0% 90%");

      expect(afterContent(tab)).toBe('""');
      expect(afterContent(overlay)).toBe("none");
      expect(getComputedStyle(tab).backgroundColor).toBe("hsl(0 0% 100%)");
      expect(getComputedStyle(overlay).backgroundColor).toBe("hsl(0 0% 90%)");
    } finally {
      fireEvent.pointerUp(tab, { ...pointer, buttons: 0, clientX: 20 });
    }
  } finally {
    style.remove();
    cleanup();
    pane.tabs.discardSession();
    dispose();
    if (animations) Object.defineProperty(document, "getAnimations", animations);
    else Reflect.deleteProperty(document, "getAnimations");
  }
});
