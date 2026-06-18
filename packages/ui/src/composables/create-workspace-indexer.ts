// Workspace indexer (DJA-15): enumerate → diff by sha → chunk → embed (Full) →
// push to the per-root Rust index. Dependency-injected (the host wires the
// Tauri ai_index_* commands, file IO, and the embedding provider) so packages/ui
// stays Tauri-free and the whole thing is unit-testable; the extension, which
// has no real filesystem, simply never constructs it.

import { chunkDocument } from "@markdraw/core/index-chunking.ts";

export type IndexingTier = "off" | "lite" | "full";

export interface EmbeddingMeta {
  provider: string;
  model: string;
  dim: number;
}

interface ChunkInput {
  ord: number;
  heading: string;
  headingLevel: number;
  startLine: number;
  text: string;
}

export interface IndexSyncInput {
  rootPath: string;
  path: string;
  sha: string;
  mtime: number;
  title: string;
  chunks: ChunkInput[];
  vectors?: number[][];
  embedding?: EmbeddingMeta;
}

/** Minimal embedding surface — the host passes the configured provider's embed. */
export interface EmbeddingSource {
  embed: (texts: string[]) => Promise<number[][]>;
  meta: EmbeddingMeta;
}

export interface WorkspaceIndexerDeps {
  /** Absolute paths of the open workspace roots. */
  getRoots: () => string[];
  /** Supported (.md/.adoc) files in a root, as root-relative paths + mtime (ms). */
  listSupportedFiles: (root: string) => Promise<{ path: string; mtime: number }[]>;
  readFile: (root: string, path: string) => Promise<string>;
  /** Content hash (e.g. SHA-256 hex via WebCrypto). */
  computeSha: (content: string) => Promise<string>;
  // ── injected ai_index_* IPC ──
  staleness: (
    root: string,
    entries: { path: string; sha: string }[],
  ) => Promise<{ needsReindex: string[]; staleInIndex: string[] }>;
  sync: (input: IndexSyncInput) => Promise<void>;
  remove: (root: string, paths: string[]) => Promise<void>;
  dropRoot: (root: string) => Promise<void>;
  // ── tier + embeddings ──
  getTier: () => IndexingTier;
  /** The configured embedding provider/meta, or null when none is selected
   *  (Full unavailable → the run silently stays keyword-only). */
  getEmbedding: () => EmbeddingSource | null;
  log?: (msg: string) => void;
}

const MAX_CONCURRENCY = 4;

function basename(path: string): string {
  const seg = path.split("/").pop() ?? path;
  return seg;
}

/** Build the text fed to the embedder for a chunk: prefix the heading path so a
 *  short section still carries its context ("Guide > Auth\n<body>"). */
function embeddingInput(headingPath: string, text: string): string {
  return headingPath ? `${headingPath}\n${text}` : text;
}

export function createWorkspaceIndexer(deps: WorkspaceIndexerDeps) {
  const log = (m: string) => deps.log?.(`[indexer] ${m}`);

  async function processFile(root: string, path: string, content: string, sha: string, mtime: number): Promise<void> {
    const chunks = chunkDocument(path, content);
    if (chunks.length === 0) {
      // Empty file: drop any stale index rows for it.
      await deps.remove(root, [path]).catch(() => {});
      return;
    }
    const title = chunks.find((c) => c.headingLevel === 1)?.heading || basename(path);
    const chunkInputs: ChunkInput[] = chunks.map((c) => ({
      ord: c.index,
      heading: c.heading,
      headingLevel: c.headingLevel,
      startLine: c.startLine,
      text: c.text,
    }));

    let vectors: number[][] | undefined;
    let embedding: EmbeddingMeta | undefined;
    if (deps.getTier() === "full") {
      const source = deps.getEmbedding();
      if (source) {
        try {
          vectors = await source.embed(chunks.map((c) => embeddingInput(c.headingPath, c.text)));
          embedding = source.meta;
        } catch (e) {
          // Embedding failed → degrade to keyword-only for this file, never block.
          log(`embed failed for ${path}: ${e instanceof Error ? e.message : String(e)}`);
          vectors = undefined;
          embedding = undefined;
        }
      }
    }

    try {
      await deps.sync({ rootPath: root, path, sha, mtime, title, chunks: chunkInputs, vectors, embedding });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // The embedding model changed under the index → wipe and rebuild this root.
      if (msg.includes("embedding-mismatch")) {
        log(`embedding model changed; rebuilding ${root}`);
        await deps.dropRoot(root);
        await deps.sync({ rootPath: root, path, sha, mtime, title, chunks: chunkInputs, vectors, embedding });
      } else {
        throw e;
      }
    }
  }

  async function runPool<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
    let i = 0;
    const next = async (): Promise<void> => {
      while (i < items.length) {
        const item = items[i++]!;
        await worker(item);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, items.length) }, () => next()));
  }

  /** Index one root: diff by sha, drop removed docs, (re)index changed ones. */
  async function reindexRoot(root: string): Promise<void> {
    if (deps.getTier() === "off") return;
    const files = await deps.listSupportedFiles(root);
    // Read + hash every file (needed for the sha staleness diff). Content is
    // kept so changed files don't get read twice.
    const entries = await Promise.all(
      files.map(async (f) => {
        const content = await deps.readFile(root, f.path);
        return { path: f.path, mtime: f.mtime, content, sha: await deps.computeSha(content) };
      }),
    );
    const byPath = new Map(entries.map((e) => [e.path, e]));
    const { needsReindex, staleInIndex } = await deps.staleness(
      root,
      entries.map((e) => ({ path: e.path, sha: e.sha })),
    );
    if (staleInIndex.length > 0) await deps.remove(root, staleInIndex);
    log(`${root}: ${needsReindex.length} to index, ${staleInIndex.length} stale`);
    await runPool(needsReindex, async (path) => {
      const e = byPath.get(path);
      if (e) await processFile(root, path, e.content, e.sha, e.mtime);
    });
  }

  /** Index every open root (workspace open / tier change). */
  async function reindexAll(): Promise<void> {
    if (deps.getTier() === "off") return;
    for (const root of deps.getRoots()) {
      await reindexRoot(root).catch((e) => log(`reindex ${root} failed: ${e}`));
    }
  }

  /** Re-index a single file after an edit (debounced by the host). */
  async function reindexFile(root: string, path: string): Promise<void> {
    if (deps.getTier() === "off") return;
    let content: string;
    try {
      content = await deps.readFile(root, path);
    } catch {
      // File gone → remove it from the index.
      await deps.remove(root, [path]).catch(() => {});
      return;
    }
    const sha = await deps.computeSha(content);
    let mtime = 0;
    try {
      mtime = (await deps.listSupportedFiles(root)).find((f) => f.path === path)?.mtime ?? 0;
    } catch {
      /* mtime is best-effort */
    }
    await processFile(root, path, content, sha, mtime);
  }

  return { reindexAll, reindexRoot, reindexFile };
}
