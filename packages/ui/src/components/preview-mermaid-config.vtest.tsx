import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { cleanup, render, waitFor } from "@solidjs/testing-library";

const { warm, frameRender, mainRender } = vi.hoisted(() => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"></svg>';
  return {
    warm: vi.fn(async () => {}),
    frameRender: vi.fn(async () => ({ svg })),
    mainRender: vi.fn(async () => ({ svg })),
  };
});
vi.mock(import("../lib/mermaid-frame.ts"), async (original) => ({
  ...await original(),
  ensureMermaidWarm: warm,
  renderInFrame: frameRender,
}));
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: mainRender } }));

import { Preview } from "./preview.tsx";
import { mermaidCache } from "../lib/mermaid-cache.ts";

const PLAIN_HTML = "<p>no diagrams here</p>";
const MERMAID_HTML_LIGHT = `<div class="mermaid">graph LR
A[box] --&gt; B(rounded)</div>`;
const MERMAID_HTML_DARK = `<div class="mermaid">graph LR
X[diamond] --&gt; Y(cylinder)</div>`;

function previewProps(html: string) {
  return {
    html,
    frontmatter: null,
    loading: false,
    searchOpen: false,
    syncScrollActive: false,
    syncScrollTargetRatio: null,
    syncScrollTargetVersion: 0,
    tocVisible: false,
    wrapTables: false,
    currentFilePath: null,
    pendingFragment: null,
    findTrigger: 0,
    onNavigate: () => {},
    onScrollRatioChange: () => {},
    onSearchOpenChange: () => {},
    onTocChange: () => {},
    onFragmentHandled: () => {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  mermaidCache.clear();
  document.documentElement.classList.remove("dark");
});

describe("Preview — Mermaid iframe rendering", () => {
  it("does not touch mermaid at all for a document without diagrams", async () => {
    const { container } = render(() => <Preview {...previewProps(PLAIN_HTML)} />);
    await waitFor(() => expect(container.querySelector("article")?.textContent).toBe("no diagrams here"));
    expect(warm).not.toHaveBeenCalled();
    expect(frameRender).not.toHaveBeenCalled();
    expect(mainRender).not.toHaveBeenCalled();
  });

  it("warms and renders through the iframe with the article and current theme", async () => {
    const [html, setHtml] = createSignal(MERMAID_HTML_LIGHT);
    const { container } = render(() => <Preview {...previewProps(html())} />);
    await waitFor(() => expect(container.querySelector(".mermaid svg")).not.toBeNull());
    const article = container.querySelector("article");
    expect(warm).toHaveBeenCalledWith(article);
    expect(mainRender).not.toHaveBeenCalled();
    expect(frameRender).toHaveBeenLastCalledWith(
      expect.stringMatching(/^mermaid-/), "graph LR\nA[box] --> B(rounded)", "default", article, expect.any(Function),
    );

    document.documentElement.classList.add("dark");
    setHtml(MERMAID_HTML_DARK);
    await waitFor(() => expect(frameRender).toHaveBeenLastCalledWith(
      expect.stringMatching(/^mermaid-/), "graph LR\nX[diamond] --> Y(cylinder)", "dark", article, expect.any(Function),
    ));
    expect(mainRender).not.toHaveBeenCalled();
  });
});
