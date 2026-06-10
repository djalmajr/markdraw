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

const readTool = (deps: InProcessToolDeps) =>
  buildInProcessTools(deps).find((t) => t.name === "app__read_active_doc")!;

describe("app__read_active_doc tool", () => {
  const OUTLINE = 'Excalidraw scene — 2 elements in flow.excalidraw:\n- Rectangle "Login"\n- Rectangle "API"';

  it("serves the scene outline + an excalidraw note when a diagram is active", async () => {
    // Mutation: skipping the outline dep would hand the model the empty editor
    // buffer — it would "read" an open diagram as a blank document.
    const { deps } = depsWithExcalidrawSpy();
    deps.getActiveDocPath = () => "/w/flow.excalidraw";
    deps.getActiveExcalidrawOutline = async () => OUTLINE;
    const res = await readTool(deps).execute({});
    expect(res).toEqual({
      content: OUTLINE,
      kind: "excalidraw",
      note: expect.stringContaining("app__excalidraw_write"),
      path: "/w/flow.excalidraw",
    });
  });

  it("still flags an active .excalidraw when the outline is unavailable (frame not ready)", async () => {
    const { deps } = depsWithExcalidrawSpy();
    deps.getActiveDocPath = () => "/w/flow.excalidraw";
    deps.getActiveExcalidrawOutline = async () => null;
    const res = await readTool(deps).execute({});
    expect(res).toEqual({
      content: "",
      kind: "excalidraw",
      note: expect.stringContaining("Excalidraw diagram"),
      path: "/w/flow.excalidraw",
    });
  });

  it("keeps the plain text path unchanged for documents (no note, no kind)", async () => {
    const { deps } = depsWithExcalidrawSpy();
    deps.getActiveDoc = () => "# hello";
    deps.getActiveDocPath = () => "/w/notes.md";
    deps.getActiveExcalidrawOutline = async () => null;
    const res = await readTool(deps).execute({});
    expect(res).toEqual({ path: "/w/notes.md", content: "# hello" });
  });

  it("works without the optional outline dep (non-Excalidraw hosts)", async () => {
    const { deps } = depsWithExcalidrawSpy();
    deps.getActiveDoc = () => "body";
    deps.getActiveDocPath = () => "/w/a.md";
    const res = await readTool(deps).execute({});
    expect(res).toEqual({ path: "/w/a.md", content: "body" });
  });
});

/** Deps with an in-memory fs bridge spy for the creation/read tools. */
function depsWithFsSpy() {
  const calls: { op: string; args: string[] }[] = [];
  const files = new Map<string, string>();
  const { deps } = depsWithExcalidrawSpy();
  deps.getWorkspaceRoots = () => ["/ws"];
  deps.fs = {
    createDir: async (root, rel) => {
      calls.push({ op: "createDir", args: [root, rel] });
    },
    createFile: async (root, rel) => {
      calls.push({ op: "createFile", args: [root, rel] });
      if (files.has(rel)) throw new Error(`"${rel}" already exists`);
      files.set(rel, "");
    },
    readFileRelative: async (_root, rel) => files.get(rel) ?? null,
    writeFileAbs: async (abs, content) => {
      calls.push({ op: "writeFileAbs", args: [abs, content] });
    },
  };
  return { calls, deps, files };
}

const toolByName = (deps: InProcessToolDeps, name: string) =>
  buildInProcessTools(deps).find((t) => t.name === name)!;

describe("filesystem tools (app__read_file / app__create_*)", () => {
  it("are offered only when the fs bridge is present", () => {
    const { deps } = depsWithExcalidrawSpy(); // no fs
    const names = buildInProcessTools(deps).map((t) => t.name);
    expect(names).not.toContain("app__create_file");
    const { deps: withFs } = depsWithFsSpy();
    expect(buildInProcessTools(withFs).map((t) => t.name)).toContain("app__create_file");
  });

  // The write tools MUST be prompt-gated (human approval) while reads auto-run.
  it("declares prompt approval on creation tools and none on read", () => {
    const { deps } = depsWithFsSpy();
    expect(toolByName(deps, "app__create_file").approval).toBe("prompt");
    expect(toolByName(deps, "app__create_folder").approval).toBe("prompt");
    expect(toolByName(deps, "app__read_file").approval).toBeUndefined();
  });

  it("creates a file and writes its content through the root-joined path", async () => {
    const { calls, deps } = depsWithFsSpy();
    const res = await toolByName(deps, "app__create_file").execute({
      content: "# hi",
      path: "notes/a.md",
    });
    expect(res).toEqual({ status: "created", path: "notes/a.md", bytes: 4 });
    expect(calls).toEqual([
      { op: "createFile", args: ["/ws", "notes/a.md"] },
      { op: "writeFileAbs", args: ["/ws/notes/a.md", "# hi"] },
    ]);
  });

  it("refuses overwrite with an instructional message (no write happens)", async () => {
    const { calls, deps, files } = depsWithFsSpy();
    files.set("a.md", "old");
    const res = (await toolByName(deps, "app__create_file").execute({ path: "a.md" })) as {
      status: string;
      message: string;
    };
    expect(res.status).toBe("error");
    expect(res.message).toContain("already exists");
    expect(calls.filter((c) => c.op === "writeFileAbs")).toHaveLength(0);
  });

  it("creates folders and reads files back (missing file is instructional)", async () => {
    const { deps, files } = depsWithFsSpy();
    expect(await toolByName(deps, "app__create_folder").execute({ path: "drafts" })).toEqual({
      status: "created",
      path: "drafts",
    });
    files.set("readme.md", "content");
    expect(await toolByName(deps, "app__read_file").execute({ path: "readme.md" })).toEqual({
      content: "content",
      path: "readme.md",
    });
    const missing = (await toolByName(deps, "app__read_file").execute({ path: "ghost.md" })) as {
      status: string;
      message: string;
    };
    expect(missing.status).toBe("error");
    expect(missing.message).toContain("app__list_files");
  });

  it("errors cleanly when no workspace is open", async () => {
    const { deps } = depsWithFsSpy();
    deps.getWorkspaceRoots = () => [];
    const res = (await toolByName(deps, "app__create_file").execute({ path: "a.md" })) as {
      status: string;
    };
    expect(res.status).toBe("error");
  });
});
