import { describe, expect, it } from "bun:test";
import {
  fetchMediaBytes,
  hasDotComponent,
  mimeForPath,
  readConfinedBytes,
  routeMediaAsset,
  splitUnderRoots,
  type MediaAssetDeps,
} from "./media-asset.ts";

function makeDeps(bytes: Uint8Array = new Uint8Array([1, 2, 3])) {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const converted: string[] = [];
  const deps: MediaAssetDeps = {
    convertFileSrc: (p) => {
      converted.push(p);
      return `asset://localhost/${encodeURIComponent(p)}`;
    },
    invoke: (async (command: string, args: Record<string, unknown>) => {
      calls.push({ command, args });
      return bytes;
    }) as MediaAssetDeps["invoke"],
  };
  return { deps, calls, converted };
}

describe("hasDotComponent", () => {
  it("flags any dot-prefixed component, in the root or the relative part", () => {
    expect(hasDotComponent("/home/u/ws/.docs/img.png")).toBe(true);
    expect(hasDotComponent("/home/u/.notes/img.png")).toBe(true);
    expect(hasDotComponent("C:\\ws\\.docs\\img.png")).toBe(true);
    expect(hasDotComponent("/home/u/ws/.hidden.png")).toBe(true);
  });
  it("does not flag plain paths, dots inside names, `.` or `..`", () => {
    expect(hasDotComponent("/home/u/ws/docs/img.v2.png")).toBe(false);
    expect(hasDotComponent("/home/u/ws/./a/../b.png")).toBe(false);
  });
});

describe("routeMediaAsset", () => {
  it("keeps convertFileSrc for a path without dot components (no blob, no invoke)", () => {
    const { deps, calls, converted } = makeDeps();
    const route = routeMediaAsset("/home/u/ws", "docs/img.png", deps);
    expect(route.kind).toBe("asset");
    expect(converted).toEqual(["/home/u/ws/docs/img.png"]);
    expect(calls).toEqual([]);
  });

  it("routes a dot-folder file to a confined blob loader and never to convertFileSrc", async () => {
    const { deps, calls, converted } = makeDeps(new Uint8Array([9, 8, 7]));
    const route = routeMediaAsset("/home/u/ws", ".docs/img.png", deps);
    expect(route.kind).toBe("blob");
    expect(converted).toEqual([]);
    expect(calls).toEqual([]); // lazy: nothing read until the viewer asks
    if (route.kind !== "blob") throw new Error("unreachable");
    const blob = await route.load();
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
    expect(calls).toEqual([
      { command: "read_file_bytes_confined", args: { root: "/home/u/ws", relativePath: ".docs/img.png" } },
    ]);
  });

  it("routes by the root too: a root with a dot component uses the blob path", () => {
    const { deps } = makeDeps();
    expect(routeMediaAsset("/home/u/.notes", "img.png", deps).kind).toBe("blob");
  });

  it("types the blob by extension (pdf, svg) and falls back to octet-stream", async () => {
    const { deps } = makeDeps();
    for (const [name, mime] of [
      [".d/a.pdf", "application/pdf"],
      [".d/a.SVG", "image/svg+xml"],
      [".d/a.xyz", "application/octet-stream"],
    ] as const) {
      const route = routeMediaAsset("/ws", name, deps);
      if (route.kind !== "blob") throw new Error("unreachable");
      expect((await route.load()).type).toBe(mime);
    }
    expect(mimeForPath("noext")).toBe("application/octet-stream");
  });

  it("propagates a read failure from the command (code only, no path added)", async () => {
    const { deps } = makeDeps();
    deps.invoke = (async () => {
      throw { code: "not_allowed", message: "Path is not allowed" };
    }) as MediaAssetDeps["invoke"];
    const route = routeMediaAsset("/ws", ".d/a.png", deps);
    if (route.kind !== "blob") throw new Error("unreachable");
    await expect(route.load()).rejects.toEqual({ code: "not_allowed", message: "Path is not allowed" });
  });
});

describe("readConfinedBytes", () => {
  it("accepts ArrayBuffer and number[] payloads as well as Uint8Array", async () => {
    const { deps } = makeDeps();
    deps.invoke = (async () => new Uint8Array([5, 6]).buffer) as MediaAssetDeps["invoke"];
    expect(await readConfinedBytes("/ws", ".d/a", deps)).toEqual(new Uint8Array([5, 6]));
    deps.invoke = (async () => [7, 8]) as MediaAssetDeps["invoke"];
    expect(await readConfinedBytes("/ws", ".d/a", deps)).toEqual(new Uint8Array([7, 8]));
  });
});

describe("splitUnderRoots", () => {
  it("picks the longest opened root containing the path", () => {
    expect(splitUnderRoots("/a/b/.d/x.pdf", ["/a", "/a/b"])).toEqual({ root: "/a/b", relative: ".d/x.pdf" });
  });
  it("is null outside every root, for a sibling prefix and for the root itself", () => {
    expect(splitUnderRoots("/other/.d/x.pdf", ["/a"])).toBeNull();
    expect(splitUnderRoots("/ab/.d/x.pdf", ["/a"])).toBeNull();
    expect(splitUnderRoots("/a", ["/a"])).toBeNull();
  });
});

describe("fetchMediaBytes", () => {
  it("uses the confined command for a dot path inside an opened root", async () => {
    const { deps, calls, converted } = makeDeps(new Uint8Array([4, 2]));
    const fetchFn = async () => {
      throw new Error("must not fetch");
    };
    const bytes = await fetchMediaBytes("/ws/.docs/a.pdf", ["/ws"], fetchFn, deps);
    expect(bytes).toEqual(new Uint8Array([4, 2]));
    expect(converted).toEqual([]);
    expect(calls[0]).toEqual({
      command: "read_file_bytes_confined",
      args: { root: "/ws", relativePath: ".docs/a.pdf" },
    });
  });

  it("keeps the asset fetch for plain paths", async () => {
    const { deps, calls, converted } = makeDeps();
    const fetchFn = async (url: string) => {
      expect(url).toContain("asset://");
      return new Response(new Uint8Array([1, 1]));
    };
    const bytes = await fetchMediaBytes("/ws/docs/a.pdf", ["/ws"], fetchFn, deps);
    expect(bytes).toEqual(new Uint8Array([1, 1]));
    expect(converted).toEqual(["/ws/docs/a.pdf"]);
    expect(calls).toEqual([]);
  });

  it("outside every root a dot path keeps today's behavior (asset fetch, no confined read)", async () => {
    const { deps, calls, converted } = makeDeps();
    const fetchFn = async () => new Response("nope", { status: 403 });
    await expect(fetchMediaBytes("/etc/.ssh/id.pdf", ["/ws"], fetchFn, deps)).rejects.toThrow(
      "asset fetch failed (403)",
    );
    expect(converted).toEqual(["/etc/.ssh/id.pdf"]);
    expect(calls).toEqual([]);
  });
});
