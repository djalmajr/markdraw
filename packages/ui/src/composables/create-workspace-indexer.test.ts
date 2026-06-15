import { describe, expect, it } from "bun:test";
import {
  createWorkspaceIndexer,
  type IndexSyncInput,
  type WorkspaceIndexerDeps,
} from "./create-workspace-indexer.ts";

function makeDeps(over: Partial<WorkspaceIndexerDeps> = {}) {
  const synced: IndexSyncInput[] = [];
  const removed: { root: string; paths: string[] }[] = [];
  const dropped: string[] = [];
  const deps: WorkspaceIndexerDeps = {
    getRoots: () => ["/root"],
    listSupportedFiles: async () => [{ path: "a.md", mtime: 1 }],
    readFile: async (_r, p) => (p === "a.md" ? "# Title\nhello world" : ""),
    computeSha: async (c) => `sha:${c.length}`,
    staleness: async (_r, entries) => ({ needsReindex: entries.map((e) => e.path), staleInIndex: [] }),
    sync: async (i) => {
      synced.push(i);
    },
    remove: async (root, paths) => {
      removed.push({ root, paths });
    },
    dropRoot: async (root) => {
      dropped.push(root);
    },
    getTier: () => "lite",
    getEmbedding: () => null,
    ...over,
  };
  return { deps, synced, removed, dropped };
}

describe("createWorkspaceIndexer", () => {
  it("indexes changed files (lite) with chunked content and a title", async () => {
    const { deps, synced } = makeDeps();
    await createWorkspaceIndexer(deps).reindexRoot("/root");
    expect(synced).toHaveLength(1);
    expect(synced[0]!.path).toBe("a.md");
    expect(synced[0]!.title).toBe("Title");
    expect(synced[0]!.chunks.length).toBeGreaterThan(0);
    expect(synced[0]!.vectors).toBeUndefined();
  });

  it("removes stale docs reported by staleness", async () => {
    const { deps, removed } = makeDeps({
      staleness: async () => ({ needsReindex: [], staleInIndex: ["old.md"] }),
    });
    await createWorkspaceIndexer(deps).reindexRoot("/root");
    expect(removed).toEqual([{ root: "/root", paths: ["old.md"] }]);
  });

  it("embeds in full tier and attaches vectors + embedding meta", async () => {
    const meta = { provider: "openai", model: "m", dim: 3 };
    let embedCalls = 0;
    const { deps, synced } = makeDeps({
      getTier: () => "full",
      getEmbedding: () => ({
        meta,
        embed: async (texts) => {
          embedCalls++;
          return texts.map(() => [0.1, 0.2, 0.3]);
        },
      }),
    });
    await createWorkspaceIndexer(deps).reindexRoot("/root");
    expect(embedCalls).toBe(1);
    expect(synced[0]!.embedding).toEqual(meta);
    expect(synced[0]!.vectors?.length).toBe(synced[0]!.chunks.length);
  });

  it("degrades to keyword-only when embedding throws", async () => {
    const { deps, synced } = makeDeps({
      getTier: () => "full",
      getEmbedding: () => ({
        meta: { provider: "p", model: "m", dim: 3 },
        embed: async () => {
          throw new Error("no net");
        },
      }),
    });
    await createWorkspaceIndexer(deps).reindexRoot("/root");
    expect(synced[0]!.vectors).toBeUndefined();
    expect(synced[0]!.embedding).toBeUndefined();
  });

  it("rebuilds the root on an embedding-mismatch error then retries", async () => {
    const meta = { provider: "openai", model: "m2", dim: 3 };
    let syncCalls = 0;
    const { deps, dropped } = makeDeps({
      getTier: () => "full",
      getEmbedding: () => ({ meta, embed: async (t) => t.map(() => [1, 0, 0]) }),
      sync: async () => {
        syncCalls++;
        if (syncCalls === 1) throw new Error("embedding-mismatch: stored a != incoming b");
      },
    });
    await createWorkspaceIndexer(deps).reindexRoot("/root");
    expect(dropped).toEqual(["/root"]);
    expect(syncCalls).toBe(2);
  });

  it("reindexFile removes a file that no longer exists", async () => {
    const { deps, removed } = makeDeps({
      readFile: async () => {
        throw new Error("ENOENT");
      },
    });
    await createWorkspaceIndexer(deps).reindexFile("/root", "gone.md");
    expect(removed).toEqual([{ root: "/root", paths: ["gone.md"] }]);
  });

  it("does nothing when tier is off", async () => {
    const { deps, synced } = makeDeps({ getTier: () => "off" });
    await createWorkspaceIndexer(deps).reindexAll();
    expect(synced).toHaveLength(0);
  });
});
