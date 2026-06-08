import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
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
describe("TocPanel — strip + chat panes", () => {
  it("renders one strip tab per entry the host passes in `tabs`", () => {
    const { baseElement } = render(() => (
      <TocPanel
        {...BASE_PROPS}
        onNewChat={() => {}}
        tabs={[
          { id: "toc", kind: "toc", title: "Outline" },
          { id: "s1", kind: "chat", title: "Chat 1" },
          { id: "s2", kind: "chat", title: "Chat 2" },
        ]}
      />
    ));
    expect(baseElement.querySelectorAll(".rp-tab")).toHaveLength(3);
    expect(baseElement.querySelector('[data-rp-tab="toc"]')).not.toBeNull();
  });

  it("mounts the chat pane only when a chat tab is active", () => {
    // No active chat tab → the chat pane is unmounted (no imperative DOM
    // contract, so mount/unmount is safe).
    const { baseElement } = render(() => (
      <TocPanel {...BASE_PROPS} aiSlot={<div class="ai-test-slot">AI</div>} />
    ));
    expect(baseElement.querySelector('[data-pane="ai"]')).toBeNull();
  });

  it("renders the AI slot in the chat pane when a chat tab is active", () => {
    const { baseElement } = render(() => (
      <TocPanel
        {...BASE_PROPS}
        activeTab="chat:s1"
        onActiveTabChange={() => {}}
        tabs={[{ id: "s1", kind: "chat", title: "Chat 1" }]}
        aiSlot={<div class="ai-test-slot">AI</div>}
      />
    ));
    expect(baseElement.querySelector('[data-pane="ai"]')).not.toBeNull();
    expect(baseElement.querySelector(".ai-test-slot")).not.toBeNull();
    // The TOC + backlinks panes stay mounted-but-hidden.
    expect(baseElement.querySelector('[data-pane="toc"]')!.hasAttribute("hidden")).toBe(true);
    expect(baseElement.querySelector(".toc-panel-tree")).not.toBeNull();
  });

  it("hides the + control when AI is not wired (no onNewChat)", () => {
    const { baseElement } = render(() => <TocPanel {...BASE_PROPS} />);
    expect(baseElement.querySelector('[aria-label="New chat"]')).toBeNull();
  });
});

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

describe("TocPanel — References via overflow + mounted panes", () => {
  // Opens the strip's "…" overflow (kobalte DropdownMenu opens on the pointer
  // sequence, not a bare click).
  function openOverflow(baseElement: HTMLElement) {
    const trigger = baseElement.querySelector('[aria-label="More options"]')!;
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(trigger);
  }

  it("hides both special panes by default; fronts Outline when its tab is active", () => {
    const { baseElement, unmount } = render(() => (
      <TocPanel {...BASE_PROPS} backlinksSlot={<div data-testid="bl">x</div>} />
    ));
    // No active tab (AI-first default lives in app-state) → specials hidden.
    expect(baseElement.querySelector('[data-pane="toc"]')!.hasAttribute("hidden")).toBe(true);
    expect(baseElement.querySelector('[data-pane="backlinks"]')!.hasAttribute("hidden")).toBe(true);
    unmount();
    const { baseElement: b2 } = render(() => (
      <TocPanel {...BASE_PROPS} activeTab="toc" onActiveTabChange={() => {}} />
    ));
    expect(b2.querySelector('[data-pane="toc"]')!.hasAttribute("hidden")).toBe(false);
  });

  it("the overflow offers Outline and References as openers", () => {
    const { baseElement } = render(() => <TocPanel {...BASE_PROPS} backlinksCount={2} onOpenSpecial={() => {}} />);
    openOverflow(baseElement);
    expect(screen.getByText(/^outline$|^estrutura$|^esquema$/i)).not.toBeNull();
    expect(screen.getByText(/references|referências|referencias/i)).not.toBeNull();
  });

  it("fronts the backlinks pane when References is selected, keeping TOC mounted", () => {
    const { baseElement } = render(() => (
      <TocPanel
        {...BASE_PROPS}
        activeTab="backlinks"
        onActiveTabChange={() => {}}
        backlinksSlot={<div data-testid="bl">x</div>}
      />
    ));
    expect(baseElement.querySelector('[data-pane="toc"]')!.hasAttribute("hidden")).toBe(true);
    expect(baseElement.querySelector('[data-pane="backlinks"]')!.hasAttribute("hidden")).toBe(false);
    // Regression: Preview moves `#toc` into the tree via contentRef — the TOC
    // pane must stay mounted even when References is fronted.
    expect(baseElement.querySelector(".toc-panel-tree")).not.toBeNull();
  });

  it("offers References in the overflow with the backlinks count", () => {
    const { baseElement } = render(() => <TocPanel {...BASE_PROPS} backlinksCount={3} />);
    openOverflow(baseElement);
    expect(screen.getByText(/references|referências|referencias/i)).not.toBeNull();
    expect(baseElement.querySelector(".rp-overflow-count")!.textContent).toBe("3");
  });

  it("shows TOC depth options in the overflow only on the Outline tab", () => {
    const { baseElement, unmount } = render(() => (
      <TocPanel {...BASE_PROPS} activeTab="toc" onActiveTabChange={() => {}} />
    ));
    openOverflow(baseElement);
    expect(screen.queryByText(/expand all|expandir|expandir/i)).not.toBeNull();
    unmount();
    // On a chat tab the TOC depth controls drop out; References remains.
    const { baseElement: b2 } = render(() => (
      <TocPanel
        {...BASE_PROPS}
        activeTab="chat:s1"
        onActiveTabChange={() => {}}
        tabs={[{ id: "s1", kind: "chat", title: "C1" }]}
      />
    ));
    openOverflow(b2);
    expect(screen.queryByText(/expand all|expandir/i)).toBeNull();
    expect(screen.getByText(/references|referências|referencias/i)).not.toBeNull();
  });

  it("renders the backlinks section header", () => {
    const { baseElement } = render(() => (
      <TocPanel {...BASE_PROPS} backlinksSlot={<div>x</div>} />
    ));
    const blPane = baseElement.querySelector('[data-pane="backlinks"]')!;
    expect(blPane.querySelector(".toc-panel-section-title")).not.toBeNull();
  });
});
