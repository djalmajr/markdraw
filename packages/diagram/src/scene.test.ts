import { describe, expect, test } from "bun:test";
import { createCtx, rect } from "./factories.ts";
import { buildScene, sceneToFile } from "./scene.ts";

describe("scene serializer", () => {
  test("buildScene wraps elements in the canonical envelope", () => {
    const ctx = createCtx();
    const r = rect(ctx, 0, 0, 10, 10);
    const scene = buildScene({ elements: [r] });
    expect(scene.type).toBe("excalidraw");
    expect(scene.version).toBe(2);
    expect(scene.source).toBe("markdraw");
    expect(scene.elements).toHaveLength(1);
    expect(scene.appState).toEqual({});
    expect(scene.files).toEqual({});
  });

  test("source and appState are overridable; CLI can request pretty output", () => {
    const scene = buildScene({ elements: [], appState: { gridSize: null } }, { source: "docs" });
    expect(scene.source).toBe("docs");
    expect(scene.appState).toEqual({ gridSize: null });
    const pretty = sceneToFile({ elements: [] }, { source: "docs", pretty: true });
    expect(pretty).toContain("\n");
    expect(pretty).toContain('  "type": "excalidraw"');
  });

  test("default sceneToFile is compact and matches the desktop host envelope", () => {
    // Mirrors apps/desktop/src/components/excalidraw-frame.tsx sceneToFile:
    // compact JSON, source "markdraw", appState/elements/files passthrough.
    const out = sceneToFile({ appState: { foo: 1 }, elements: [], files: { a: 1 } });
    expect(out).toBe(
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: "markdraw",
        elements: [],
        appState: { foo: 1 },
        files: { a: 1 },
      }),
    );
  });

  test("round-trips through JSON.parse with a stable shape", () => {
    const ctx = createCtx();
    const scene = buildScene({ elements: [rect(ctx, 1, 2, 3, 4)] });
    const parsed = JSON.parse(sceneToFile(scene));
    expect(parsed.elements[0].type).toBe("rectangle");
    expect(parsed.elements[0].x).toBe(1);
  });
});
