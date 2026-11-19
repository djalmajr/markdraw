import { existsSync, readFileSync } from "node:fs";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { EditorToolbar } from "./editor-toolbar.tsx";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("keeps unavailable history buttons focusable and ignores activation", () => {
  const [available, setAvailable] = createSignal(false);
  const undo = vi.fn();
  const redo = vi.fn();
  const { getByRole, container } = render(() => <EditorToolbar
    searchOpen={false} showInvisibles={false} showLineNumbers={false}
    indentMode="spaces" indentSize={2} syncScroll={false} wrapText={false}
    canUndo={available()} canRedo={available()} onUndo={undo} onRedo={redo}
    onToggleFind={() => {}} onIndentChange={() => {}} onToggleShowInvisibles={() => {}}
    onToggleShowLineNumbers={() => {}} onToggleWrapText={() => {}} onToggleSyncScroll={() => {}}
  />);
  const buttons = [getByRole("button", { name: "Undo" }), getByRole("button", { name: "Redo" })];
  const cssPath = ["src/styles/index.css", "packages/ui/src/styles/index.css"].find(existsSync)!;
  const stylesheet = new CSSStyleSheet();
  stylesheet.replaceSync(readFileSync(cssPath, "utf8"));
  const rules = Array.from(stylesheet.cssRules).filter((rule) => rule instanceof CSSStyleRule);
  const disabledRule = rules.find((rule) => rule.selectorText.includes(".content-toolbar-btn:disabled") && rule.style.opacity === "0.3")!;
  const hoverRule = rules.find((rule) => rule.selectorText.startsWith(".content-toolbar-btn:hover"))!;
  expect(disabledRule).toBeDefined();
  expect(hoverRule).toBeDefined();
  // Match hover eligibility separately from the headless DOM's pointer state.
  const hoverSelector = hoverRule.selectorText.replace(":hover", "");
  for (const button of buttons) {
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.matches(disabledRule.selectorText)).toBe(true);
    expect(button.matches(hoverSelector)).toBe(false);
    expect(rules.some((rule) => rule.style.pointerEvents === "none" && button.matches(rule.selectorText))).toBe(false);
    fireEvent.click(button);
  }
  expect(undo).not.toHaveBeenCalled();
  expect(redo).not.toHaveBeenCalled();
  setAvailable(true);
  flush();
  for (const button of buttons) {
    expect(button.matches(disabledRule.selectorText)).toBe(false);
    expect(button.matches(hoverSelector)).toBe(true);
    fireEvent.click(button);
  }
  expect(undo).toHaveBeenCalledOnce();
  expect(redo).toHaveBeenCalledOnce();
  for (const button of container.querySelectorAll("button")) {
    expect(button.getAttribute("aria-label") || button.textContent?.trim()).toBeTruthy();
  }
});

it("keeps the Wrap text toggle working after switching to the text-wrap icon", () => {
  const [wrapText, setWrapText] = createSignal(false);
  const toggleWrapText = vi.fn(() => setWrapText((value) => !value));
  const { getByRole } = render(() => <EditorToolbar
    searchOpen={false} showInvisibles={false} showLineNumbers={false}
    indentMode="spaces" indentSize={2} syncScroll={false} wrapText={wrapText()}
    canUndo={false} canRedo={false} onUndo={() => {}} onRedo={() => {}}
    onToggleFind={() => {}} onIndentChange={() => {}} onToggleShowInvisibles={() => {}}
    onToggleShowLineNumbers={() => {}} onToggleWrapText={toggleWrapText} onToggleSyncScroll={() => {}}
  />);

  const button = getByRole("button", { name: "Wrap text" });
  expect(button.getAttribute("aria-pressed")).toBe("false");
  // The lucide text-wrap path is distinct from the old file-text document.
  const icon = button.querySelector("svg")?.innerHTML ?? "";
  expect(icon).toContain('d="m16 16l-3 3l3 3"');
  expect(icon).not.toContain("M6 22a2 2 0 0 1-2-2V4");

  fireEvent.click(button);
  expect(toggleWrapText).toHaveBeenCalledTimes(1);
  flush();
  expect(button.getAttribute("aria-pressed")).toBe("true");

  setWrapText(false);
  flush();
  expect(button.getAttribute("aria-pressed")).toBe("false");
});
