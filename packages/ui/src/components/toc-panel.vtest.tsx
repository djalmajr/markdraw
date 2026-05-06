import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { TocPanel } from "./toc-panel.tsx";

afterEach(cleanup);

const BASE_PROPS = {
  tocVisible: true,
  hasRoot: true,
  hasToc: true,
  tocLevels: 3,
  setTocLevels: () => {},
  setTocExpanded: () => {},
  contentRef: () => {},
};

/**
 * Coverage shape — every test below maps to a behaviour the user
 * actually relied on while we iterated on the right gutter:
 *
 * - Visibility rules: hide on home screen, hide on toolbar-disable,
 *   show in every other state (file-less workspace, edit-only, doc
 *   without headings).
 * - Empty-state placeholder: must render exactly when `hasToc` is
 *   false, and never in the same place as the moved `#toc` node
 *   (otherwise Preview's `textContent = ""` would wipe it).
 * - TOC level passthrough: dropdown wires the right value back to
 *   the host so the eyeball-style depth filter still works.
 *
 * These are the regressions we shipped fixes for in 0.9.x; the
 * file is mutation-resistant against:
 *   - flipping `!props.tocVisible` (panel would stay open)
 *   - dropping `!props.hasRoot` (gutter would appear on home screen)
 *   - moving the placeholder INSIDE `.toc-panel-tree` (would survive
 *     the first render but get wiped by Preview)
 */
describe("TocPanel — visibility", () => {
  it("renders the panel in a workspace with toggle on", () => {
    const { baseElement } = render(() => <TocPanel {...BASE_PROPS} />);
    const panel = baseElement.querySelector(".toc-panel")!;
    expect(panel.classList.contains("toc-hidden")).toBe(false);
  });

  it("hides the panel on the home screen (no workspace) even when toggle is on", () => {
    // Mutation: removing `!props.hasRoot` from the toc-hidden classList
    // would put the empty gutter next to the dropzone EmptyState.
    const { baseElement } = render(() => (
      <TocPanel {...BASE_PROPS} hasRoot={false} />
    ));
    const panel = baseElement.querySelector(".toc-panel")!;
    expect(panel.classList.contains("toc-hidden")).toBe(true);
  });

  it("hides the panel when the toolbar toggle is off", () => {
    // Mutation: flipping the toggle predicate would leave the panel
    // visible after the user explicitly disables it.
    const { baseElement } = render(() => (
      <TocPanel {...BASE_PROPS} tocVisible={false} />
    ));
    const panel = baseElement.querySelector(".toc-panel")!;
    expect(panel.classList.contains("toc-hidden")).toBe(true);
  });

  it("stays visible when the active doc has no headings (file-less workspace, doc without TOC)", () => {
    // Regression: a previous build hid the panel whenever `hasToc` was
    // false, so users saw the gutter pop in/out as they switched
    // between docs. The empty-state placeholder takes its place now.
    const { baseElement } = render(() => (
      <TocPanel {...BASE_PROPS} hasToc={false} />
    ));
    const panel = baseElement.querySelector(".toc-panel")!;
    expect(panel.classList.contains("toc-hidden")).toBe(false);
    expect(panel.classList.contains("toc-empty")).toBe(true);
  });
});

describe("TocPanel — empty state placeholder", () => {
  it("renders the no-headings message when hasToc is false", () => {
    const { baseElement } = render(() => (
      <TocPanel {...BASE_PROPS} hasToc={false} />
    ));
    const placeholder = baseElement.querySelector(".toc-panel-empty");
    expect(placeholder).not.toBeNull();
    expect(placeholder!.textContent).toMatch(/no headings|nenhum título|sin títulos/i);
  });

  it("does NOT render the placeholder when hasToc is true", () => {
    const { baseElement } = render(() => <TocPanel {...BASE_PROPS} hasToc={true} />);
    expect(baseElement.querySelector(".toc-panel-empty")).toBeNull();
  });

  it("places the placeholder OUTSIDE .toc-panel-tree so Preview's textContent reset cannot wipe it", () => {
    // This is structural — Preview clears `tocContainerRef` (the .toc-panel-tree
    // div) with `textContent = ""` whenever a pane re-binds the active TOC.
    // If the placeholder lives inside that div, it disappears on the next
    // pane focus flip and the gutter ends up empty (no message, no headings).
    const { baseElement } = render(() => (
      <TocPanel {...BASE_PROPS} hasToc={false} />
    ));
    const placeholder = baseElement.querySelector(".toc-panel-empty")!;
    const tree = baseElement.querySelector(".toc-panel-tree")!;
    expect(tree.contains(placeholder)).toBe(false);
    // Sanity: both share the same parent (.toc-panel-scroll)
    expect(placeholder.parentElement).toBe(tree.parentElement);
  });

  it("toggles the placeholder reactively when hasToc flips", () => {
    // Regression for the focus-flip bug: when the active pane went
    // from a doc with toc → empty pane, the panel stayed visible but
    // the placeholder didn't appear because the reactive read was
    // missed. Guard the `<Show>` against accessor regressions.
    const [hasToc, setHasToc] = createSignal(true);
    const { baseElement } = render(() => (
      <TocPanel {...BASE_PROPS} hasToc={hasToc()} />
    ));
    expect(baseElement.querySelector(".toc-panel-empty")).toBeNull();
    setHasToc(false);
    expect(baseElement.querySelector(".toc-panel-empty")).not.toBeNull();
    setHasToc(true);
    expect(baseElement.querySelector(".toc-panel-empty")).toBeNull();
  });
});

describe("TocPanel — refs and dropdown", () => {
  it("exposes the inner content node via contentRef so Preview can move #toc into it", () => {
    let captured: HTMLElement | undefined;
    render(() => (
      <TocPanel
        {...BASE_PROPS}
        contentRef={(el) => {
          captured = el;
        }}
      />
    ));
    expect(captured).toBeDefined();
    expect(captured!.classList.contains("toc-panel-tree")).toBe(true);
  });

  it("forwards the panel root via panelRef when supplied", () => {
    let captured: HTMLElement | undefined;
    render(() => (
      <TocPanel
        {...BASE_PROPS}
        panelRef={(el) => {
          captured = el;
        }}
      />
    ));
    expect(captured).toBeDefined();
    expect(captured!.classList.contains("toc-panel")).toBe(true);
  });

  it("renders the data-toc-levels attribute so CSS can filter visible depth", () => {
    // Regression: the depth filter is implemented purely in CSS via
    // `[data-toc-levels="N"]` selectors. If the prop isn't reflected
    // on the DOM node, deeper levels would always render.
    const { baseElement } = render(() => <TocPanel {...BASE_PROPS} tocLevels={2} />);
    const panel = baseElement.querySelector(".toc-panel")!;
    expect(panel.getAttribute("data-toc-levels")).toBe("2");
  });
});

describe("TocPanel — segment tabs", () => {
  it("starts on the TOC tab by default", () => {
    // Mutation: defaulting to "backlinks" would surprise the user
    // — TOC is the primary content of the gutter.
    const { baseElement } = render(() => (
      <TocPanel {...BASE_PROPS} backlinksSlot={<div data-testid="bl">x</div>} />
    ));
    const tocPane = baseElement.querySelector('[data-pane="toc"]')!;
    const blPane = baseElement.querySelector('[data-pane="backlinks"]')!;
    expect(tocPane.hasAttribute("hidden")).toBe(false);
    expect(blPane.hasAttribute("hidden")).toBe(true);
  });

  it("clicking the References tab swaps which pane is hidden", () => {
    // Mutation: forgetting to flip both `hidden` attributes (or
    // inverting the predicate) would leave both panes visible at
    // once or both hidden — neither is a valid UI state.
    const { baseElement, getAllByRole } = render(() => (
      <TocPanel {...BASE_PROPS} backlinksSlot={<div data-testid="bl">x</div>} />
    ));
    const tabs = getAllByRole("tab");
    const refsTab = tabs.find((t) =>
      /references|referências|referencias/i.test(t.textContent || ""),
    )!;
    fireEvent.click(refsTab);
    const tocPane = baseElement.querySelector('[data-pane="toc"]')!;
    const blPane = baseElement.querySelector('[data-pane="backlinks"]')!;
    expect(tocPane.hasAttribute("hidden")).toBe(true);
    expect(blPane.hasAttribute("hidden")).toBe(false);
  });

  it("keeps the TOC pane mounted when on the References tab (Preview's contentRef must remain valid)", () => {
    // Regression: Preview moves the rendered `#toc` node into the
    // tree via `contentRef`. If the TOC pane were unmounted when
    // not active, the move would target a detached element and
    // the toc would never appear when the user switches back.
    const { baseElement, getAllByRole } = render(() => (
      <TocPanel {...BASE_PROPS} backlinksSlot={<div data-testid="bl">x</div>} />
    ));
    const tabs = getAllByRole("tab");
    fireEvent.click(tabs[1]!); // References
    expect(baseElement.querySelector(".toc-panel-tree")).not.toBeNull();
  });

  it("renders the count badge on the References tab when there are inbound references", () => {
    // Mutation: hiding the count badge masks the discoverability of
    // the feature — users wouldn't know the tab has data without
    // clicking it.
    const { baseElement } = render(() => (
      <TocPanel {...BASE_PROPS} backlinksCount={3} />
    ));
    const badge = baseElement.querySelector(".toc-panel-tab-count");
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe("3");
  });

  it("omits the count badge when there are no backlinks", () => {
    // Mutation: rendering `0` instead of hiding would clutter every
    // doc that doesn't have inbound refs — most docs in a typical
    // workspace.
    const { baseElement } = render(() => (
      <TocPanel {...BASE_PROPS} backlinksCount={0} />
    ));
    expect(baseElement.querySelector(".toc-panel-tab-count")).toBeNull();
  });

  it("renders distinct section headers per pane (TABLE OF CONTENTS / BACKLINKS)", () => {
    // Mutation: collapsing the per-pane section headers into a
    // single shared header would lose the action-button isolation
    // (TOC's gear menu must apply only to the TOC tree).
    const { baseElement } = render(() => (
      <TocPanel {...BASE_PROPS} backlinksSlot={<div>x</div>} />
    ));
    const tocPane = baseElement.querySelector('[data-pane="toc"]')!;
    const blPane = baseElement.querySelector('[data-pane="backlinks"]')!;
    expect(tocPane.querySelector(".toc-panel-section-title")).not.toBeNull();
    expect(blPane.querySelector(".toc-panel-section-title")).not.toBeNull();
    expect(tocPane.querySelector('[aria-label="TOC options"]')).not.toBeNull();
    // Backlinks pane must NOT carry the TOC options trigger — that
    // gear targets only TOC behaviour.
    expect(blPane.querySelector('[aria-label="TOC options"]')).toBeNull();
  });
});
