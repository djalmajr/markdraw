import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, flush, OBSERVE } from "solid-js";
import { attribution } from "solid-js/attribution";
import { afterEach, expect, it } from "vitest";
import type { Frontmatter } from "@markdraw/core/frontmatter.ts";
import { FrontmatterPanel } from "./frontmatter-panel.tsx";

afterEach(cleanup);

it("retains each property row and renders the latest value for its field", ({ onTestFinished }) => {
  if (!OBSERVE) throw new Error("Solid's diagnostics runtime is required");
  const diagnostics = OBSERVE.diagnostics.capture();
  const releaseAttribution = attribution.enable({ log: false });
  onTestFinished(() => {
    diagnostics.stop();
    releaseAttribution();
  });
  expect(OBSERVE.attribution.installed).not.toBeNull();
  const [frontmatter, setFrontmatter] = createSignal<Frontmatter>({
    title: "Draft proposal",
    status: "draft",
  });
  const { container } = render(() => (
    <FrontmatterPanel frontmatter={frontmatter()} currentFilePath={null} onNavigate={() => {}} />
  ));
  const rowFor = (key: string) => Array.from(container.querySelectorAll(".frontmatter-row"))
    .find((row) => row.querySelector(".frontmatter-key")?.textContent === key);

  const title = rowFor("title");
  const status = rowFor("status");
  expect(title).toBeDefined();
  expect(status?.querySelector(".frontmatter-value")?.textContent).toBe("draft");

  // A document edit can trigger conversion with a fresh but equivalent object.
  setFrontmatter({ title: "Draft proposal", status: "draft" });
  flush();
  expect.soft(diagnostics.events.map(({ code }) => code)).not.toContain("UNSTABLE_LIST_IDENTITY");
  expect(rowFor("title")).toBe(title);
  expect(rowFor("status")).toBe(status);

  setFrontmatter({ title: "Draft proposal", status: "published" });
  flush();
  expect(rowFor("status")).toBe(status);
  expect(status?.querySelector(".frontmatter-value")?.textContent).toBe("published");

  setFrontmatter({ title: "Draft proposal", type: "note", status: "published" });
  flush();
  expect(rowFor("type")?.querySelector(".frontmatter-value")?.textContent).toBe("note");
  expect(rowFor("status")).toBe(status);
  expect(diagnostics.events.map(({ code }) => code)).not.toContain("UNSTABLE_LIST_IDENTITY");
});
