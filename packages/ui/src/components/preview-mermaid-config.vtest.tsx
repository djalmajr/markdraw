import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render, waitFor } from "@solidjs/testing-library";

// preview.tsx imports mermaid statically and calls `initialize` lazily, on the
// first mermaid block it has to render. Mocking the module is the only way to
// read the exact config the component passes: happy-dom cannot lay out SVG, so
// a real `mermaid.render` would neither prove nor disprove anything here.
const { initialize, renderDiagram } = vi.hoisted(() => ({
  initialize: vi.fn(),
  renderDiagram: vi.fn(async () => ({
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"></svg>',
  })),
}));
vi.mock("mermaid", () => ({ default: { initialize, render: renderDiagram } }));

import { Preview } from "./preview.tsx";

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
  initialize.mockClear();
  renderDiagram.mockClear();
  document.documentElement.classList.remove("dark");
});

// Order matters: `mermaidInitialized` is module state in preview.tsx. The first
// test renders no diagram, so it leaves the flag cold for the second one, which
// then exercises the theme-change re-init (the MutationObserver in preview.tsx
// flips the flag back on an <html> class change).
describe("Preview — mermaid 12 keeps the mermaid 11 appearance", () => {
  it("does not touch mermaid at all for a document without diagrams", async () => {
    // Guard for the fixture below: its assertions must come from a real
    // mermaid block, not from mounting a Preview.
    render(() => <Preview {...previewProps(PLAIN_HTML)} />);
    await new Promise((r) => setTimeout(r, 80));
    expect(initialize).not.toHaveBeenCalled();
    expect(renderDiagram).not.toHaveBeenCalled();
  });

  it("initialises mermaid with look classic and layout dagre (light and dark)", async () => {
    // Mutation: dropping `look`/`layout` hands the config back to mermaid 12's
    // new defaults (`neo` look + ELK layout), which recolours and re-routes
    // every existing diagram. Upstream 12.0.0 names both options as the way to
    // keep the old look; the assertions below are what pins them.
    const [html, setHtml] = createSignal(MERMAID_HTML_LIGHT);
    render(() => <Preview {...previewProps(html())} />);

    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    const light = initialize.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(light).toMatchObject({ look: "classic", layout: "dagre", theme: "default" });
    expect(light.startOnLoad).toBe(false);
    expect(light.securityLevel).toBe("strict");

    // Control for the theme branch: the dark class must still reach
    // `mermaid.initialize` as `theme: "dark"` — pinning the look must not
    // flatten the theme the app already chose.
    document.documentElement.classList.add("dark");
    await new Promise((r) => setTimeout(r, 50)); // let the MutationObserver flip the flag
    setHtml(MERMAID_HTML_DARK); // new document → effect re-runs → re-init

    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(2));
    const dark = initialize.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(dark).toMatchObject({ look: "classic", layout: "dagre", theme: "dark" });
  });
});
