import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { BacklinksList } from "./backlinks-list.tsx";

afterEach(cleanup);

describe("BacklinksList", () => {
  it("renders the empty-state message when there are no entries", () => {
    // Mutation captured: removing the `<Show fallback>` would leave
    // a bare empty `<ul>` and the user wouldn't know whether the
    // panel was loading or genuinely empty.
    const { baseElement } = render(() => (
      <BacklinksList entries={[]} onSelect={() => {}} />
    ));
    expect(baseElement.querySelector(".backlinks-empty")).not.toBeNull();
    expect(baseElement.querySelector(".backlinks-tree")).toBeNull();
  });

  it("renders one row per entry with the supplied label", () => {
    // Mutation: indexing by the wrong field (e.g. `entry.path`)
    // would show file paths instead of basenames in the UI.
    const { baseElement } = render(() => (
      <BacklinksList
        entries={[
          { path: "a.md", label: "a.md" },
          { path: "docs/b.md", label: "b.md" },
        ]}
        onSelect={() => {}}
      />
    ));
    const rows = baseElement.querySelectorAll(".backlinks-item");
    expect(rows.length).toBe(2);
    expect(rows[0]!.textContent).toContain("a.md");
    expect(rows[1]!.textContent).toContain("b.md");
  });

  it("invokes onSelect with the full entry on click", () => {
    // Mutation: passing only the path (or some derived value) to
    // onSelect would force the host to re-derive context (rootId)
    // every time, which it can't always do — broke the navigation
    // path during prototyping.
    const onSelect = vi.fn();
    const entry = { path: "x.md", label: "x.md", rootId: "root1" };
    const { baseElement } = render(() => (
      <BacklinksList entries={[entry]} onSelect={onSelect} />
    ));
    const btn = baseElement.querySelector<HTMLButtonElement>(".backlinks-link")!;
    fireEvent.click(btn);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(entry);
  });

  it("uses the path as a tooltip title so long lists stay disambiguated", () => {
    // Mutation: omitting the `title` attribute hides the full path
    // when two files share a basename — a common case when the
    // workspace has multi-root or i18n folder structures.
    const { baseElement } = render(() => (
      <BacklinksList
        entries={[{ path: "deep/folder/file.md", label: "file.md" }]}
        onSelect={() => {}}
      />
    ));
    const btn = baseElement.querySelector<HTMLButtonElement>(".backlinks-link")!;
    expect(btn.getAttribute("title")).toBe("deep/folder/file.md");
  });
});
