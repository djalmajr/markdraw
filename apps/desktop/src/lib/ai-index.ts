// Tauri IPC wrappers for the per-root workspace index (ai_index.rs). Single
// chokepoint for the `ai_index_*` command contract: the orchestrator and the
// search dispatch call these, never `invoke` directly, so a command rename
// touches one file. Shapes mirror the Rust request/response structs (camelCase).

import { invoke } from "./chaos-invoke.ts";

export type IndexTier = "lite" | "full";

export interface EmbeddingMeta {
  provider: string;
  model: string;
  dim: number;
}

/** A heading-aware chunk to index (from @markdraw/core chunkDocument). */
export interface IndexChunkInput {
  ord: number;
  heading: string;
  headingLevel: number;
  startLine: number;
  text: string;
}

export interface IndexStatus {
  exists: boolean;
  docCount: number;
  chunkCount: number;
  embeddedChunkCount: number;
  embedding: EmbeddingMeta | null;
  lastIndexedAt: number | null;
}

export interface StalenessEntry {
  path: string;
  sha: string;
}

export interface StalenessResult {
  needsReindex: string[];
  staleInIndex: string[];
}

export interface IndexHit {
  path: string;
  title: string;
  score: number;
  snippet: string;
  bestChunkHeading: string;
  bestChunkLine: number;
}

export interface IndexSyncInput {
  rootPath: string;
  path: string;
  sha: string;
  mtime: number;
  title: string;
  chunks: IndexChunkInput[];
  /** Parallel to `chunks` (Full only). Omit for keyword-only indexing. */
  vectors?: number[][];
  /** Required when `vectors` is present. */
  embedding?: EmbeddingMeta;
}

export interface IndexSearchInput {
  rootPath: string;
  query: string;
  tier: IndexTier;
  /** Unit-normalised query embedding; required for "full". */
  queryVector?: number[];
  embedding?: EmbeddingMeta;
  limit?: number;
}

/** Index stats for a root (does not create the DB if absent). */
export function aiIndexStatus(rootPath: string): Promise<IndexStatus> {
  return invoke<IndexStatus>("ai_index_status", { request: { rootPath } });
}

/** Diff on-disk {path, sha} against the index → what to reindex / drop. */
export function aiIndexStaleness(rootPath: string, entries: StalenessEntry[]): Promise<StalenessResult> {
  return invoke<StalenessResult>("ai_index_staleness", { request: { rootPath, entries } });
}

/** Upsert one document (+ its chunks, + optional vectors) into a root's index. */
export function aiIndexSync(input: IndexSyncInput): Promise<void> {
  return invoke<void>("ai_index_sync", { request: input });
}

/** Search a root's index (lite = keyword; full = keyword + vector via RRF). */
export function aiIndexSearch(input: IndexSearchInput): Promise<IndexHit[]> {
  return invoke<IndexHit[]>("ai_index_search", { request: input });
}

/** Delete specific docs, or (omit `paths`) drop the whole index for the root. */
export function aiIndexDelete(rootPath: string, paths?: string[]): Promise<void> {
  return invoke<void>("ai_index_delete", { request: { rootPath, paths } });
}
