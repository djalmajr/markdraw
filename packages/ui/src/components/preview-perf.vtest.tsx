import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createSignal, flush } from "solid-js";
import { cleanup, render, waitFor } from "@solidjs/testing-library";

const counts = vi.hoisted(() => ({ mermaid: 0 }));
vi.mock("mermaid", () => ({
  default: {
    initialize: () => {},
    render: async (id: string) => {
      if (id !== "mermaid-prewarm") counts.mermaid++;
      return { svg: '<svg viewBox="0 0 10 10"><text>Ready</text></svg>' };
    },
  },
}));

import { Preview } from "./preview.tsx";

const fixture = process.env.MARKDRAW_PERF_HTML;
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.skipIf(!fixture)("measures the synthetic AsciiDoc fixture across preview actions", async () => {
  const documentHtml = readFileSync(fixture!, "utf8");
  const [html, setHtml] = createSignal(documentHtml);
  const [tocVisible, setTocVisible] = createSignal(false);
  const toc = document.createElement("div");
  document.body.appendChild(toc);
  let fetches = 0;
  let active = 0;
  let maximum = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    fetches++;
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return new Response('<svg viewBox="0 0 10 10"><text>Ready</text></svg>');
  }));
  try {
    const { container } = render(() => (
      <div class="content"><Preview html={html()} tocVisible={tocVisible()} tocContainer={toc}
        currentFilePath="main.adoc" pendingFragment={null} onFragmentHandled={() => {}}
        frontmatter={null} loading={false} searchOpen={false} syncScrollActive={false}
        syncScrollTargetRatio={null} syncScrollTargetVersion={0} wrapTables={false}
        findTrigger={0} onNavigate={() => {}} onScrollRatioChange={() => {}}
        onSearchOpenChange={() => {}} onTocChange={() => {}} /></div>
    ));
    const ready = async () => {
      await waitFor(() => {
        expect(container.querySelectorAll(".mermaid svg")).toHaveLength(10);
        expect(container.querySelectorAll(".kroki svg")).toHaveLength(10);
      }, { timeout: 15000 });
    };
    await ready();
    console.log(`perf open mermaid=${counts.mermaid} fetch=${fetches} max=${maximum}`);
    setHtml("<h1>Other tab</h1>");
    flush();
    await waitFor(() => expect(container.textContent).toContain("Other tab"));
    console.log(`perf away mermaid=${counts.mermaid} fetch=${fetches} max=${maximum}`);
    setHtml(documentHtml);
    flush();
    await ready();
    console.log(`perf return mermaid=${counts.mermaid} fetch=${fetches} max=${maximum}`);
    setTocVisible(true);
    flush();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await ready();
    console.log(`perf toc mermaid=${counts.mermaid} fetch=${fetches} max=${maximum}`);
  } finally {
    toc.remove();
  }
}, 60000);
