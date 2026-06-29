//! Per-root workspace index: SQLite FTS5 (keyword / "Fast") + packed-f32 vector
//! embeddings fused with Reciprocal Rank Fusion ("Complete"). Embeddings are
//! produced in JS by the configured AI provider and handed here as vectors —
//! Rust never calls an embedding API and never reads workspace files. One
//! SQLite file per workspace root, under the app data dir.
//!
//! Schema + the FTS5 query sanitizer + the RRF/cosine approach are adapted from
//! ai-memory (MIT), stripped of its wiki/qmd model (no frontmatter, tiers,
//! decay, project tuples, or wikilink graph).

mod fts_query;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

/// Open SQLite connections, one per workspace root, keyed by a hash of the
/// canonical root path. rusqlite `Connection` is `!Sync`, so each is wrapped in
/// a std Mutex; the outer async Mutex only guards the map.
#[derive(Default)]
pub struct IndexManager {
    stores: Mutex<HashMap<String, Arc<std::sync::Mutex<Connection>>>>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingMeta {
    pub provider: String,
    pub model: String,
    pub dim: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexChunk {
    pub ord: u32,
    #[serde(default)]
    pub heading: String,
    #[serde(default)]
    pub heading_level: u32,
    #[serde(default)]
    pub start_line: u32,
    pub text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSyncRequest {
    pub root_path: String,
    pub path: String,
    pub sha: String,
    #[serde(default)]
    pub mtime: i64,
    #[serde(default)]
    pub title: String,
    pub chunks: Vec<IndexChunk>,
    /// Parallel to `chunks` by index. Absent ⇒ keyword-only (no vectors).
    pub vectors: Option<Vec<Vec<f32>>>,
    /// Required when `vectors` is present (which model produced them).
    pub embedding: Option<EmbeddingMeta>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatusRequest {
    pub root_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatusResponse {
    pub exists: bool,
    pub doc_count: u64,
    pub chunk_count: u64,
    pub embedded_chunk_count: u64,
    pub embedding: Option<EmbeddingMeta>,
    pub last_indexed_at: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StalenessEntry {
    pub path: String,
    pub sha: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StalenessRequest {
    pub root_path: String,
    pub entries: Vec<StalenessEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StalenessResponse {
    /// Present on disk but new or sha-changed in the index → re-chunk/embed.
    pub needs_reindex: Vec<String>,
    /// In the index but no longer on disk → caller should delete them.
    pub stale_in_index: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSearchRequest {
    pub root_path: String,
    pub query: String,
    /// "lite" (FTS only) or "full" (FTS + vector, fused with RRF).
    pub tier: String,
    /// Unit-normalised query embedding; required for "full".
    pub query_vector: Option<Vec<f32>>,
    pub embedding: Option<EmbeddingMeta>,
    pub limit: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexHit {
    pub path: String,
    pub title: String,
    /// Higher = more relevant (negated FTS rank for lite, fused RRF for full).
    pub score: f64,
    pub snippet: String,
    pub best_chunk_heading: String,
    pub best_chunk_line: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDeleteRequest {
    pub root_path: String,
    /// Specific docs to drop. `None` ⇒ delete the whole index file for the root.
    pub paths: Option<Vec<String>>,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  sha TEXT NOT NULL,
  mtime INTEGER NOT NULL DEFAULT 0,
  fts_body TEXT NOT NULL DEFAULT '',
  path_search TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  title, fts_body, path_search,
  content='documents', content_rowid='id',
  tokenize="unicode61 remove_diacritics 2 tokenchars '/_-'"
);

CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, fts_body, path_search)
  VALUES (new.id, new.title, new.fts_body, new.path_search);
END;
CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, fts_body, path_search)
  VALUES ('delete', old.id, old.title, old.fts_body, old.path_search);
END;
CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, fts_body, path_search)
  VALUES ('delete', old.id, old.title, old.fts_body, old.path_search);
  INSERT INTO documents_fts(rowid, title, fts_body, path_search)
  VALUES (new.id, new.title, new.fts_body, new.path_search);
END;

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  heading TEXT NOT NULL DEFAULT '',
  heading_level INTEGER NOT NULL DEFAULT 0,
  start_line INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  UNIQUE(doc_id, ord)
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);

CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  doc_id INTEGER NOT NULL,
  vector BLOB NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chunk_emb_doc ON chunk_embeddings(doc_id);
CREATE INDEX IF NOT EXISTS idx_chunk_emb_meta ON chunk_embeddings(provider, model, dim);
"#;

fn e2s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Stable per-root key from the canonical absolute path (falls back to the raw
/// path when canonicalize fails, e.g. the dir was removed). Deterministic across
/// runs (DefaultHasher uses fixed keys).
fn root_key(root_path: &str) -> String {
    use std::hash::{Hash, Hasher};
    let canon = std::fs::canonicalize(root_path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| root_path.to_string());
    let mut h = std::collections::hash_map::DefaultHasher::new();
    canon.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Pre-expand a path into space-separated tokens so slug-style queries hit even
/// when the slug words aren't in the body. Mirrors ai-memory's `path_search`.
fn path_search_text(path: &str) -> String {
    let base = path.replace(['/', '.'], " ");
    let base = base.split_whitespace().collect::<Vec<_>>().join(" ");
    let split = base.replace(['-', '_'], " ");
    let split = split.split_whitespace().collect::<Vec<_>>().join(" ");
    if split == base {
        base
    } else {
        format!("{base} {split}")
    }
}

fn normalize(v: &[f32]) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm == 0.0 {
        return v.to_vec();
    }
    v.iter().map(|x| x / norm).collect()
}

fn pack_le(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

/// Dot product of a query vector against a packed little-endian f32 BLOB.
/// `None` on a dimension mismatch (stale/wrong-model vector). With both sides
/// unit-normalised, the dot product equals cosine similarity.
fn dot_blob(q: &[f32], blob: &[u8]) -> Option<f32> {
    if blob.len() != q.len() * 4 {
        return None;
    }
    let mut s = 0.0f32;
    for (i, qi) in q.iter().enumerate() {
        let b = &blob[i * 4..i * 4 + 4];
        s += qi * f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
    }
    Some(s)
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("PRAGMA foreign_keys=ON;").map_err(e2s)?;
    conn.execute_batch(SCHEMA).map_err(e2s)?;
    Ok(())
}

fn open_db(path: &Path, root_path: &str) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(e2s)?;
    // journal_mode returns the new mode, so it must be a query, not execute.
    let _: String = conn
        .query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))
        .map_err(e2s)?;
    conn.execute_batch("PRAGMA synchronous=NORMAL;")
        .map_err(e2s)?;
    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(e2s)?;
    init_schema(&conn)?;
    set_meta(&conn, "root_path", root_path)?;
    Ok(conn)
}

fn index_dir(app: &AppHandle, key: &str) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(e2s)?
        .join("ai-index")
        .join(key))
}

async fn conn_for(
    app: &AppHandle,
    state: &IndexManager,
    root_path: &str,
) -> Result<Arc<std::sync::Mutex<Connection>>, String> {
    let key = root_key(root_path);
    let mut map = state.stores.lock().await;
    if let Some(c) = map.get(&key) {
        return Ok(c.clone());
    }
    let dir = index_dir(app, &key)?;
    std::fs::create_dir_all(&dir).map_err(e2s)?;
    let conn = open_db(&dir.join("index.sqlite"), root_path)?;
    let arc = Arc::new(std::sync::Mutex::new(conn));
    map.insert(key, arc.clone());
    Ok(arc)
}

fn get_meta(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT v FROM meta WHERE k=?1", params![key], |r| r.get(0))
        .optional()
        .map_err(e2s)
}

fn set_meta(conn: &Connection, key: &str, val: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
        params![key, val],
    )
    .map_err(e2s)?;
    Ok(())
}

fn read_embedding_meta(conn: &Connection) -> Result<Option<EmbeddingMeta>, String> {
    match (
        get_meta(conn, "embedding_provider")?,
        get_meta(conn, "embedding_model")?,
        get_meta(conn, "embedding_dim")?,
    ) {
        (Some(provider), Some(model), Some(dim)) => Ok(Some(EmbeddingMeta {
            provider,
            model,
            dim: dim.parse().unwrap_or(0),
        })),
        _ => Ok(None),
    }
}

fn write_embedding_meta(conn: &Connection, emb: &EmbeddingMeta) -> Result<(), String> {
    set_meta(conn, "embedding_provider", &emb.provider)?;
    set_meta(conn, "embedding_model", &emb.model)?;
    set_meta(conn, "embedding_dim", &emb.dim.to_string())?;
    Ok(())
}

fn upsert(conn: &mut Connection, req: &IndexSyncRequest) -> Result<(), String> {
    let stored_sha: Option<String> = conn
        .query_row(
            "SELECT sha FROM documents WHERE path=?1",
            params![req.path],
            |r| r.get(0),
        )
        .optional()
        .map_err(e2s)?;
    // Unchanged content with no new vectors → nothing to do.
    if stored_sha.as_deref() == Some(req.sha.as_str()) && req.vectors.is_none() {
        return Ok(());
    }
    // Refuse to mix embedding models in one store (a 1536-d query can't score
    // 768-d vectors). The JS side wipes + reindexes on this error.
    if let Some(emb) = &req.embedding {
        if let Some(existing) = read_embedding_meta(conn)? {
            if &existing != emb {
                return Err(format!(
                    "embedding-mismatch: stored {}/{}/{} != incoming {}/{}/{}; reindex required",
                    existing.provider,
                    existing.model,
                    existing.dim,
                    emb.provider,
                    emb.model,
                    emb.dim
                ));
            }
        }
    }
    if let Some(v) = &req.vectors {
        if v.len() != req.chunks.len() {
            return Err(format!(
                "vectors/chunks length mismatch: {} vs {}",
                v.len(),
                req.chunks.len()
            ));
        }
    }

    let fts_body = req
        .chunks
        .iter()
        .map(|c| c.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let path_search = path_search_text(&req.path);
    let ts = now_ms();

    let tx = conn.transaction().map_err(e2s)?;
    tx.execute(
        "INSERT INTO documents (path, title, sha, mtime, fts_body, path_search, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
         ON CONFLICT(path) DO UPDATE SET \
           title=excluded.title, sha=excluded.sha, mtime=excluded.mtime, \
           fts_body=excluded.fts_body, path_search=excluded.path_search, updated_at=excluded.updated_at",
        params![req.path, req.title, req.sha, req.mtime, fts_body, path_search, ts],
    )
    .map_err(e2s)?;
    let doc_id: i64 = tx
        .query_row(
            "SELECT id FROM documents WHERE path=?1",
            params![req.path],
            |r| r.get(0),
        )
        .map_err(e2s)?;
    // Full replace of this doc's chunks (cascades to its embeddings).
    tx.execute("DELETE FROM chunks WHERE doc_id=?1", params![doc_id])
        .map_err(e2s)?;

    for (i, c) in req.chunks.iter().enumerate() {
        tx.execute(
            "INSERT INTO chunks (doc_id, ord, heading, heading_level, start_line, text) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                doc_id,
                c.ord,
                c.heading,
                c.heading_level,
                c.start_line,
                c.text
            ],
        )
        .map_err(e2s)?;
        if let (Some(vectors), Some(emb)) = (&req.vectors, &req.embedding) {
            let chunk_id = tx.last_insert_rowid();
            let packed = pack_le(&normalize(&vectors[i]));
            tx.execute(
                "INSERT INTO chunk_embeddings (chunk_id, doc_id, vector, provider, model, dim, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![chunk_id, doc_id, packed, emb.provider, emb.model, emb.dim, ts],
            )
            .map_err(e2s)?;
        }
    }
    if let Some(emb) = &req.embedding {
        write_embedding_meta(&tx, emb)?;
    }
    tx.commit().map_err(e2s)?;
    Ok(())
}

fn staleness(conn: &Connection, entries: &[StalenessEntry]) -> Result<StalenessResponse, String> {
    let mut stored: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT path, sha FROM documents")
            .map_err(e2s)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(e2s)?;
        for row in rows {
            let (p, s) = row.map_err(e2s)?;
            stored.insert(p, s);
        }
    }
    let mut needs = Vec::new();
    let mut present: HashSet<&str> = HashSet::new();
    for e in entries {
        present.insert(e.path.as_str());
        match stored.get(&e.path) {
            Some(s) if *s == e.sha => {}
            _ => needs.push(e.path.clone()),
        }
    }
    let stale_in_index = stored
        .keys()
        .filter(|p| !present.contains(p.as_str()))
        .cloned()
        .collect();
    Ok(StalenessResponse {
        needs_reindex: needs,
        stale_in_index,
    })
}

fn status_counts(conn: &Connection) -> Result<IndexStatusResponse, String> {
    let doc_count: i64 = conn
        .query_row("SELECT count(*) FROM documents", [], |r| r.get(0))
        .map_err(e2s)?;
    let chunk_count: i64 = conn
        .query_row("SELECT count(*) FROM chunks", [], |r| r.get(0))
        .map_err(e2s)?;
    let embedded: i64 = conn
        .query_row("SELECT count(*) FROM chunk_embeddings", [], |r| r.get(0))
        .map_err(e2s)?;
    let last: Option<i64> = conn
        .query_row("SELECT max(updated_at) FROM documents", [], |r| {
            r.get::<_, Option<i64>>(0)
        })
        .map_err(e2s)?;
    Ok(IndexStatusResponse {
        exists: true,
        doc_count: doc_count as u64,
        chunk_count: chunk_count as u64,
        embedded_chunk_count: embedded as u64,
        embedding: read_embedding_meta(conn)?,
        last_indexed_at: last,
    })
}

fn delete_paths(conn: &Connection, paths: &[String]) -> Result<(), String> {
    for p in paths {
        conn.execute("DELETE FROM documents WHERE path=?1", params![p])
            .map_err(e2s)?;
    }
    Ok(())
}

fn doc_meta(conn: &Connection, doc_id: i64) -> Result<Option<(String, String)>, String> {
    conn.query_row(
        "SELECT path, title FROM documents WHERE id=?1",
        params![doc_id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )
    .optional()
    .map_err(e2s)
}

fn chunk_cite(conn: &Connection, chunk_id: i64) -> Result<Option<(String, u32)>, String> {
    conn.query_row(
        "SELECT heading, start_line FROM chunks WHERE id=?1",
        params![chunk_id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u32)),
    )
    .optional()
    .map_err(e2s)
}

fn first_chunk_cite(conn: &Connection, doc_id: i64) -> Result<Option<(String, u32)>, String> {
    conn.query_row(
        "SELECT heading, start_line FROM chunks WHERE doc_id=?1 ORDER BY ord LIMIT 1",
        params![doc_id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u32)),
    )
    .optional()
    .map_err(e2s)
}

fn chunk_excerpt(conn: &Connection, doc_id: i64) -> Result<String, String> {
    let t: Option<String> = conn
        .query_row(
            "SELECT text FROM chunks WHERE doc_id=?1 ORDER BY ord LIMIT 1",
            params![doc_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(e2s)?;
    Ok(t.map(|s| s.chars().take(160).collect()).unwrap_or_default())
}

fn fts_snippet(conn: &Connection, prepared: &str, doc_id: i64) -> Result<Option<String>, String> {
    if prepared.is_empty() {
        return Ok(None);
    }
    conn.query_row(
        "SELECT snippet(documents_fts, 1, '<mark>', '</mark>', '…', 24) \
         FROM documents_fts WHERE documents_fts MATCH ?1 AND documents_fts.rowid = ?2",
        params![prepared, doc_id],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(e2s)
}

/// Reciprocal Rank Fusion (k=60). Each stream is a 1-based ranked list of doc
/// ids; a doc's fused score is Σ 1/(k + rank) across the streams it appears in.
fn rrf_fuse(streams: &[&[i64]], limit: usize) -> Vec<(i64, f64)> {
    const K: f64 = 60.0;
    let mut scores: HashMap<i64, f64> = HashMap::new();
    for stream in streams {
        for (i, doc) in stream.iter().enumerate() {
            *scores.entry(*doc).or_insert(0.0) += 1.0 / (K + (i as f64 + 1.0));
        }
    }
    let mut ranked: Vec<(i64, f64)> = scores.into_iter().collect();
    ranked.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(&b.0))
    });
    ranked.truncate(limit);
    ranked
}

fn fts_doc_ids(conn: &Connection, prepared: &str, limit: usize) -> Result<Vec<i64>, String> {
    if prepared.is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare(
            "SELECT documents_fts.rowid FROM documents_fts \
             WHERE documents_fts MATCH ?1 ORDER BY documents_fts.rank LIMIT ?2",
        )
        .map_err(e2s)?;
    let rows = stmt
        .query_map(params![prepared, limit as i64], |r| r.get::<_, i64>(0))
        .map_err(e2s)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(e2s)
}

fn search_lite(conn: &Connection, raw_query: &str, limit: usize) -> Result<Vec<IndexHit>, String> {
    let prepared = fts_query::prepare_fts5_query(raw_query);
    if prepared.is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare(
            "SELECT d.path, d.title, documents_fts.rank, \
             snippet(documents_fts, 1, '<mark>', '</mark>', '…', 24), d.id \
             FROM documents_fts JOIN documents d ON d.id = documents_fts.rowid \
             WHERE documents_fts MATCH ?1 ORDER BY documents_fts.rank LIMIT ?2",
        )
        .map_err(e2s)?;
    let rows = stmt
        .query_map(params![prepared, limit as i64], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, f64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })
        .map_err(e2s)?;
    let mut out = Vec::new();
    for row in rows {
        let (path, title, rank, snippet, doc_id) = row.map_err(e2s)?;
        let (heading, line) = first_chunk_cite(conn, doc_id)?.unwrap_or_default();
        out.push(IndexHit {
            path,
            title,
            score: -rank, // FTS5 rank is lower-is-better; negate for higher-is-better
            snippet,
            best_chunk_heading: heading,
            best_chunk_line: line,
        });
    }
    Ok(out)
}

fn search_full(
    conn: &Connection,
    raw_query: &str,
    query_vector: Option<&[f32]>,
    embedding: Option<&EmbeddingMeta>,
    limit: usize,
) -> Result<Vec<IndexHit>, String> {
    let prepared = fts_query::prepare_fts5_query(raw_query);
    let candidate = (limit * 4).max(20);

    let fts_docs = fts_doc_ids(conn, &prepared, candidate)?;

    // Vector stream: best (max-cosine) chunk per doc.
    let mut best_chunk: HashMap<i64, (i64, f32)> = HashMap::new();
    if let (Some(q), Some(emb)) = (query_vector, embedding) {
        let qn = normalize(q);
        let mut stmt = conn
            .prepare(
                "SELECT chunk_id, doc_id, vector FROM chunk_embeddings \
                 WHERE provider=?1 AND model=?2 AND dim=?3",
            )
            .map_err(e2s)?;
        let mut rows = stmt
            .query(params![emb.provider, emb.model, emb.dim])
            .map_err(e2s)?;
        while let Some(row) = rows.next().map_err(e2s)? {
            let chunk_id: i64 = row.get(0).map_err(e2s)?;
            let doc_id: i64 = row.get(1).map_err(e2s)?;
            let blob: Vec<u8> = row.get(2).map_err(e2s)?;
            if let Some(sim) = dot_blob(&qn, &blob) {
                best_chunk
                    .entry(doc_id)
                    .and_modify(|e| {
                        if sim > e.1 {
                            *e = (chunk_id, sim);
                        }
                    })
                    .or_insert((chunk_id, sim));
            }
        }
    }
    let mut vec_docs: Vec<(i64, f32)> = best_chunk.iter().map(|(d, (_, s))| (*d, *s)).collect();
    vec_docs.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    vec_docs.truncate(candidate);
    let vec_doc_ids: Vec<i64> = vec_docs.iter().map(|(d, _)| *d).collect();

    let ranked = rrf_fuse(&[&fts_docs, &vec_doc_ids], limit);

    let mut out = Vec::new();
    for (doc_id, score) in ranked {
        let (path, title) = match doc_meta(conn, doc_id)? {
            Some(x) => x,
            None => continue,
        };
        let (heading, line) = match best_chunk.get(&doc_id) {
            Some((cid, _)) => chunk_cite(conn, *cid)?.unwrap_or_default(),
            None => first_chunk_cite(conn, doc_id)?.unwrap_or_default(),
        };
        let snippet = match fts_snippet(conn, &prepared, doc_id)? {
            Some(s) => s,
            None => chunk_excerpt(conn, doc_id)?,
        };
        out.push(IndexHit {
            path,
            title,
            score,
            snippet,
            best_chunk_heading: heading,
            best_chunk_line: line,
        });
    }
    Ok(out)
}

// ── Tauri commands (thin wrappers over the store/search fns) ────────────────

/// Index stats for the settings UI. Does not create the DB if absent.
#[tauri::command]
pub async fn ai_index_status(
    app: AppHandle,
    state: State<'_, IndexManager>,
    request: IndexStatusRequest,
) -> Result<IndexStatusResponse, String> {
    let key = root_key(&request.root_path);
    let db_path = index_dir(&app, &key)?.join("index.sqlite");
    let exists_on_disk = db_path.exists() || state.stores.lock().await.contains_key(&key);
    if !exists_on_disk {
        return Ok(IndexStatusResponse {
            exists: false,
            doc_count: 0,
            chunk_count: 0,
            embedded_chunk_count: 0,
            embedding: None,
            last_indexed_at: None,
        });
    }
    let arc = conn_for(&app, &state, &request.root_path).await?;
    let conn = arc.lock().map_err(|e| e.to_string())?;
    status_counts(&conn)
}

/// Diff on-disk {path, sha} against the index → what to (re)index and what to drop.
#[tauri::command]
pub async fn ai_index_staleness(
    app: AppHandle,
    state: State<'_, IndexManager>,
    request: StalenessRequest,
) -> Result<StalenessResponse, String> {
    let arc = conn_for(&app, &state, &request.root_path).await?;
    let conn = arc.lock().map_err(|e| e.to_string())?;
    staleness(&conn, &request.entries)
}

/// Upsert one document + its chunks (+ optional vectors) into the root's index.
#[tauri::command]
pub async fn ai_index_sync(
    app: AppHandle,
    state: State<'_, IndexManager>,
    request: IndexSyncRequest,
) -> Result<(), String> {
    let arc = conn_for(&app, &state, &request.root_path).await?;
    let mut guard = arc.lock().map_err(|e| e.to_string())?;
    upsert(&mut guard, &request)
}

/// Search a root's index. "lite" → FTS only; "full" → FTS + vector via RRF.
#[tauri::command]
pub async fn ai_index_search(
    app: AppHandle,
    state: State<'_, IndexManager>,
    request: IndexSearchRequest,
) -> Result<Vec<IndexHit>, String> {
    let arc = conn_for(&app, &state, &request.root_path).await?;
    let conn = arc.lock().map_err(|e| e.to_string())?;
    let limit = request.limit.unwrap_or(20).max(1) as usize;
    if request.tier == "full" {
        search_full(
            &conn,
            &request.query,
            request.query_vector.as_deref(),
            request.embedding.as_ref(),
            limit,
        )
    } else {
        search_lite(&conn, &request.query, limit)
    }
}

/// Delete specific docs, or (paths=None) drop the whole index file for the root.
#[tauri::command]
pub async fn ai_index_delete(
    app: AppHandle,
    state: State<'_, IndexManager>,
    request: IndexDeleteRequest,
) -> Result<(), String> {
    match request.paths {
        Some(paths) => {
            let arc = conn_for(&app, &state, &request.root_path).await?;
            let conn = arc.lock().map_err(|e| e.to_string())?;
            delete_paths(&conn, &paths)
        }
        None => {
            let key = root_key(&request.root_path);
            state.stores.lock().await.remove(&key);
            let dir = index_dir(&app, &key)?;
            if dir.exists() {
                std::fs::remove_dir_all(&dir).map_err(e2s)?;
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    fn sync_req(path: &str, title: &str, sha: &str, chunks: Vec<IndexChunk>) -> IndexSyncRequest {
        IndexSyncRequest {
            root_path: "/tmp/root".into(),
            path: path.into(),
            sha: sha.into(),
            mtime: 1,
            title: title.into(),
            chunks,
            vectors: None,
            embedding: None,
        }
    }

    fn chunk(ord: u32, heading: &str, line: u32, text: &str) -> IndexChunk {
        IndexChunk {
            ord,
            heading: heading.into(),
            heading_level: 1,
            start_line: line,
            text: text.into(),
        }
    }

    #[test]
    fn schema_opens_with_fts5_available() {
        // If the bundled SQLite ever lost FTS5, init_schema would fail here.
        let conn = mem();
        let n: i64 = conn
            .query_row("SELECT count(*) FROM documents_fts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn upsert_then_lite_search_with_snippet_and_accents() {
        let mut conn = mem();
        upsert(
            &mut conn,
            &sync_req(
                "notes/auth.md",
                "Auth",
                "sha1",
                vec![chunk(0, "Login", 0, "Configuração de OAuth e sessão")],
            ),
        )
        .unwrap();
        // Accent-folded match: query without the cedilla/accents still hits.
        let hits = search_lite(&conn, "configuracao", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "notes/auth.md");
        assert!(hits[0].snippet.contains("<mark>"));
        assert_eq!(hits[0].best_chunk_heading, "Login");
    }

    #[test]
    fn slug_query_hits_via_path_search() {
        let mut conn = mem();
        upsert(
            &mut conn,
            &sync_req(
                "follow-ups/ui-refresh.md",
                "X",
                "s",
                vec![chunk(0, "", 0, "body")],
            ),
        )
        .unwrap();
        let hits = search_lite(&conn, "ui-refresh", 10).unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn unchanged_lite_resync_is_noop_but_changed_replaces() {
        let mut conn = mem();
        upsert(
            &mut conn,
            &sync_req("a.md", "A", "s1", vec![chunk(0, "", 0, "alpha")]),
        )
        .unwrap();
        upsert(
            &mut conn,
            &sync_req("a.md", "A", "s1", vec![chunk(0, "", 0, "alpha")]),
        )
        .unwrap();
        let docs: i64 = conn
            .query_row("SELECT count(*) FROM documents", [], |r| r.get(0))
            .unwrap();
        assert_eq!(docs, 1);
        upsert(
            &mut conn,
            &sync_req("a.md", "A", "s2", vec![chunk(0, "", 0, "beta")]),
        )
        .unwrap();
        assert!(search_lite(&conn, "alpha", 10).unwrap().is_empty());
        assert_eq!(search_lite(&conn, "beta", 10).unwrap().len(), 1);
    }

    #[test]
    fn staleness_reports_new_changed_and_missing() {
        let mut conn = mem();
        upsert(
            &mut conn,
            &sync_req("keep.md", "K", "s1", vec![chunk(0, "", 0, "k")]),
        )
        .unwrap();
        upsert(
            &mut conn,
            &sync_req("gone.md", "G", "s1", vec![chunk(0, "", 0, "g")]),
        )
        .unwrap();
        let res = staleness(
            &conn,
            &[
                StalenessEntry {
                    path: "keep.md".into(),
                    sha: "s1".into(),
                }, // unchanged
                StalenessEntry {
                    path: "keep2.md".into(),
                    sha: "x".into(),
                }, // new
            ],
        )
        .unwrap();
        assert_eq!(res.needs_reindex, vec!["keep2.md"]);
        assert_eq!(res.stale_in_index, vec!["gone.md"]);
    }

    #[test]
    fn delete_cascades_chunks_and_embeddings() {
        let mut conn = mem();
        let mut req = sync_req("d.md", "D", "s", vec![chunk(0, "", 0, "x")]);
        req.vectors = Some(vec![vec![1.0, 0.0, 0.0]]);
        req.embedding = Some(EmbeddingMeta {
            provider: "openai".into(),
            model: "m".into(),
            dim: 3,
        });
        upsert(&mut conn, &req).unwrap();
        delete_paths(&conn, &["d.md".into()]).unwrap();
        let chunks: i64 = conn
            .query_row("SELECT count(*) FROM chunks", [], |r| r.get(0))
            .unwrap();
        let embs: i64 = conn
            .query_row("SELECT count(*) FROM chunk_embeddings", [], |r| r.get(0))
            .unwrap();
        assert_eq!(chunks, 0);
        assert_eq!(embs, 0);
    }

    #[test]
    fn full_search_ranks_by_vector_and_cites_best_chunk() {
        let mut conn = mem();
        let mut req = sync_req(
            "v.md",
            "V",
            "s",
            vec![
                chunk(0, "Intro", 0, "unrelated"),
                chunk(1, "Target", 5, "match here"),
            ],
        );
        // chunk 1 points the same direction as the query.
        req.vectors = Some(vec![vec![0.0, 1.0], vec![1.0, 0.0]]);
        req.embedding = Some(EmbeddingMeta {
            provider: "p".into(),
            model: "m".into(),
            dim: 2,
        });
        upsert(&mut conn, &req).unwrap();

        let emb = EmbeddingMeta {
            provider: "p".into(),
            model: "m".into(),
            dim: 2,
        };
        let hits = search_full(&conn, "", Some(&[1.0, 0.0]), Some(&emb), 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].best_chunk_heading, "Target"); // chunk 1 won the max-cosine
        assert_eq!(hits[0].best_chunk_line, 5);
    }

    #[test]
    fn full_search_degrades_to_lite_without_a_query_vector() {
        let mut conn = mem();
        upsert(
            &mut conn,
            &sync_req("x.md", "X", "s", vec![chunk(0, "", 0, "findme please")]),
        )
        .unwrap();
        let hits = search_full(&conn, "findme", None, None, 10).unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn embedding_model_mismatch_is_rejected() {
        let mut conn = mem();
        let mut a = sync_req("a.md", "A", "s1", vec![chunk(0, "", 0, "x")]);
        a.vectors = Some(vec![vec![1.0, 0.0]]);
        a.embedding = Some(EmbeddingMeta {
            provider: "p".into(),
            model: "m1".into(),
            dim: 2,
        });
        upsert(&mut conn, &a).unwrap();

        let mut b = sync_req("b.md", "B", "s1", vec![chunk(0, "", 0, "y")]);
        b.vectors = Some(vec![vec![1.0, 0.0, 0.0]]);
        b.embedding = Some(EmbeddingMeta {
            provider: "p".into(),
            model: "m2".into(),
            dim: 3,
        });
        let err = upsert(&mut conn, &b).unwrap_err();
        assert!(err.contains("embedding-mismatch"), "got: {err}");
    }

    #[test]
    fn rrf_rewards_agreement_across_streams() {
        // A is high in both lists; should outrank items in only one.
        let fts = [10i64, 20, 30];
        let vec = [30i64, 10, 40];
        let ranked = rrf_fuse(&[&fts, &vec], 10);
        assert_eq!(ranked[0].0, 10); // top of one, second of the other → best fused
    }

    #[test]
    fn vector_pack_roundtrips_little_endian() {
        let v = vec![0.5f32, -0.25, 1.0];
        let packed = pack_le(&v);
        assert_eq!(packed.len(), 12);
        let dot = dot_blob(&v, &packed).unwrap();
        let expected = 0.5 * 0.5 + (-0.25) * (-0.25) + 1.0 * 1.0;
        assert!((dot - expected).abs() < 1e-6);
        // Dimension mismatch → None (the last line of defense).
        assert!(dot_blob(&[1.0, 0.0], &packed).is_none());
    }
}
