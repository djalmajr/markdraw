import { describe, expect, it, mock } from "bun:test";
import { restoreSecrets, scrubSecrets } from "@markdraw/ai/secret-scrub.ts";
import {
  buildInProcessTools,
  resolveWorkspacePath,
  rootNamesFor,
  type ExcalidrawGenerateRequest,
  type ExcalidrawMermaidRequest,
  type InProcessToolDeps,
  type PlanToolItem,
} from "./ai-tools.ts";
import type { ExcalidrawWriteResult } from "../components/excalidraw-frame.tsx";

/** Per-test handler behind the chaos-invoke mock (app__list_files and
 *  app__search_workspace go through `invoke`, not the fs bridge). Tests that
 *  exercise those tools install a handler; everything else never invokes. */
let invokeHandler: (cmd: string, args: Record<string, unknown>) => Promise<unknown> = async (
  cmd,
) => {
  throw new Error(`unexpected invoke of "${cmd}" — install an invokeHandler in the test`);
};

mock.module("./chaos-invoke.ts", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeHandler(cmd, args ?? {}),
}));

/** A deps stub that records the last excalidraw-write call and returns a canned
 *  ok result, so we can assert how the tool normalizes the model's arguments. */
function depsWithExcalidrawSpy() {
  const calls: ExcalidrawMermaidRequest[] = [];
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

describe("app__excalidraw_write path targeting", () => {
  const MERMAID = "flowchart TD\n A-->B";

  it("no path → the dep receives no target and the payload is unchanged", async () => {
    // Mutation: synthesizing a target for a path-less call would flip the host
    // into the open/create flow for what must stay the active-diagram write.
    const { deps, calls } = depsWithExcalidrawSpy();
    const res = await writeTool(deps).execute({ mermaid: MERMAID });
    expect(calls[0]?.target).toBeUndefined();
    // No `path` echo either — exactly today's result shape.
    expect(res).toEqual({ ok: true, mode: "append", added: 1, removed: 0 });
  });

  it("a blank path behaves as no path", async () => {
    const { deps, calls } = depsWithExcalidrawSpy();
    await writeTool(deps).execute({ mermaid: MERMAID, path: "   " });
    expect(calls[0]?.target).toBeUndefined();
  });

  it("rejects a non-.excalidraw path before touching the dep", async () => {
    const { deps, calls } = depsWithExcalidrawSpy();
    deps.getWorkspaceRoots = () => ["/ws"];
    const res = (await writeTool(deps).execute({ mermaid: MERMAID, path: "docs/diagram.md" })) as {
      ok: boolean;
      error: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toContain(".excalidraw");
    expect(calls).toHaveLength(0);
  });

  it("accepts the extension case-insensitively and resolves a single-root path", async () => {
    const { deps, calls } = depsWithExcalidrawSpy();
    deps.getWorkspaceRoots = () => ["/ws"];
    await writeTool(deps).execute({ mermaid: MERMAID, path: "diagrams/Login.EXCALIDRAW" });
    expect(calls[0]?.target).toEqual({
      absPath: "/ws/diagrams/Login.EXCALIDRAW",
      rel: "diagrams/Login.EXCALIDRAW",
      root: "/ws",
    });
  });

  it("resolves a root-qualified multi-root path into the dep's target and echoes the path", async () => {
    const { deps, calls } = depsWithExcalidrawSpy();
    deps.getWorkspaceRoots = () => ["/x/alpha", "/x/beta"];
    const res = await writeTool(deps).execute({
      mermaid: MERMAID,
      mode: "replace-all",
      path: "beta/diagrams/login.excalidraw",
    });
    expect(calls[0]).toEqual({
      mermaid: MERMAID,
      mode: "replace-all",
      target: {
        absPath: "/x/beta/diagrams/login.excalidraw",
        rel: "diagrams/login.excalidraw",
        root: "/x/beta",
      },
    });
    expect(res).toEqual({
      ok: true,
      mode: "replace-all",
      added: 1,
      removed: 0,
      path: "beta/diagrams/login.excalidraw",
    });
  });

  it("multi root: an unknown root errors instructively without calling the dep", async () => {
    const { deps, calls } = depsWithExcalidrawSpy();
    deps.getWorkspaceRoots = () => ["/x/alpha", "/x/beta"];
    const res = (await writeTool(deps).execute({
      mermaid: MERMAID,
      path: "ghost/login.excalidraw",
    })) as { ok: boolean; error: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("alpha/, beta/");
    expect(calls).toHaveLength(0);
  });

  it("no workspace open + path errors instructively without calling the dep", async () => {
    const { deps, calls } = depsWithExcalidrawSpy(); // getWorkspaceRoots → []
    const res = (await writeTool(deps).execute({
      mermaid: MERMAID,
      path: "login.excalidraw",
    })) as { ok: boolean; error: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("No workspace is open");
    expect(calls).toHaveLength(0);
  });

  it("forwards the host's file outcome alongside the echoed path", async () => {
    // The host reports created/opened on targeted writes; the tool must not
    // strip that payload on its way back to the model.
    const { deps } = depsWithExcalidrawSpy();
    deps.getWorkspaceRoots = () => ["/ws"];
    deps.applyExcalidrawMermaid = async (input) => ({
      ok: true,
      mode: input.mode,
      added: 3,
      removed: 0,
      file: { created: true, opened: true, path: input.target?.absPath ?? "" },
    });
    const res = await writeTool(deps).execute({ mermaid: MERMAID, path: "new.excalidraw" });
    expect(res).toEqual({
      ok: true,
      mode: "append",
      added: 3,
      removed: 0,
      file: { created: true, opened: true, path: "/ws/new.excalidraw" },
      path: "new.excalidraw",
    });
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

describe("app__edit_file tool", () => {
  it("is prompt-gated and replaces the single occurrence", async () => {
    const { calls, deps, files } = depsWithFsSpy();
    files.set("doc.md", "# Title\nold line\nend");
    const tool = toolByName(deps, "app__edit_file");
    expect(tool.approval).toBe("prompt");
    const res = await tool.execute({ find: "old line", path: "doc.md", replace: "new line" });
    expect(res).toEqual({ path: "doc.md", replacements: 1, status: "edited" });
    expect(calls.at(-1)).toEqual({
      op: "writeFileAbs",
      args: ["/ws/doc.md", "# Title\nnew line\nend"],
    });
  });

  it("no-match is instructional and points at a near miss (casing)", async () => {
    const { deps, files } = depsWithFsSpy();
    files.set("doc.md", "alpha\nBeta Line\ngamma");
    const res = (await toolByName(deps, "app__edit_file").execute({
      find: "beta line",
      path: "doc.md",
      replace: "x",
    })) as { status: string; message: string };
    expect(res.status).toBe("error");
    expect(res.message).toContain("line 2");
    expect(res.message).toContain("app__read_file");
  });

  it("refuses an ambiguous find without all:true, replaces all with it", async () => {
    const { calls, deps, files } = depsWithFsSpy();
    files.set("doc.md", "x ho x ho x");
    const tool = toolByName(deps, "app__edit_file");
    const ambiguous = (await tool.execute({ find: "x", path: "doc.md", replace: "y" })) as {
      status: string;
      message: string;
    };
    expect(ambiguous.status).toBe("error");
    expect(ambiguous.message).toContain("3 places");
    const res = await tool.execute({ all: true, find: "x", path: "doc.md", replace: "y" });
    expect(res).toEqual({ path: "doc.md", replacements: 3, status: "edited" });
    expect(calls.at(-1)?.args[1]).toBe("y ho y ho y");
  });

  it("missing file points the model at discovery/creation tools", async () => {
    const { deps } = depsWithFsSpy();
    const res = (await toolByName(deps, "app__edit_file").execute({
      find: "a",
      path: "ghost.md",
      replace: "b",
    })) as { status: string; message: string };
    expect(res.status).toBe("error");
    expect(res.message).toContain("app__create_file");
  });
});

describe("app__read_file ranged + numbered reads", () => {
  it("slices the line range BEFORE the 50k cap, so paging reaches deep into huge files", async () => {
    // Mutation: capping first and slicing after would make every line past
    // ~50k chars unreachable — the whole point of startLine/endLine paging.
    const { deps, files } = depsWithFsSpy();
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1} ${"x".repeat(30)}`);
    files.set("big.md", lines.join("\n")); // ~120k chars
    const tool = toolByName(deps, "app__read_file");
    const full = (await tool.execute({ path: "big.md" })) as { truncated?: boolean };
    expect(full.truncated).toBe(true); // legacy whole-file read still caps
    const ranged = await tool.execute({ endLine: 2902, path: "big.md", startLine: 2900 });
    expect(ranged).toEqual({
      content: `${lines[2899]}\n${lines[2900]}\n${lines[2901]}`,
      endLine: 2902,
      path: "big.md",
      startLine: 2900,
      totalLines: 3000,
    });
  });

  it("numbers lines as 'N→' and reports totalLines for paging", async () => {
    const { deps, files } = depsWithFsSpy();
    files.set("doc.md", "alpha\nbravo\ncharlie");
    const res = await toolByName(deps, "app__read_file").execute({
      endLine: 3,
      numbered: true,
      path: "doc.md",
      startLine: 2,
    });
    expect(res).toEqual({
      content: "2→bravo\n3→charlie",
      endLine: 3,
      path: "doc.md",
      startLine: 2,
      totalLines: 3,
    });
  });

  it("numbered without a range covers the whole file", async () => {
    const { deps, files } = depsWithFsSpy();
    files.set("doc.md", "a\nb");
    const res = await toolByName(deps, "app__read_file").execute({ numbered: true, path: "doc.md" });
    expect(res).toEqual({
      content: "1→a\n2→b",
      endLine: 2,
      path: "doc.md",
      startLine: 1,
      totalLines: 2,
    });
  });

  it("still caps a ranged read whose slice alone exceeds 50k chars", async () => {
    const { deps, files } = depsWithFsSpy();
    files.set("big.md", "y".repeat(60_000)); // a single huge line
    const res = (await toolByName(deps, "app__read_file").execute({
      endLine: 1,
      path: "big.md",
      startLine: 1,
    })) as { content: string; truncated?: boolean };
    expect(res.truncated).toBe(true);
    expect(res.content).toHaveLength(50_000);
  });

  it("clamps an out-of-range request and says so in a note", async () => {
    const { deps, files } = depsWithFsSpy();
    files.set("doc.md", "a\nb\nc");
    const res = await toolByName(deps, "app__read_file").execute({
      endLine: 20,
      path: "doc.md",
      startLine: 10,
    });
    expect(res).toEqual({
      content: "c",
      endLine: 3,
      note: expect.stringContaining("3 lines"),
      path: "doc.md",
      startLine: 3,
      totalLines: 3,
    });
  });
});

describe("app__edit_file line-anchored edits", () => {
  it("applies a single verified hunk", async () => {
    const { calls, deps, files } = depsWithFsSpy();
    files.set("doc.md", "l1\nl2\nl3");
    const res = await toolByName(deps, "app__edit_file").execute({
      edits: [{ endLine: 2, expectedText: "l2", replace: "L2", startLine: 2 }],
      path: "doc.md",
    });
    expect(res).toEqual({ path: "doc.md", replacements: 1, status: "edited" });
    expect(calls.at(-1)).toEqual({ op: "writeFileAbs", args: ["/ws/doc.md", "l1\nL2\nl3"] });
  });

  it("applies multiple hunks bottom-up so the read line numbers stay valid", async () => {
    // Mutation: applying top-down would shift the second hunk after the first
    // splice changes the line count — hunk 5-5 would land on the wrong line.
    const { calls, deps, files } = depsWithFsSpy();
    files.set("doc.md", "a\nb\nc\nd\ne\nf");
    const res = await toolByName(deps, "app__edit_file").execute({
      edits: [
        { endLine: 2, expectedText: "a\nb", replace: "AB", startLine: 1 },
        { endLine: 5, expectedText: "e", replace: "E1\nE2", startLine: 5 },
      ],
      path: "doc.md",
    });
    expect(res).toEqual({ path: "doc.md", replacements: 2, status: "edited" });
    expect(calls.at(-1)).toEqual({ op: "writeFileAbs", args: ["/ws/doc.md", "AB\nc\nd\nE1\nE2\nf"] });
  });

  it("deletes the range when a hunk's replace is empty", async () => {
    const { calls, deps, files } = depsWithFsSpy();
    files.set("doc.md", "keep\ndrop\nkeep2");
    await toolByName(deps, "app__edit_file").execute({
      edits: [{ endLine: 2, expectedText: "drop", replace: "", startLine: 2 }],
      path: "doc.md",
    });
    expect(calls.at(-1)).toEqual({ op: "writeFileAbs", args: ["/ws/doc.md", "keep\nkeep2"] });
  });

  it("rejects a stale anchor naming the first differing line, pointing at a numbered re-read", async () => {
    const { calls, deps, files } = depsWithFsSpy();
    files.set("doc.md", "a\nb\nc");
    const res = (await toolByName(deps, "app__edit_file").execute({
      edits: [{ endLine: 3, expectedText: "b\nWRONG", replace: "x", startLine: 2 }],
      path: "doc.md",
    })) as { status: string; message: string };
    expect(res.status).toBe("error");
    expect(res.message).toContain("line 3"); // line 2 matched; 3 is the first diff
    expect(res.message).toContain("numbered");
    expect(calls.filter((c) => c.op === "writeFileAbs")).toHaveLength(0);
  });

  it("rejects overlapping hunks before touching the file", async () => {
    const { calls, deps, files } = depsWithFsSpy();
    files.set("doc.md", "a\nb\nc\nd\ne");
    const res = (await toolByName(deps, "app__edit_file").execute({
      edits: [
        { endLine: 3, expectedText: "a\nb\nc", replace: "x", startLine: 1 },
        { endLine: 4, expectedText: "c\nd", replace: "y", startLine: 3 },
      ],
      path: "doc.md",
    })) as { status: string; message: string };
    expect(res.status).toBe("error");
    expect(res.message).toContain("overlap");
    expect(calls.filter((c) => c.op === "writeFileAbs")).toHaveLength(0);
  });

  it("rejects a hunk past the end of the file with an instructional message", async () => {
    const { deps, files } = depsWithFsSpy();
    files.set("doc.md", "a\nb");
    const res = (await toolByName(deps, "app__edit_file").execute({
      edits: [{ endLine: 5, expectedText: "b", replace: "x", startLine: 2 }],
      path: "doc.md",
    })) as { status: string; message: string };
    expect(res.status).toBe("error");
    expect(res.message).toContain("2 lines");
    expect(res.message).toContain("app__read_file");
  });

  it("matches expectedText against CRLF files (trailing \\r normalized) and keeps CRLF on write", async () => {
    // Mutation: comparing raw lines would make every CRLF file a permanent
    // "stale anchor" — the model writes expectedText with plain \n.
    const { calls, deps, files } = depsWithFsSpy();
    files.set("doc.md", "l1\r\nl2\r\nl3");
    const res = await toolByName(deps, "app__edit_file").execute({
      edits: [{ endLine: 2, expectedText: "l2", replace: "L2", startLine: 2 }],
      path: "doc.md",
    });
    expect(res).toEqual({ path: "doc.md", replacements: 1, status: "edited" });
    expect(calls.at(-1)).toEqual({ op: "writeFileAbs", args: ["/ws/doc.md", "l1\r\nL2\r\nl3"] });
  });

  it("ignores find/replace when edits is present", async () => {
    const { calls, deps, files } = depsWithFsSpy();
    files.set("doc.md", "a\nb");
    const res = await toolByName(deps, "app__edit_file").execute({
      edits: [{ endLine: 1, expectedText: "a", replace: "A", startLine: 1 }],
      find: "b",
      path: "doc.md",
      replace: "ZZZ",
    });
    expect(res).toEqual({ path: "doc.md", replacements: 1, status: "edited" });
    expect(calls.at(-1)).toEqual({ op: "writeFileAbs", args: ["/ws/doc.md", "A\nb"] });
  });
});

/** Deps mirroring the desktop's secret-scrub wiring (omp#5): the fs bridge
 *  scrubs reads through a session map and restoreSecretsIn maps placeholders
 *  the model echoes back to the real values. */
function depsWithScrubbingFs() {
  const { calls, deps, files } = depsWithFsSpy();
  const secretMap = new Map<string, string>();
  const rawRead = deps.fs!.readFileRelative;
  deps.fs = {
    ...deps.fs!,
    readFileRelative: async (root, rel) => {
      const content = await rawRead(root, rel);
      return content === null ? null : scrubSecrets(content, secretMap).text;
    },
  };
  deps.restoreSecretsIn = (s) => restoreSecrets(s, secretMap);
  return { calls, deps, files, secretMap };
}

/** The placeholder a scrub assigned to `secret`. Tests derive it from the map
 *  instead of hardcoding the format — the nonce is random per map. */
function placeholderFor(secretMap: Map<string, string>, secret: string): string {
  for (const [placeholder, value] of secretMap) {
    if (value === secret) return placeholder;
  }
  throw new Error("secret was not scrubbed");
}

describe("secret scrubbing round-trip (restoreSecretsIn)", () => {
  const SECRET = "sk-w7a4JDfGvnZklepfHyg1unjtehDPpY0b";

  it("app__read_file serves placeholders, and app__edit_file matches via restore", async () => {
    // Round-trip: scrub on read produces a placeholder; the model echoes the
    // placeholder in `find`; restore makes it match the REAL file content —
    // and the write lands real values, never placeholders.
    const { calls, deps, files, secretMap } = depsWithScrubbingFs();
    files.set("env.md", `key: ${SECRET}\nrest`);
    const read = (await toolByName(deps, "app__read_file").execute({ path: "env.md" })) as {
      content: string;
    };
    const ph = placeholderFor(secretMap, SECRET);
    expect(read.content).toBe(`key: ${ph}\nrest`);
    const res = await toolByName(deps, "app__edit_file").execute({
      find: `key: ${ph}`,
      path: "env.md",
      replace: `token: ${ph}`,
    });
    expect(res).toEqual({ path: "env.md", replacements: 1, status: "edited" });
    expect(calls.at(-1)).toEqual({
      op: "writeFileAbs",
      args: [`/ws/env.md`, `token: ${SECRET}\nrest`],
    });
  });

  it("app__edit_file line-anchored hunks anchor on the scrubbed text; the write restores", async () => {
    const { calls, deps, files, secretMap } = depsWithScrubbingFs();
    files.set("env.md", `a\nkey: ${SECRET}\nc`);
    // A prior read populated the map (the model can only know the placeholder).
    await toolByName(deps, "app__read_file").execute({ numbered: true, path: "env.md" });
    const ph = placeholderFor(secretMap, SECRET);
    const res = await toolByName(deps, "app__edit_file").execute({
      edits: [
        { endLine: 2, expectedText: `key: ${ph}`, replace: `token: ${ph}`, startLine: 2 },
      ],
      path: "env.md",
    });
    expect(res).toEqual({ path: "env.md", replacements: 1, status: "edited" });
    expect(calls.at(-1)).toEqual({
      op: "writeFileAbs",
      args: [`/ws/env.md`, `a\ntoken: ${SECRET}\nc`],
    });
  });

  // A 3-line PEM block scrubs into ONE placeholder line, so scrubbed and real
  // line numbers diverge below it. Numbered reads serve scrubbed coordinates;
  // the edit must verify/splice in the SAME system or every hunk at/below the
  // secret fails as a "stale anchor" — or worse, lands on the wrong real line.
  const PEM =
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";

  it("a hunk below a multiline PEM secret applies to the intended line", async () => {
    const { calls, deps, files, secretMap } = depsWithScrubbingFs();
    files.set("key.md", `intro\n${PEM}\nmiddle\ntarget\noutro`);
    const read = (await toolByName(deps, "app__read_file").execute({
      numbered: true,
      path: "key.md",
    })) as { content: string; totalLines: number };
    // 7 real lines collapse to 5 scrubbed lines — the model anchors on these.
    expect(read.totalLines).toBe(5);
    expect(read.content).toBe(
      `1→intro\n2→${placeholderFor(secretMap, PEM)}\n3→middle\n4→target\n5→outro`,
    );
    const res = await toolByName(deps, "app__edit_file").execute({
      edits: [{ endLine: 4, expectedText: "target", replace: "TARGET", startLine: 4 }],
      path: "key.md",
    });
    expect(res).toEqual({ path: "key.md", replacements: 1, status: "edited" });
    expect(calls.at(-1)).toEqual({
      op: "writeFileAbs",
      args: [`/ws/key.md`, `intro\n${PEM}\nmiddle\nTARGET\noutro`],
    });
  });

  it("a hunk over the placeholder line itself is applicable (deletes the real block)", async () => {
    const { calls, deps, files, secretMap } = depsWithScrubbingFs();
    files.set("key.md", `before\n${PEM}\nafter`);
    await toolByName(deps, "app__read_file").execute({ numbered: true, path: "key.md" });
    const res = await toolByName(deps, "app__edit_file").execute({
      edits: [
        { endLine: 2, expectedText: placeholderFor(secretMap, PEM), replace: "", startLine: 2 },
      ],
      path: "key.md",
    });
    expect(res).toEqual({ path: "key.md", replacements: 1, status: "edited" });
    expect(calls.at(-1)).toEqual({ op: "writeFileAbs", args: [`/ws/key.md`, "before\nafter"] });
  });

  it("app__create_file writes restored content", async () => {
    const { calls, deps, files, secretMap } = depsWithScrubbingFs();
    // The placeholder exists because the model read a scrubbed file earlier.
    files.set("env.md", `key: ${SECRET}`);
    await toolByName(deps, "app__read_file").execute({ path: "env.md" });
    const res = await toolByName(deps, "app__create_file").execute({
      content: `copied: ${placeholderFor(secretMap, SECRET)}`,
      path: "copy.md",
    });
    expect(res).toEqual({ status: "created", path: "copy.md", bytes: `copied: ${SECRET}`.length });
    expect(calls.at(-1)).toEqual({
      op: "writeFileAbs",
      args: [`/ws/copy.md`, `copied: ${SECRET}`],
    });
  });

  it("default behavior is unchanged when the dep is absent (placeholders pass through)", async () => {
    const { calls, deps, files } = depsWithFsSpy(); // no scrubbing, no restore
    files.set("doc.md", "plain [secret-1] text");
    const res = await toolByName(deps, "app__edit_file").execute({
      find: "[secret-1]",
      path: "doc.md",
      replace: "x",
    });
    expect(res).toEqual({ path: "doc.md", replacements: 1, status: "edited" });
    expect(calls.at(-1)).toEqual({ op: "writeFileAbs", args: ["/ws/doc.md", "plain x text"] });
  });
});

/** Deps with a plan spy: records every updatePlan call (the full item list,
 *  or null for a clear) so we can assert exactly what reaches the host. */
function depsWithPlanSpy() {
  const planCalls: Array<PlanToolItem[] | null> = [];
  const { deps } = depsWithExcalidrawSpy();
  deps.updatePlan = (items) => {
    planCalls.push(items);
  };
  return { deps, planCalls };
}

describe("app__update_plan tool", () => {
  it("is offered only when the updatePlan dep is present", () => {
    // Mutation: registering it unconditionally would offer a tool whose
    // execute crashes on hosts (the extension) that have no plan surface.
    const { deps } = depsWithExcalidrawSpy(); // no updatePlan
    expect(buildInProcessTools(deps).map((t) => t.name)).not.toContain("app__update_plan");
    const { deps: withPlan } = depsWithPlanSpy();
    expect(buildInProcessTools(withPlan).map((t) => t.name)).toContain("app__update_plan");
  });

  it("declares no approval (source app → auto): it only mutates UI state", () => {
    const { deps } = depsWithPlanSpy();
    const tool = toolByName(deps, "app__update_plan");
    expect(tool.source).toBe("app");
    expect(tool.approval).toBeUndefined();
    expect(tool.inputSchema).toMatchObject({ required: ["items"] });
  });

  it("replaces the plan with the full (trimmed) item list and reports the count", async () => {
    const { deps, planCalls } = depsWithPlanSpy();
    const res = await toolByName(deps, "app__update_plan").execute({
      items: [
        { done: true, text: "Read the brief" },
        { done: false, text: "  Draft the outline  " },
      ],
    });
    expect(res).toEqual({ status: "ok", itemCount: 2 });
    expect(planCalls).toEqual([
      [
        { done: true, text: "Read the brief" },
        { done: false, text: "Draft the outline" },
      ],
    ]);
  });

  it("an empty items array clears the plan (dep receives null)", async () => {
    // Mutation: passing [] through would render an empty husk of a card
    // instead of removing it.
    const { deps, planCalls } = depsWithPlanSpy();
    const res = await toolByName(deps, "app__update_plan").execute({ items: [] });
    expect(res).toEqual({ status: "ok", itemCount: 0 });
    expect(planCalls).toEqual([null]);
  });

  it("caps the plan at 30 items with an instructional error (state untouched)", async () => {
    const { deps, planCalls } = depsWithPlanSpy();
    const items = Array.from({ length: 31 }, (_, i) => ({ done: false, text: `step ${i + 1}` }));
    const res = (await toolByName(deps, "app__update_plan").execute({ items })) as {
      status: string;
      message: string;
    };
    expect(res.status).toBe("error");
    expect(res.message).toContain("30");
    expect(planCalls).toHaveLength(0);
    // Exactly the cap still passes.
    const ok = await toolByName(deps, "app__update_plan").execute({ items: items.slice(0, 30) });
    expect(ok).toEqual({ status: "ok", itemCount: 30 });
  });

  it("malformed input gets an instructive error naming the expected shape", async () => {
    const { deps, planCalls } = depsWithPlanSpy();
    const tool = toolByName(deps, "app__update_plan");
    const badPayloads: unknown[] = [
      {}, // items missing
      { items: "not an array" },
      { items: [{ done: "yes", text: "step" }] }, // done not a boolean
      { items: [{ done: true, text: "   " }] }, // text blank
      { items: [{ done: true }] }, // text missing
    ];
    for (const bad of badPayloads) {
      const res = (await tool.execute(bad)) as { status: string; message: string };
      expect(res.status).toBe("error");
      expect(res.message).toMatch(/done|items/);
    }
    expect(planCalls).toHaveLength(0);
  });
});

describe("rootNamesFor / resolveWorkspacePath (pure resolver)", () => {
  it("names roots by basename, in open order, suffixing collisions", () => {
    expect(rootNamesFor(["/a/notes", "C:\\work\\docs\\", "/b/notes"])).toEqual([
      { name: "notes", path: "/a/notes" },
      { name: "docs", path: "C:\\work\\docs\\" },
      { name: "notes-2", path: "/b/notes" },
    ]);
  });

  it("errors when no root is open", () => {
    expect(resolveWorkspacePath([], "a.md")).toEqual({ error: "No workspace is open." });
  });

  it("single root: passes the path through unchanged", () => {
    expect(resolveWorkspacePath(["/ws"], "docs/a.md")).toEqual({
      rel: "docs/a.md",
      root: { name: "ws", path: "/ws" },
    });
  });

  it("single root: a root-name prefix is NOT stripped — the literal path wins", () => {
    // Mutation: stripping here would redirect every path under a real
    // top-level folder named like the root (root 'notes' containing
    // 'notes/') — reads AND writes would land one level up from where the
    // model addressed them, invisibly to both the approving user and the
    // model (each only ever sees the echoed path).
    expect(resolveWorkspacePath(["/ws"], "ws/a.md")).toEqual({
      rel: "ws/a.md",
      root: { name: "ws", path: "/ws" },
    });
  });

  it("single root: a bare path equal to the root name stays a plain file path", () => {
    expect(resolveWorkspacePath(["/ws"], "ws")).toEqual({
      rel: "ws",
      root: { name: "ws", path: "/ws" },
    });
  });

  it("multi root: the first segment selects the root, the remainder stays relative", () => {
    expect(resolveWorkspacePath(["/x/a", "/x/b"], "b/docs/y.md")).toEqual({
      rel: "docs/y.md",
      root: { name: "b", path: "/x/b" },
    });
  });

  it("multi root: an unknown first segment lists the open root names", () => {
    expect(resolveWorkspacePath(["/x/a", "/x/b"], "notes.md")).toEqual({
      error: expect.stringContaining("Multiple workspaces are open: a/, b/."),
    });
    expect(resolveWorkspacePath(["/x/a", "/x/b"], "ghost/notes.md")).toEqual({
      error: expect.stringContaining("Prefix the path with the workspace name"),
    });
  });

  it("multi root: a bare root name is not a file", () => {
    expect(resolveWorkspacePath(["/x/a", "/x/b"], "b")).toEqual({
      error: expect.stringContaining("names a workspace root"),
    });
  });

  it("multi root: collision suffixes resolve by open order", () => {
    expect(resolveWorkspacePath(["/x/docs", "/y/docs"], "docs-2/a.md")).toEqual({
      rel: "a.md",
      root: { name: "docs-2", path: "/y/docs" },
    });
  });
});

/** Two-root deps: files are keyed per root so a path resolved against the
 *  wrong root reads as missing instead of silently passing. */
function depsWithTwoRootFs(roots: string[] = ["/ws/alpha", "/ws/beta"]) {
  const calls: { op: string; args: string[] }[] = [];
  const files = new Map<string, string>(); // keyed "<rootAbs>/<rel>"
  const { deps } = depsWithExcalidrawSpy();
  deps.getWorkspaceRoots = () => roots;
  deps.fs = {
    createDir: async (root, rel) => {
      calls.push({ op: "createDir", args: [root, rel] });
    },
    createFile: async (root, rel) => {
      calls.push({ op: "createFile", args: [root, rel] });
      const key = `${root}/${rel}`;
      if (files.has(key)) throw new Error(`"${rel}" already exists`);
      files.set(key, "");
    },
    readFileRelative: async (root, rel) => files.get(`${root}/${rel}`) ?? null,
    writeFileAbs: async (abs, content) => {
      calls.push({ op: "writeFileAbs", args: [abs, content] });
    },
  };
  return { calls, deps, files };
}

describe("multi-root filesystem tools (root-qualified paths)", () => {
  it("app__read_file resolves the first segment to the named root", async () => {
    const { deps, files } = depsWithTwoRootFs();
    files.set("/ws/alpha/readme.md", "alpha copy");
    files.set("/ws/beta/readme.md", "beta copy");
    const tool = toolByName(deps, "app__read_file");
    expect(await tool.execute({ path: "alpha/readme.md" })).toEqual({
      content: "alpha copy",
      path: "alpha/readme.md",
    });
    expect(await tool.execute({ path: "beta/readme.md" })).toEqual({
      content: "beta copy",
      path: "beta/readme.md",
    });
  });

  it("an unqualified path gets an instructive error naming the open roots", async () => {
    // Mutation: falling back to roots[0] would silently read the WRONG file
    // whenever both workspaces hold the same name.
    const { deps, files } = depsWithTwoRootFs();
    files.set("/ws/alpha/readme.md", "alpha copy");
    const res = await toolByName(deps, "app__read_file").execute({ path: "readme.md" });
    expect(res).toEqual({
      status: "error",
      message: expect.stringContaining("Multiple workspaces are open: alpha/, beta/."),
    });
  });

  it("a bare root name errors instead of reading the root as a file", async () => {
    const { deps } = depsWithTwoRootFs();
    const res = await toolByName(deps, "app__read_file").execute({ path: "beta" });
    expect(res).toEqual({
      status: "error",
      message: expect.stringContaining("names a workspace root"),
    });
  });

  it("app__create_file creates inside the named root and writes through its joined path", async () => {
    const { calls, deps } = depsWithTwoRootFs();
    const res = await toolByName(deps, "app__create_file").execute({
      content: "# hi",
      path: "beta/notes/new.md",
    });
    expect(res).toEqual({ status: "created", path: "beta/notes/new.md", bytes: 4 });
    expect(calls).toEqual([
      { op: "createFile", args: ["/ws/beta", "notes/new.md"] },
      { op: "writeFileAbs", args: ["/ws/beta/notes/new.md", "# hi"] },
    ]);
  });

  it("app__create_folder resolves the root and passes the remainder to the bridge", async () => {
    const { calls, deps } = depsWithTwoRootFs();
    const res = await toolByName(deps, "app__create_folder").execute({ path: "alpha/drafts/q2" });
    expect(res).toEqual({ status: "created", path: "alpha/drafts/q2" });
    expect(calls).toEqual([{ op: "createDir", args: ["/ws/alpha", "drafts/q2"] }]);
  });

  it("app__edit_file edits the file inside the named root", async () => {
    const { calls, deps, files } = depsWithTwoRootFs();
    files.set("/ws/beta/doc.md", "old text here");
    const res = await toolByName(deps, "app__edit_file").execute({
      find: "old",
      path: "beta/doc.md",
      replace: "new",
    });
    expect(res).toEqual({ path: "beta/doc.md", replacements: 1, status: "edited" });
    expect(calls.at(-1)).toEqual({
      op: "writeFileAbs",
      args: ["/ws/beta/doc.md", "new text here"],
    });
  });

  it("app__create_* and app__edit_file reject an unknown root instructively", async () => {
    const { calls, deps } = depsWithTwoRootFs();
    const attempts: Promise<unknown>[] = [
      toolByName(deps, "app__create_file").execute({ path: "ghost/a.md" }),
      toolByName(deps, "app__create_folder").execute({ path: "ghost/dir" }),
      toolByName(deps, "app__edit_file").execute({ find: "a", path: "ghost/a.md", replace: "b" }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res).toEqual({
        status: "error",
        message: expect.stringContaining("alpha/, beta/"),
      });
    }
    expect(calls).toHaveLength(0);
  });

  it("basename collisions get -2 suffixes that resolve by open order", async () => {
    const { deps, files } = depsWithTwoRootFs(["/x/docs", "/y/docs"]);
    files.set("/x/docs/a.md", "first");
    files.set("/y/docs/a.md", "second");
    const tool = toolByName(deps, "app__read_file");
    expect(await tool.execute({ path: "docs/a.md" })).toEqual({
      content: "first",
      path: "docs/a.md",
    });
    expect(await tool.execute({ path: "docs-2/a.md" })).toEqual({
      content: "second",
      path: "docs-2/a.md",
    });
  });

  it("single root: reads serve the literal path when it exists — no prefix strip", async () => {
    // Root "/ws" really containing a top-level folder "ws/": stripping would
    // silently read the wrong file.
    const { deps, files } = depsWithFsSpy(); // single root "/ws"
    files.set("ws/readme.md", "nested copy");
    files.set("readme.md", "top-level copy");
    const res = await toolByName(deps, "app__read_file").execute({ path: "ws/readme.md" });
    expect(res).toEqual({ content: "nested copy", path: "ws/readme.md" });
  });

  it("single root: a root-name prefix falls back (stripped) ONLY when the literal read misses", async () => {
    // Back-compat: the model learned the multi-root namespace and the other
    // roots have since closed — reads tolerate the stale prefix.
    const { deps, files } = depsWithFsSpy(); // single root "/ws"
    files.set("readme.md", "content");
    const res = await toolByName(deps, "app__read_file").execute({ path: "ws/readme.md" });
    expect(res).toEqual({ content: "content", path: "ws/readme.md" });
  });

  it("single root: app__edit_file's fallback writes back the file it actually read", async () => {
    // Mutation: writing through the literal (missing) rel after a fallback
    // read would create a phantom '/ws/ws/doc.md' instead of editing in place.
    const { calls, deps, files } = depsWithFsSpy(); // single root "/ws"
    files.set("doc.md", "old text");
    const res = await toolByName(deps, "app__edit_file").execute({
      find: "old",
      path: "ws/doc.md",
      replace: "new",
    });
    expect(res).toEqual({ path: "ws/doc.md", replacements: 1, status: "edited" });
    expect(calls.at(-1)).toEqual({ op: "writeFileAbs", args: ["/ws/doc.md", "new text"] });
  });

  it("single root: creates never strip the prefix — they land exactly where addressed", async () => {
    const { calls, deps } = depsWithFsSpy(); // single root "/ws"
    const res = await toolByName(deps, "app__create_file").execute({ path: "ws/new.md" });
    expect(res).toEqual({ status: "created", path: "ws/new.md", bytes: 0 });
    expect(calls).toEqual([{ op: "createFile", args: ["/ws", "ws/new.md"] }]);
  });
});

describe("app__list_files / app__search_workspace across roots", () => {
  it("list aggregates every root, prefixing entries and naming the roots", async () => {
    const { deps } = depsWithExcalidrawSpy();
    deps.getWorkspaceRoots = () => ["/ws/alpha", "/ws/beta"];
    invokeHandler = async (cmd, args) => {
      expect(cmd).toBe("read_dir");
      return args.path === "/ws/alpha"
        ? [{ name: "a.md", kind: "file", path: "a.md" }]
        : [{ name: "docs", kind: "directory", path: "docs" }];
    };
    const res = await toolByName(deps, "app__list_files").execute({});
    expect(res).toEqual({
      entries: [
        { name: "a.md", kind: "file", path: "alpha/a.md" },
        { name: "docs", kind: "directory", path: "beta/docs" },
      ],
      roots: ["alpha", "beta"],
    });
  });

  it("list keeps today's single-root shape (root field, unprefixed paths)", async () => {
    const { deps } = depsWithExcalidrawSpy();
    deps.getWorkspaceRoots = () => ["/ws"];
    invokeHandler = async () => [{ name: "a.md", kind: "file", path: "a.md" }];
    const res = await toolByName(deps, "app__list_files").execute({});
    expect(res).toEqual({
      root: "/ws",
      entries: [{ name: "a.md", kind: "file", path: "a.md" }],
    });
  });

  it("search merges every root's matches with prefixed paths", async () => {
    const { deps } = depsWithExcalidrawSpy();
    deps.getWorkspaceRoots = () => ["/ws/alpha", "/ws/beta"];
    invokeHandler = async (cmd, args) => {
      expect(cmd).toBe("find_in_files");
      return args.root === "/ws/alpha"
        ? [{ path: "a.md", line_number: 3, line_text: "hit A" }]
        : [{ path: "sub/b.md", line_number: 7, line_text: "hit B" }];
    };
    const res = await toolByName(deps, "app__search_workspace").execute({ query: "hit" });
    expect(res).toEqual({
      matches: [
        { path: "alpha/a.md", line: 3, text: "hit A" },
        { path: "beta/sub/b.md", line: 7, text: "hit B" },
      ],
      truncated: false,
    });
  });

  it("search keeps today's single-root shape (unprefixed paths)", async () => {
    const { deps } = depsWithExcalidrawSpy();
    deps.getWorkspaceRoots = () => ["/ws"];
    invokeHandler = async () => [{ path: "a.md", line_number: 1, line_text: "hit" }];
    const res = await toolByName(deps, "app__search_workspace").execute({ query: "hit" });
    expect(res).toEqual({
      matches: [{ path: "a.md", line: 1, text: "hit" }],
      truncated: false,
    });
  });

  it("search caps the MERGED list at 50 and flags truncation", async () => {
    // Mutation: capping per root would let two roots return up to 100 matches.
    const { deps } = depsWithExcalidrawSpy();
    deps.getWorkspaceRoots = () => ["/ws/alpha", "/ws/beta"];
    invokeHandler = async () =>
      Array.from({ length: 30 }, (_, i) => ({
        path: `f${i}.md`,
        line_number: i + 1,
        line_text: "x",
      }));
    const mk = (rootName: string, i: number) => ({
      path: `${rootName}/f${i}.md`,
      line: i + 1,
      text: "x",
    });
    const res = await toolByName(deps, "app__search_workspace").execute({ query: "x" });
    expect(res).toEqual({
      matches: [
        ...Array.from({ length: 30 }, (_, i) => mk("alpha", i)),
        ...Array.from({ length: 20 }, (_, i) => mk("beta", i)),
      ],
      truncated: true,
    });
  });
});

/** Deps stub that records spec-generation calls and returns a canned ok result,
 *  with a single workspace root so paths resolve literally. */
function depsWithGenerateSpy() {
  const calls: ExcalidrawGenerateRequest[] = [];
  const deps: InProcessToolDeps = {
    getActiveDoc: () => "",
    getActiveDocPath: () => null,
    getWorkspaceRoots: () => ["/ws"],
    proposeEdit: async () => "noop",
    applyExcalidrawMermaid: async (input) => ({ ok: true, mode: input.mode, added: 0, removed: 0 }),
    generateExcalidrawDiagram: async (input) => {
      calls.push(input);
      return { ok: true, elements: 3, file: { created: true, opened: true, path: input.target.absPath } };
    },
  };
  return { deps, calls };
}

const genTool = (deps: InProcessToolDeps) =>
  buildInProcessTools(deps).find((t) => t.name === "app__excalidraw_generate");

const sampleSpec = {
  nodes: [
    { id: "a", lane: "l", title: "A" },
    { id: "b", lane: "r", title: "B" },
  ],
  edges: [{ from: "a", to: "b" }],
};

describe("app__excalidraw_generate tool", () => {
  it("is offered only when the generate dep is provided", () => {
    const { deps } = depsWithGenerateSpy();
    expect(genTool(deps)).toBeDefined();
    const without: InProcessToolDeps = {
      getActiveDoc: () => "",
      getActiveDocPath: () => null,
      getWorkspaceRoots: () => [],
      proposeEdit: async () => "noop",
      applyExcalidrawMermaid: async (i) => ({ ok: true, mode: i.mode, added: 0, removed: 0 }),
    };
    expect(genTool(without)).toBeUndefined();
  });

  it("requires a spec object without touching the dep", async () => {
    const { deps, calls } = depsWithGenerateSpy();
    const res = (await genTool(deps)!.execute({ path: "d/x.excalidraw" })) as { ok: boolean };
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("rejects a path that is not a .excalidraw file", async () => {
    const { deps, calls } = depsWithGenerateSpy();
    const res = (await genTool(deps)!.execute({ spec: sampleSpec, path: "notes.md" })) as {
      ok: boolean;
      error?: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toContain(".excalidraw");
    expect(calls).toHaveLength(0);
  });

  it("resolves the target, defaults mode to replace-all, and forwards the spec", async () => {
    const { deps, calls } = depsWithGenerateSpy();
    const res = (await genTool(deps)!.execute({ spec: sampleSpec, path: "diagrams/arch.excalidraw" })) as {
      ok: boolean;
      path?: string;
    };
    expect(res.ok).toBe(true);
    expect(res.path).toBe("diagrams/arch.excalidraw");
    expect(calls).toHaveLength(1);
    expect(calls[0].mode).toBe("replace-all");
    expect(calls[0].target).toEqual({
      absPath: "/ws/diagrams/arch.excalidraw",
      rel: "diagrams/arch.excalidraw",
      root: "/ws",
    });
    expect(calls[0].spec).toEqual(sampleSpec);
  });

  it("honors an explicit append mode", async () => {
    const { deps, calls } = depsWithGenerateSpy();
    await genTool(deps)!.execute({ spec: sampleSpec, path: "x.excalidraw", mode: "append" });
    expect(calls[0].mode).toBe("append");
  });
});
