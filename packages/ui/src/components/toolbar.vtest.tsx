import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { Toolbar } from "./toolbar.tsx";

afterEach(cleanup);

const BASE_PROPS = {
  canGoBack: false,
  canGoForward: false,
  darkMode: false,
  editorMode: "preview" as const,
  hasFile: false,
  hasRoot: true,
  supportsPreview: false,
  recentFiles: [],
  recentFolders: [],
  showEditorTabs: true,
  sidebarVisible: true,
  themeMode: "system",
  tocVisible: false,
  onEditorModeChange: () => {},
  onThemeChange: () => {},
  onToggleSidebar: () => {},
  onToggleToc: () => {},
};

describe("Toolbar — split editor toggle", () => {
  it("renders the split toggle when onToggleSplit is provided and a workspace is open", () => {
    const { baseElement } = render(() => (
      <Toolbar {...BASE_PROPS} onToggleSplit={() => {}} isSplit={false} />
    ));
    const btn = baseElement.querySelector('[aria-label="Toggle split editor"]');
    expect(btn).not.toBeNull();
  });

  it("hides the split toggle when onToggleSplit is omitted", () => {
    const { baseElement } = render(() => <Toolbar {...BASE_PROPS} />);
    expect(baseElement.querySelector('[aria-label="Toggle split editor"]')).toBeNull();
  });

  it("hides the split toggle when no workspace is open", () => {
    const { baseElement } = render(() => (
      <Toolbar {...BASE_PROPS} hasRoot={false} onToggleSplit={() => {}} />
    ));
    expect(baseElement.querySelector('[aria-label="Toggle split editor"]')).toBeNull();
  });

  it("clicking the split toggle invokes onToggleSplit exactly once", () => {
    // Mutation captured: deleting the `onChange` prop on the Toggle would
    // leave the click silent and the spy never fires.
    const onToggleSplit = vi.fn();
    const { baseElement } = render(() => (
      <Toolbar {...BASE_PROPS} onToggleSplit={onToggleSplit} isSplit={false} />
    ));
    const btn = baseElement.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle split editor"]',
    )!;
    fireEvent.click(btn);
    expect(onToggleSplit).toHaveBeenCalledTimes(1);
  });

  it("isSplit=true puts the toggle in the pressed state", () => {
    const { baseElement } = render(() => (
      <Toolbar {...BASE_PROPS} onToggleSplit={() => {}} isSplit={true} />
    ));
    const btn = baseElement.querySelector('[aria-label="Toggle split editor"]')!;
    expect(btn.getAttribute("data-pressed")).toBe("");
  });
});
