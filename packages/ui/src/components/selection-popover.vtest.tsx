import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal, flush } from "solid-js";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { SelectionPopover } from "./selection-popover.tsx";
import { Preview, type PreviewSelectionInfo } from "./preview.tsx";

afterEach(cleanup);

/** Minimal required-prop set for mounting a Preview in tests. */
function previewDefaults() {
  return {
    currentFilePath: null,
    findTrigger: 0,
    frontmatter: null,
    loading: false,
    pendingFragment: null,
    searchOpen: false,
    syncScrollActive: false,
    syncScrollTargetRatio: null,
    syncScrollTargetVersion: 0,
    tocVisible: false,
    wrapTables: false,
    onFragmentHandled: () => {},
    onNavigate: () => {},
    onScrollRatioChange: () => {},
    onSearchOpenChange: () => {},
    onTocChange: () => {},
  };
}

describe("SelectionPopover", () => {
  it("renders nothing when there is no selection", () => {
    const { baseElement } = render(() => <SelectionPopover info={null} onAddToChat={() => {}} />);
    expect(baseElement.querySelector(".selection-popover")).toBeNull();
  });

  it("renders 'Add to chat' and fires the callback", () => {
    const onAddToChat = vi.fn();
    const { baseElement } = render(() => (
      <SelectionPopover info={{ left: 100, bottom: 50 }} onAddToChat={onAddToChat} />
    ));
    const btns = baseElement.querySelectorAll<HTMLElement>(".selection-popover-btn");
    expect(btns).toHaveLength(1);
    fireEvent.click(btns[0]);
    expect(onAddToChat).toHaveBeenCalledTimes(1);
  });

  it("shows for a DOM selection in the rendered .doc-body and adds the selected text", async () => {
    // End-to-end over the preview path: a mouseup with a non-collapsed DOM
    // selection anchored inside the rendered article must surface the same
    // popover the editor uses, and "Add to chat" must hand back the selected
    // text. Range.getBoundingClientRect() is zeroed under happy-dom/jsdom —
    // the Preview tracking guards coords with a fallback, so the popover
    // must still render with zeroed geometry.
    const [info, setInfo] = createSignal<PreviewSelectionInfo | null>(null);
    const added: string[] = [];
    const { baseElement, container } = render(() => (
      <>
        <Preview
          {...previewDefaults()}
          html="<p>hello preview selection</p>"
          onSelectionPopover={(i) => setInfo(i)}
        />
        <SelectionPopover
          info={info()}
          onAddToChat={() => {
            const i = info();
            if (i) added.push(i.text);
          }}
        />
      </>
    ));
    // Let the html-processing effect render the article body.
    await new Promise((r) => setTimeout(r, 30));
    const para = container.querySelector(".doc-body p") as HTMLElement;
    expect(para).not.toBeNull();

    // Simulate the user's drag-selection over the paragraph, then mouseup.
    const range = document.createRange();
    range.selectNodeContents(para);
    const sel = window.getSelection() as Selection;
    sel.removeAllRanges();
    sel.addRange(range);
    fireEvent.mouseUp(para);
    flush();

    expect(info()).not.toBeNull();
    expect(info()!.text).toBe("hello preview selection");
    const btn = baseElement.querySelector(".selection-popover-btn") as HTMLElement;
    expect(btn).not.toBeNull();
    fireEvent.click(btn);
    flush();
    expect(added).toEqual(["hello preview selection"]);

    // Collapsing the selection (click elsewhere / Escape) hides the popover.
    sel.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    flush();
    expect(info()).toBeNull();
  });
});
