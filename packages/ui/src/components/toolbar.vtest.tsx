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
