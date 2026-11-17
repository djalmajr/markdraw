import { describe, expect, it } from "vitest";
import { aiDirectoryContextLabel } from "./app-shell.tsx";

describe("aiDirectoryContextLabel", () => {
  it("keeps the workspace-relative parent path for nested folder context chips", () => {
    expect(aiDirectoryContextLabel({ name: "playwright", path: "output/playwright" })).toBe(
      "output/playwright/",
    );
  });

  it("falls back to the folder name for workspace-root pseudo entries", () => {
    expect(aiDirectoryContextLabel({ name: "markdraw", path: "" })).toBe("markdraw/");
  });
});

import { afterEach, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { createComponent } from "solid-js";
import { AppShell } from "./app-shell.tsx";
import { createAppState } from "../composables/create-app-state.ts";

afterEach(cleanup);

describe("AppShell toolbar on the welcome screen", () => {
  function mount(showToolbar: boolean, showWindowControls: boolean) {
    return render(() => {
      const state = createAppState({
        applyTheme: () => {},
        convertAdoc: async () => ({ html: "", frontmatter: null }),
        convertMarkdown: async () => ({ html: "", frontmatter: null }),
        getStoredTheme: () => "system",
      });
      return createComponent(AppShell, {
        state, showToolbar, showWindowControls, windowFrameToolbar: true,
        hasRoot: false, showEditorTabs: true, showNavButtons: false, showSidebar: false,
        toolbarFilePath: null, toolbarRootName: "", onGoBack: vi.fn(), onGoForward: vi.fn(),
        onLoadFile: vi.fn(), onOpenFolder: vi.fn(),
      });
    });
  }

  it("renders the minimal menu for custom window controls", () => {
    const { container } = mount(false, true);
    const header = container.querySelector("header.toolbar");
    expect(header).not.toBeNull();
    expect(header?.querySelector('[aria-label="Menu"]')).not.toBeNull();
    expect(header?.querySelectorAll("button")).toHaveLength(1);
  });
  it("does not render a toolbar without window controls", () => {
    const { container } = mount(false, false);
    expect(container.querySelector("header.toolbar")).toBeNull();
  });
  it("keeps the normal toolbar when enabled", () => {
    const { container } = mount(true, true);
    expect(container.querySelector('header.toolbar [role="tablist"]')).not.toBeNull();
  });
});
