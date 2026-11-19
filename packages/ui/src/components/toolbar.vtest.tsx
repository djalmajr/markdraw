import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { flush } from "solid-js";
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
  supportsEdit: false,
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
  it("keeps unavailable navigation focusable and ignores clicks until available", () => {
    const back = vi.fn();
    const forward = vi.fn();
    const { getByRole } = render(() => <Toolbar {...BASE_PROPS} showNavButtons onGoBack={back} onGoForward={forward} />);
    for (const name of ["Go back", "Go forward"]) {
      const button = getByRole("button", { name });
      expect(button.hasAttribute("disabled")).toBe(false);
      expect(button.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(button);
    }
    expect(back).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
    cleanup();
    const enabled = render(() => <Toolbar {...BASE_PROPS} showNavButtons canGoBack canGoForward onGoBack={back} onGoForward={forward} />);
    fireEvent.click(enabled.getByRole("button", { name: "Go back" }));
    fireEvent.click(enabled.getByRole("button", { name: "Go forward" }));
    expect(back).toHaveBeenCalledOnce();
    expect(forward).toHaveBeenCalledOnce();
  });
  it("renders the split toggle when onToggleSplit is provided and a workspace is open", () => {
    const { baseElement } = render(() => (
      <Toolbar {...BASE_PROPS} onToggleSplit={() => {}} isSplit={false} />
    ));
    const btn = baseElement.querySelector('[aria-label="Split editor"]');
    expect(btn).not.toBeNull();
  });

  it("hides the split toggle when onToggleSplit is omitted", () => {
    const { baseElement } = render(() => <Toolbar {...BASE_PROPS} />);
    expect(baseElement.querySelector('[aria-label="Split editor"]')).toBeNull();
  });

  it("hides the split toggle when no workspace is open", () => {
    const { baseElement } = render(() => (
      <Toolbar {...BASE_PROPS} hasRoot={false} onToggleSplit={() => {}} />
    ));
    expect(baseElement.querySelector('[aria-label="Split editor"]')).toBeNull();
  });

  it("clicking the split toggle invokes onToggleSplit exactly once", () => {
    // Mutation captured: deleting the `onChange` prop on the Toggle would
    // leave the click silent and the spy never fires.
    const onToggleSplit = vi.fn();
    const { baseElement } = render(() => (
      <Toolbar {...BASE_PROPS} onToggleSplit={onToggleSplit} isSplit={false} />
    ));
    const btn = baseElement.querySelector<HTMLButtonElement>(
      '[aria-label="Split editor"]',
    )!;
    fireEvent.click(btn);
    expect(onToggleSplit).toHaveBeenCalledTimes(1);
  });

  it("isSplit=true puts the toggle in the pressed state", () => {
    const { baseElement } = render(() => (
      <Toolbar {...BASE_PROPS} onToggleSplit={() => {}} isSplit={true} />
    ));
    const btn = baseElement.querySelector('[aria-label="Split editor"]')!;
    expect(btn.getAttribute("data-pressed")).toBe("");
  });
});

describe("Toolbar — TOC toggle", () => {
  // Regression: the toggle was previously gated on `hasFile`, hiding
  // it whenever the active pane was empty (file-less workspace, after
  // closing all tabs, or when the user clicked an empty pane in
  // split mode). The user's mental model is that the toggle controls
  // the right gutter regardless of file state — so it must always
  // ship in a workspace toolbar.

  it("renders the TOC toggle when no file is open", () => {
    const { baseElement } = render(() => (
      <Toolbar {...BASE_PROPS} hasFile={false} hasRoot={true} />
    ));
    expect(
      baseElement.querySelector('[aria-label="Toggle table of contents"]'),
    ).not.toBeNull();
  });

  it("renders the TOC toggle when a file is open", () => {
    const { baseElement } = render(() => (
      <Toolbar {...BASE_PROPS} hasFile={true} hasRoot={true} />
    ));
    expect(
      baseElement.querySelector('[aria-label="Toggle table of contents"]'),
    ).not.toBeNull();
  });

  it("clicking the TOC toggle invokes onToggleToc exactly once", () => {
    // Mutation captured: dropping the `onChange` prop on the Toggle
    // makes the click silent and the spy never fires.
    const onToggleToc = vi.fn();
    const { baseElement } = render(() => (
      <Toolbar {...BASE_PROPS} hasFile={false} onToggleToc={onToggleToc} />
    ));
    const btn = baseElement.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle table of contents"]',
    )!;
    fireEvent.click(btn);
    expect(onToggleToc).toHaveBeenCalledTimes(1);
  });

  it("tocVisible=true puts the toggle in the pressed state", () => {
    const { baseElement } = render(() => (
      <Toolbar {...BASE_PROPS} tocVisible={true} />
    ));
    const btn = baseElement.querySelector(
      '[aria-label="Toggle table of contents"]',
    )!;
    expect(btn.getAttribute("data-pressed")).toBe("");
  });
});

describe("Toolbar — Release Notes prop wiring (DJA-33)", () => {
  // Kobalte's DropdownMenu lazy-mounts items only when the user opens
  // the menu through real pointer/keyboard gestures — synthetic
  // .click() events don't trigger the open state. We can still assert
  // that the host's `onReleaseNotes` callback survives onto the
  // Toolbar without exploding (prop wiring smoke), and the dialog
  // render + behaviour mutation is fully covered in
  // `release-notes-dialog.vtest.tsx`. The menu-entry render itself is
  // protected by the in-app Tauri MCP screenshot capture during the
  // DJA-33 visual validation pass.
  it("accepts onReleaseNotes without throwing and continues rendering the toolbar", () => {
    const onReleaseNotes = vi.fn();
    const { baseElement } = render(() => (
      <Toolbar {...BASE_PROPS} onReleaseNotes={onReleaseNotes} />
    ));
    // Toolbar still mounts and the menu trigger is intact (no
    // accidental crash from the new prop pathway).
    expect(baseElement.querySelector('[aria-label="Menu"]')).not.toBeNull();
    expect(onReleaseNotes).not.toHaveBeenCalled();
  });
});

describe("Toolbar — editor-mode tabs gated by capabilities", () => {
  function tabState(baseElement: Element) {
    const tabs = [...baseElement.querySelectorAll<HTMLButtonElement>('.toolbar-center [role="tab"]')];
    // ui-sdk marks disabled tabs with aria-disabled/data-disabled instead of
    // the native `disabled` attribute (disabled tabs stay focusable).
    return Object.fromEntries(
      tabs.map((t) => [t.textContent?.trim(), t.getAttribute("aria-disabled") === "true"]),
    );
  }

  it("media (preview-only): edit + split disabled, preview enabled", () => {
    // Mutation captured: wiring `disabled` to !supportsPreview on the
    // edit tab (the pre-feature behavior) would re-enable Edit for an
    // image — flipping this assertion.
    const { baseElement } = render(() => (
      <Toolbar {...BASE_PROPS} hasFile supportsPreview supportsEdit={false} />
    ));
    const t = tabState(baseElement);
    expect(t["Edit"]).toBe(true);
    expect(t["Edit & Preview"]).toBe(true);
    expect(t["Preview"]).toBe(false);
  });

  it("plain text (edit-only): edit enabled, split + preview disabled", () => {
    const { baseElement } = render(() => (
      <Toolbar {...BASE_PROPS} hasFile supportsEdit supportsPreview={false} />
    ));
    const t = tabState(baseElement);
    expect(t["Edit"]).toBe(false);
    expect(t["Edit & Preview"]).toBe(true);
    expect(t["Preview"]).toBe(true);
  });

  it("document (both): all three tabs enabled", () => {
    const { baseElement } = render(() => (
      <Toolbar {...BASE_PROPS} hasFile supportsEdit supportsPreview />
    ));
    const t = tabState(baseElement);
    expect(t["Edit"]).toBe(false);
    expect(t["Edit & Preview"]).toBe(false);
    expect(t["Preview"]).toBe(false);
  });
});

describe("Toolbar — minimal window frame", () => {
  it("shows only the menu and leaves window gestures to the drag region", async () => {
    const drag = vi.fn();
    const maximize = vi.fn();
    const { baseElement } = render(() => (
      <Toolbar {...BASE_PROPS} minimal inWindowFrame controlsOnLeft showNavButtons
        onOpenFolder={() => {}} onToggleSplit={() => {}} onReload={() => {}}
        onWindowDragStart={drag} onWindowTitleDoubleClick={maximize} />
    ));
    const header = baseElement.querySelector<HTMLElement>("header.toolbar")!;
    const menu = header.querySelector<HTMLButtonElement>('[aria-label="Menu"]')!;
    expect(header.classList.contains("toolbar-window-frame")).toBe(true);
    expect(header.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(header.querySelector(".toolbar-left")?.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(header.querySelector(".toolbar-right")?.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(header.querySelectorAll("button")).toHaveLength(1);
    fireEvent.mouseDown(header, { button: 0 });
    fireEvent.dblClick(header);
    fireEvent.mouseDown(menu, { button: 0 });
    fireEvent.dblClick(menu);
    expect(drag).not.toHaveBeenCalled();
    expect(maximize).not.toHaveBeenCalled();
    // ui-sdk opens the menu from a trigger press; Solid 2 commits the open
    // state on the next flush.
    fireEvent.click(menu);
    flush();
    await vi.waitFor(() => expect(baseElement.textContent).toContain("Open Folder"));
  });
});
