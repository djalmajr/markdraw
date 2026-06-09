import { describe, expect, it } from "bun:test";
import { buildInProcessTools, type InProcessToolDeps } from "./ai-tools.ts";
import type { ExcalidrawWriteInput, ExcalidrawWriteResult } from "../components/excalidraw-frame.tsx";

/** A deps stub that records the last excalidraw-write call and returns a canned
 *  ok result, so we can assert how the tool normalizes the model's arguments. */
function depsWithExcalidrawSpy() {
  const calls: ExcalidrawWriteInput[] = [];
  const deps: InProcessToolDeps = {
    getActiveDoc: () => "",
    getActiveDocPath: () => null,
    getWorkspaceRoots: () => [],
    proposeEdit: async () => "noop",
    applyExcalidrawMermaid: async (input) => {
      calls.push(input);
      return { ok: true, mode: input.mode, added: 1, removed: 0 } satisfies ExcalidrawWriteResult;
    },
  };
  return { deps, calls };
}

const writeTool = (deps: InProcessToolDeps) =>
  buildInProcessTools(deps).find((t) => t.name === "app__excalidraw_write")!;

describe("app__excalidraw_write tool", () => {
  it("is registered with the app source", () => {
    const { deps } = depsWithExcalidrawSpy();
    const tool = writeTool(deps);
    expect(tool).toBeDefined();
    expect(tool.source).toBe("app");
    expect(tool.inputSchema).toMatchObject({ required: ["mermaid"] });
  });

  // Mutation: forwarding a blank diagram would hand Mermaid nothing to parse and
  // wipe/append an empty result; the guard must short-circuit BEFORE the dep.
  it("rejects a blank mermaid without touching the canvas", async () => {
    const { deps, calls } = depsWithExcalidrawSpy();
    const res = (await writeTool(deps).execute({ mermaid: "   " })) as ExcalidrawWriteResult;
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  // Mutation: dropping the default would pass `undefined` mode through to the
  // guest, which can't place the diagram.
  it("defaults a missing mode to append", async () => {
    const { deps, calls } = depsWithExcalidrawSpy();
    await writeTool(deps).execute({ mermaid: "flowchart TD\n A-->B" });
    expect(calls[0]?.mode).toBe("append");
  });

  // Mutation: trusting an arbitrary string would let the model send a mode the
  // guest doesn't understand; unknown values must fall back to append.
  it("coerces an unknown mode to append", async () => {
    const { deps, calls } = depsWithExcalidrawSpy();
    await writeTool(deps).execute({ mermaid: "flowchart TD\n A-->B", mode: "sideways" });
    expect(calls[0]?.mode).toBe("append");
  });

  it("passes a valid mode through verbatim and trims the mermaid", async () => {
    const { deps, calls } = depsWithExcalidrawSpy();
    await writeTool(deps).execute({ mermaid: "  flowchart TD\n A-->B  ", mode: "replace-selection" });
    expect(calls[0]?.mode).toBe("replace-selection");
    expect(calls[0]?.mermaid).toBe("flowchart TD\n A-->B");
  });
});
