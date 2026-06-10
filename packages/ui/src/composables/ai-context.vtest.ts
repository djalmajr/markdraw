import { describe, expect, it } from "vitest";
import {
  buildContextPreamble,
  excalidrawSceneToOutline,
  excalidrawSelectionToContext,
  type AiContextItem,
} from "./ai-context.ts";

const FILE = { name: "diagram.excalidraw", path: "/d/diagram.excalidraw" };
const selected = (...ids: string[]): Record<string, boolean> =>
  Object.fromEntries(ids.map((id) => [id, true]));

describe("buildContextPreamble", () => {
  it("returns undefined when there are no items (message unchanged)", () => {
    expect(buildContextPreamble([])).toBeUndefined();
  });

  it("wraps each item in a labelled context block", () => {
    const items: AiContextItem[] = [
      { id: "f1", kind: "file", label: "a.md", content: "hello" },
      { id: "s1", kind: "selection", label: "b.md:1-2", content: "world" },
    ];
    const out = buildContextPreamble(items)!;
    expect(out).toContain('<context kind="file" source="a.md">');
    expect(out).toContain("hello");
    expect(out).toContain('<context kind="selection" source="b.md:1-2">');
    expect(out).toContain("world");
  });

  it("wraps a folder item (a mentioned directory's subtree listing) with kind=\"folder\"", () => {
    const items: AiContextItem[] = [
      { id: "folder:r:src", kind: "folder", label: "src/", content: "- src/a.md\n- src/b.md" },
    ];
    const out = buildContextPreamble(items)!;
    expect(out).toContain('<context kind="folder" source="src/">');
    expect(out).toContain("- src/a.md");
  });

  it("escapes quotes in the source label", () => {
    const out = buildContextPreamble([{ id: "x", kind: "file", label: 'a"b.md', content: "c" }])!;
    expect(out).toContain("a&quot;b.md");
  });
});

describe("excalidrawSelectionToContext", () => {
  it("returns null when nothing is selected (⌘I stays a no-op)", () => {
    const scene = { appState: { selectedElementIds: {} }, elements: [{ id: "a", type: "rectangle", text: "X" }] };
    expect(excalidrawSelectionToContext(scene, FILE)).toBeNull();
    expect(excalidrawSelectionToContext(null, FILE)).toBeNull();
  });

  it("outlines selected shapes by type + text", () => {
    const scene = {
      appState: { selectedElementIds: selected("r1", "t1") },
      elements: [
        { id: "r1", type: "rectangle", text: undefined },
        { id: "t1", type: "text", text: "Hello" },
      ],
    };
    const item = excalidrawSelectionToContext(scene, FILE)!;
    expect(item.kind).toBe("selection");
    expect(item.content).toContain("Rectangle");
    expect(item.content).toContain('Text "Hello"');
    expect(item.content).toContain("2 elements");
  });

  it("describes arrows by the elements they connect (via bindings)", () => {
    const scene = {
      appState: { selectedElementIds: selected("a1") },
      elements: [
        { id: "b1", type: "rectangle", boundElements: [{ id: "lb1", type: "text" }] },
        { id: "lb1", type: "text", text: "Frontend" },
        { id: "b2", type: "rectangle", boundElements: [{ id: "lb2", type: "text" }] },
        { id: "lb2", type: "text", text: "API" },
        { id: "a1", type: "arrow", startBinding: { elementId: "b1" }, endBinding: { elementId: "b2" } },
      ],
    };
    // Mutation: ignoring bindings would lose the diagram's meaning (which box
    // connects to which) — the whole point of attaching a diagram selection.
    const item = excalidrawSelectionToContext(scene, FILE)!;
    expect(item.content).toContain('Arrow: "Frontend" → "API"');
  });

  it("skips deleted elements and uses a stable id", () => {
    const scene = {
      appState: { selectedElementIds: selected("r1", "gone") },
      elements: [
        { id: "r1", type: "rectangle", text: "Keep" },
        { id: "gone", type: "rectangle", text: "Dead", isDeleted: true },
      ],
    };
    const item = excalidrawSelectionToContext(scene, FILE)!;
    expect(item.content).toContain("1 element");
    expect(item.content).not.toContain("Dead");
    expect(item.id).toBe("excalidraw-selection:/d/diagram.excalidraw:r1");
  });
});

describe("excalidrawSceneToOutline", () => {
  it("outlines ALL live elements in the selection-chip style (shapes + arrow bindings)", () => {
    const scene = {
      appState: { selectedElementIds: {} }, // outline ignores selection — it reads the whole scene
      elements: [
        { id: "b1", type: "rectangle", boundElements: [{ id: "lb1", type: "text" }] },
        { id: "lb1", type: "text", text: "Login" },
        { id: "b2", type: "rectangle", boundElements: [{ id: "lb2", type: "text" }] },
        { id: "lb2", type: "text", text: "API" },
        { id: "a1", type: "arrow", startBinding: { elementId: "b1" }, endBinding: { elementId: "b2" } },
      ],
    };
    const out = excalidrawSceneToOutline(scene, "flow.excalidraw")!;
    expect(out).toContain("5 elements in flow.excalidraw");
    expect(out).toContain('Rectangle "Login"');
    expect(out).toContain('Arrow: "Login" → "API"');
  });

  it("returns null for an empty scene (caller signals 'nothing to read' instead of faking text)", () => {
    expect(excalidrawSceneToOutline(null, "d.excalidraw")).toBeNull();
    expect(excalidrawSceneToOutline({ elements: [] }, "d.excalidraw")).toBeNull();
    // Deleted elements don't count as content either.
    expect(
      excalidrawSceneToOutline(
        { elements: [{ id: "x", type: "rectangle", isDeleted: true }] },
        "d.excalidraw",
      ),
    ).toBeNull();
  });

  it("caps the outline at 200 elements with a '(+N more)' tail", () => {
    // Mutation: dropping the cap would let a huge canvas blow the prompt budget;
    // dropping the tail would silently hide that elements were omitted.
    const elements = Array.from({ length: 205 }, (_, i) => ({
      id: `r${i}`,
      type: "rectangle",
      text: undefined,
    }));
    const out = excalidrawSceneToOutline({ elements }, "big.excalidraw")!;
    const lines = out.split("\n");
    expect(out).toContain("205 elements");
    expect(lines).toHaveLength(1 + 200 + 1); // header + capped list + tail
    expect(lines.at(-1)).toBe("- (+5 more)");
  });
});
