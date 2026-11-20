//! Live state (`list_open_tabs`, `get_active_document`, `get_selection`).
//! The Rust side asks the `main` webview for a snapshot (`mcp-state-request`),
//! the webview answers with `mcp_state_respond`, and Rust authorizes every
//! file path against the open roots and masks the text before anything goes
//! back to the MCP client. A request that cannot be answered in time fails;
//! it never falls back to an older snapshot.
//!
//! What the client sees of a tab is an opaque id minted here (the webview's
//! own id can carry an absolute path), stable while the app runs.
use super::{confined, random_id, scrub, window::MAIN, Registry, MAX_RESPONSE};
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

pub(super) const STATE_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_PENDING: usize = 16;
pub(super) const DOCUMENT_LIMIT: usize = 1024 * 1024;
pub(super) const SELECTION_LIMIT: usize = 256 * 1024;
// Room for the envelope, and for the few bytes masking can add at a cut.
const RESPONSE_MARGIN: usize = 64 * 1024;
// The largest document text a selection payload may carry. Only a document up
// to `DOCUMENT_LIMIT` is masked and read out, whole, in one `Stream` from its
// first byte: a secret that starts anywhere before the selection hides it.
// (Masking only a window around the selection would start the secret's
// context in the middle of it.) Above that the selection is `unavailable`:
// masking costs far more than the payload, and a client can ask in a loop.
const MAX_SELECTION_DOCUMENT: usize = 16 * 1024 * 1024;
const MAX_TABS: usize = 256;
const MAX_PANES: usize = 8;
const MAX_ID: usize = 256;
const MAX_TITLE: usize = 1024;
const MAX_PATH: usize = 4096;
const MAX_LANGUAGE: usize = 64;
const MAX_TAB_IDS: usize = 4096;

pub(super) const UNAVAILABLE: &str = "unavailable";
pub(super) const TIMED_OUT: &str = "timed out";
const BUSY: &str = "too many requests";
const INVALID_RESPONSE: &str = "invalid response";
const INVALID_ARGUMENTS: &str = "invalid arguments";
const TOO_LARGE: &str = "not allowed";
const REFUSED: &str = "Could not answer MCP request";

pub(super) const TOOLS: [&str; 3] = ["list_open_tabs", "get_active_document", "get_selection"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Kind {
    Tabs,
    ActiveDocument,
    Selection,
}
impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Tabs => "tabs",
            Kind::ActiveDocument => "active_document",
            Kind::Selection => "selection",
        }
    }
}

type Answer = Result<Value, &'static str>;

/// Admission by the life of the work, not by the wait for the webview: a
/// request holds a slot from its start until its last blocking step has
/// finished (the steps hold it too), so a client that gives up at the deadline
/// and asks again cannot pile up work that is still running.
#[derive(Default)]
pub(super) struct Work(Arc<AtomicUsize>);
pub(super) struct Slot(Arc<AtomicUsize>);
impl Work {
    fn admit(&self) -> Result<Arc<Slot>, &'static str> {
        self.0
            .try_update(Ordering::AcqRel, Ordering::Acquire, |busy| {
                (busy < MAX_PENDING).then_some(busy + 1)
            })
            .map_err(|_| BUSY)?;
        Ok(Arc::new(Slot(self.0.clone())))
    }
    #[cfg(test)]
    pub(super) fn busy(&self) -> usize {
        self.0.load(Ordering::Acquire)
    }
}
impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

struct Waiting {
    sender: tokio::sync::oneshot::Sender<Answer>,
    deadline: Instant,
}

pub(super) struct Bridge {
    pending: Mutex<HashMap<String, Waiting>>,
    timeout: Duration,
    closed: AtomicBool,
}
impl Default for Bridge {
    fn default() -> Self {
        Self::with_timeout(STATE_TIMEOUT)
    }
}
struct Forget<'a>(&'a Bridge, &'a str);
impl Drop for Forget<'_> {
    fn drop(&mut self) {
        // The caller went away (deadline, dropped connection): the id must
        // not stay answerable.
        self.0.take(self.1);
    }
}

// ---- strict reading of what the webview sends ----------------------------------
//
// Every envelope and payload must be a JSON object with exactly the contract's
// keys: a derived `Deserialize` would also read a positional sequence, and an
// `Option` cannot tell a forbidden key sent as `null` from a missing one.

fn exact<'a>(value: &'a Value, keys: &[&str]) -> Result<&'a Map<String, Value>, &'static str> {
    let map = value.as_object().ok_or(INVALID_RESPONSE)?;
    if map.len() != keys.len() || keys.iter().any(|key| !map.contains_key(*key)) {
        return Err(INVALID_RESPONSE);
    }
    Ok(map)
}
/// `exact`, for a value that is consumed: the strings it holds can then be
/// moved out with `take_string` instead of copied.
fn exact_owned(value: Value, keys: &[&str]) -> Result<Map<String, Value>, &'static str> {
    exact(&value, keys)?;
    match value {
        Value::Object(map) => Ok(map),
        _ => Err(INVALID_RESPONSE),
    }
}
fn take_string(map: &mut Map<String, Value>, key: &str) -> Result<String, &'static str> {
    match map.remove(key) {
        Some(Value::String(value)) => Ok(value),
        _ => Err(INVALID_RESPONSE),
    }
}
fn string<'a>(map: &'a Map<String, Value>, key: &str) -> Result<&'a str, &'static str> {
    map.get(key).and_then(Value::as_str).ok_or(INVALID_RESPONSE)
}
fn boolean(map: &Map<String, Value>, key: &str) -> Result<bool, &'static str> {
    map.get(key)
        .and_then(Value::as_bool)
        .ok_or(INVALID_RESPONSE)
}
fn number(map: &Map<String, Value>, key: &str) -> Result<u32, &'static str> {
    map.get(key)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or(INVALID_RESPONSE)
}
fn items<'a>(map: &'a Map<String, Value>, key: &str) -> Result<&'a Vec<Value>, &'static str> {
    map.get(key)
        .and_then(Value::as_array)
        .ok_or(INVALID_RESPONSE)
}
/// `string | null` with the key required.
fn path(map: &Map<String, Value>, key: &str) -> Result<Option<String>, &'static str> {
    match map.get(key) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            short(value, MAX_PATH)?;
            Ok(Some(value.clone()))
        }
        _ => Err(INVALID_RESPONSE),
    }
}
fn short(value: &str, limit: usize) -> Result<(), &'static str> {
    if value.len() > limit || value.contains('\0') {
        Err(INVALID_RESPONSE)
    } else {
        Ok(())
    }
}
fn bounded_string(
    map: &Map<String, Value>,
    key: &str,
    limit: usize,
) -> Result<String, &'static str> {
    let value = string(map, key)?;
    short(value, limit)?;
    Ok(value.to_owned())
}

/// The envelope the webview answers with. `ok: true` carries `data` and no
/// `error`; `ok: false` carries `error` and no `data`; a forbidden key is
/// refused even when it is `null`.
///
/// Takes the response by value and hands `data` over by moving it: the payload
/// can be megabytes, and nothing here copies it before the parsers check its
/// sizes.
fn envelope(response: Value) -> Answer {
    match response.get("ok").and_then(Value::as_bool) {
        Some(true) => {
            exact(&response, &["id", "ok", "data"])?;
            let Value::Object(mut map) = response else {
                return Err(INVALID_RESPONSE);
            };
            match map.remove("data") {
                Some(data) if data.is_object() => Ok(data),
                _ => Err(INVALID_RESPONSE),
            }
        }
        Some(false) => {
            let map = exact(&response, &["id", "ok", "error"])?;
            if map["error"].as_str() == Some(UNAVAILABLE) {
                Err(UNAVAILABLE)
            } else {
                Err(INVALID_RESPONSE)
            }
        }
        None => Err(INVALID_RESPONSE),
    }
}

impl Bridge {
    pub(super) fn with_timeout(timeout: Duration) -> Self {
        Self {
            pending: Mutex::default(),
            timeout,
            closed: AtomicBool::new(false),
        }
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Waiting>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn take(&self, id: &str) -> Option<Waiting> {
        self.lock().remove(id)
    }
    pub(super) fn deadline(&self) -> Instant {
        Instant::now() + self.timeout
    }
    /// Ask the `main` webview for one snapshot and wait for it until `deadline`.
    pub(super) async fn request(
        &self,
        window: &super::window::Window,
        kind: Kind,
        deadline: Instant,
    ) -> Answer {
        let id = random_id().map_err(|_| UNAVAILABLE)?;
        let (sender, mut receiver) = tokio::sync::oneshot::channel();
        {
            let mut pending = self.lock();
            if self.closed.load(Ordering::Acquire) {
                return Err(UNAVAILABLE);
            }
            if pending.len() >= MAX_PENDING {
                return Err(BUSY);
            }
            pending.insert(id.clone(), Waiting { sender, deadline });
        }
        let _forget = Forget(self, &id);
        if !window.emit("mcp-state-request", json!({"id": id, "kind": kind.name()})) {
            return Err(UNAVAILABLE);
        }
        match tokio::time::timeout_at(deadline.into(), &mut receiver).await {
            // The clock decides, not the order the tasks happened to run in.
            Ok(Ok(_)) if Instant::now() > deadline => Err(TIMED_OUT),
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err(UNAVAILABLE),
            Err(_) => Err(TIMED_OUT),
        }
    }
    /// The answer from the webview. Only `main` may answer, only a request
    /// still waiting and still inside its deadline accepts one (a late,
    /// repeated or invented id is refused without touching anything), and the
    /// first answer consumes the id.
    pub(super) fn respond(&self, from_main: bool, response: Value) -> Result<(), &'static str> {
        if !from_main {
            return Err(REFUSED);
        }
        let id = response.get("id").and_then(Value::as_str).ok_or(REFUSED)?;
        // Taking the id and reading the clock happen before anything is
        // delivered, so an answer after the deadline never reaches the waiter,
        // whether or not the waiter has run its own timeout yet.
        let waiting = self.take(id).ok_or(REFUSED)?;
        if Instant::now() >= waiting.deadline {
            let _ = waiting.sender.send(Err(TIMED_OUT));
            return Err(REFUSED);
        }
        // A dropped receiver means the request is gone: the answer was not used.
        waiting.sender.send(envelope(response)).map_err(|_| REFUSED)
    }
    /// The page is reloading or going away: every waiting request fails now.
    pub(super) fn cancel_all(&self) {
        for (_, waiting) in self.lock().drain() {
            let _ = waiting.sender.send(Err(UNAVAILABLE));
        }
    }
    pub(super) fn close(&self) {
        let mut pending = self.lock();
        self.closed.store(true, Ordering::Release);
        for (_, waiting) in pending.drain() {
            let _ = waiting.sender.send(Err(UNAVAILABLE));
        }
    }
}

#[tauri::command]
pub fn mcp_state_respond<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    response: Value,
    registry: tauri::State<'_, Arc<Registry>>,
) -> Result<(), String> {
    registry
        .bridge
        .respond(webview.label() == MAIN, response)
        .map_err(str::to_owned)
}

// ---- opaque tab ids --------------------------------------------------------------

/// The webview's tab id (it can be a folder path plus a file path) never goes
/// to the client: each one is traded for a random id, kept for the life of the
/// app. The map is bounded; past `MAX_TAB_IDS` it starts over, which only
/// renews ids of tabs closed long ago.
#[derive(Default)]
pub(super) struct TabIds(Mutex<HashMap<String, String>>);
impl TabIds {
    fn translate(&self, ids: &[&str]) -> Result<Vec<String>, &'static str> {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let fresh = ids.iter().filter(|id| !map.contains_key(**id)).count();
        if map.len() + fresh > MAX_TAB_IDS {
            map.clear();
        }
        ids.iter()
            .map(|id| match map.get(*id) {
                Some(opaque) => Ok(opaque.clone()),
                None => {
                    let opaque = random_id().map_err(|_| UNAVAILABLE)?;
                    map.insert((*id).to_owned(), opaque.clone());
                    Ok(opaque)
                }
            })
            .collect()
    }
    fn one(&self, id: &str) -> Result<String, &'static str> {
        Ok(self.translate(&[id])?.remove(0))
    }
}

// ---- what the webview sends --------------------------------------------

struct TabsData {
    panes: Vec<PaneData>,
}
struct PaneData {
    index: u32,
    active: bool,
    tabs: Vec<TabData>,
}
struct TabData {
    id: String,
    title: String,
    file_path: Option<String>,
    active: bool,
    dirty: bool,
}
struct DocumentBody {
    tab_id: String,
    title: String,
    file_path: Option<String>,
    dirty: bool,
    language: String,
    text: String,
}
#[derive(Clone, Copy)]
enum Source {
    Editor,
    Preview,
}
enum Pick {
    /// UTF-16 offsets into the document text, as the editor counts them.
    Offsets { start: u32, end: u32 },
    /// The rendered text of a preview selection: no offsets exist for it.
    Text(String),
}
struct SelectionBody {
    source: Source,
    tab_id: String,
    /// Empty when `oversized`: a document past `DOCUMENT_LIMIT` is checked and
    /// dropped, never copied or masked.
    document: String,
    oversized: bool,
    pick: Pick,
}

/// A malformed answer is rejected whole, never filtered item by item.
fn parse_tabs(data: &Value) -> Result<TabsData, &'static str> {
    let panes = items(exact(data, &["panes"])?, "panes")?;
    if panes.len() > MAX_PANES {
        return Err(INVALID_RESPONSE);
    }
    let mut total = 0;
    let mut parsed = Vec::with_capacity(panes.len());
    for pane in panes {
        let map = exact(pane, &["index", "active", "tabs"])?;
        let tabs = items(map, "tabs")?;
        total += tabs.len();
        if total > MAX_TABS {
            return Err(INVALID_RESPONSE);
        }
        parsed.push(PaneData {
            index: number(map, "index")?,
            active: boolean(map, "active")?,
            tabs: tabs
                .iter()
                .map(|tab| {
                    let map = exact(tab, &["id", "title", "filePath", "active", "dirty"])?;
                    Ok(TabData {
                        id: bounded_string(map, "id", MAX_ID)?,
                        title: bounded_string(map, "title", MAX_TITLE)?,
                        file_path: path(map, "filePath")?,
                        active: boolean(map, "active")?,
                        dirty: boolean(map, "dirty")?,
                    })
                })
                .collect::<Result<_, &'static str>>()?,
        });
    }
    Ok(TabsData { panes: parsed })
}
fn parse_document(data: Value) -> Result<Option<DocumentBody>, &'static str> {
    let mut map = exact_owned(data, &["document"])?;
    match map.remove("document") {
        Some(Value::Null) => Ok(None),
        Some(body) => {
            let mut map = exact_owned(
                body,
                &["tabId", "title", "filePath", "dirty", "language", "text"],
            )?;
            Ok(Some(DocumentBody {
                tab_id: bounded_string(&map, "tabId", MAX_ID)?,
                title: bounded_string(&map, "title", MAX_TITLE)?,
                file_path: path(&map, "filePath")?,
                dirty: boolean(&map, "dirty")?,
                language: bounded_string(&map, "language", MAX_LANGUAGE)?,
                // Moved out of the answer, not copied.
                text: take_string(&mut map, "text")?,
            }))
        }
        None => Err(INVALID_RESPONSE),
    }
}
/// Every size is checked on the borrowed text, before anything is moved or
/// copied: a document past `MAX_SELECTION_DOCUMENT` is refused outright, one
/// past `DOCUMENT_LIMIT` is dropped (never kept, never masked), and the picked
/// text of a preview selection cannot outgrow the largest document.
fn parse_selection(data: Value) -> Result<Option<SelectionBody>, &'static str> {
    let mut map = exact_owned(data, &["selection"])?;
    let body = match map.remove("selection") {
        Some(Value::Null) => return Ok(None),
        Some(body) => body,
        None => return Err(INVALID_RESPONSE),
    };
    let source = body
        .get("source")
        .and_then(Value::as_str)
        .ok_or(INVALID_RESPONSE)?;
    let (source, mut map) = match source {
        "editor" => (
            Source::Editor,
            exact_owned(body, &["source", "tabId", "documentText", "start", "end"])?,
        ),
        "preview" => (
            Source::Preview,
            exact_owned(body, &["source", "tabId", "documentText", "text"])?,
        ),
        _ => return Err(INVALID_RESPONSE),
    };
    let document = string(&map, "documentText")?;
    if document.len() > MAX_SELECTION_DOCUMENT || document.contains('\0') {
        return Err(INVALID_RESPONSE);
    }
    // Accepted (it was validated above), but not read out: see `selection_json`.
    let oversized = document.len() > DOCUMENT_LIMIT;
    let pick = match source {
        Source::Editor => Pick::Offsets {
            start: number(&map, "start")?,
            end: number(&map, "end")?,
        },
        Source::Preview => {
            if string(&map, "text")?.len() > MAX_SELECTION_DOCUMENT {
                return Err(INVALID_RESPONSE);
            }
            if oversized {
                // Nothing will look at it: not even moved.
                Pick::Text(String::new())
            } else {
                Pick::Text(take_string(&mut map, "text")?)
            }
        }
    };
    let tab_id = bounded_string(&map, "tabId", MAX_ID)?;
    Ok(Some(SelectionBody {
        source,
        tab_id,
        oversized,
        document: if oversized {
            String::new()
        } else {
            take_string(&mut map, "documentText")?
        },
        pick,
    }))
}

// ---- authorization -------------------------------------------------------

pub(super) enum Location {
    Inside { root_id: String, path: String },
    Outside { name: String },
}

/// The open roots as they were registered, deepest first. Building this asks
/// the filesystem nothing (it runs while the registry's read lock is held, and
/// a root is only opened when a path is checked against it).
pub(super) struct Roots(Vec<(String, PathBuf)>);
impl Roots {
    pub(super) fn from_pairs(pairs: Vec<(String, PathBuf)>) -> Self {
        let mut roots: Vec<_> = pairs
            .into_iter()
            // A network namespace is refused before the filesystem is asked
            // about it, as the disk tools do for a root.
            .filter(|(_, path)| confined::supported_root(path).is_ok())
            .collect();
        roots.sort_by_key(|(_, path)| std::cmp::Reverse(path.components().count()));
        Self(roots)
    }
    /// A path the webview sent is only a claim, checked in two steps. First,
    /// by its spelling alone and before any filesystem call: it must be
    /// absolute, have no `..`, not be in a network namespace and lie under a
    /// registered root through components the file tools accept. Only then is
    /// it resolved, the way the disk tools resolve a file: from the root, one
    /// directory handle at a time, refusing symlinks and reparse points. A
    /// file that is not on disk (deleted, or not saved yet) counts when its
    /// folder resolves that way.
    pub(super) fn locate(&self, raw: &str) -> Location {
        let outside = || Location::Outside {
            name: file_name(raw),
        };
        let path = Path::new(raw);
        if raw.contains('\0')
            || !path.is_absolute()
            || path.components().any(|part| part == Component::ParentDir)
            || confined::supported_root(path).is_err()
        {
            return outside();
        }
        for (id, root) in &self.0 {
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            let parts: Option<Vec<&str>> = relative
                .components()
                .map(|part| match part {
                    Component::Normal(name) => name.to_str(),
                    _ => None,
                })
                .collect();
            let joined = parts.map(|parts| parts.join("/"));
            return match joined {
                Some(path) if resolves(root, &path) => Location::Inside {
                    root_id: id.clone(),
                    path,
                },
                _ => outside(),
            };
        }
        outside()
    }
}

/// Is `relative` (already known to be under `root` by spelling) reachable
/// from the root by handles alone? Only a missing last component is allowed.
fn resolves(root: &Path, relative: &str) -> bool {
    let Ok(parts) = confined::components(relative, false) else {
        return false;
    };
    let Some((last, folders)) = parts.split_last() else {
        return false;
    };
    let Ok(root) = confined::root(root) else {
        return false;
    };
    let Ok(folder) = confined::open(&root, folders) else {
        return false;
    };
    if !folder.metadata().is_ok_and(|meta| meta.is_dir()) {
        return false;
    }
    match confined::child(&folder, last) {
        Ok(_) => true,
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
    }
}

fn file_name(raw: &str) -> String {
    raw.rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or("file")
        .to_owned()
}

fn file_json(mask: bool, location: &Option<Location>) -> Value {
    match location {
        None => Value::Null,
        Some(Location::Inside { root_id, path }) => {
            json!({"rootId": root_id, "path": scrub::text(mask, path)})
        }
        Some(Location::Outside { name }) => {
            json!({"name": scrub::text(mask, name), "outsideRoots": true})
        }
    }
}

fn locate_tab(roots: &Roots, file_path: Option<&str>, title: &str) -> Location {
    match file_path {
        Some(path) => roots.locate(path),
        // A draft has no file, so it is under no open root: treated as outside them.
        None => Location::Outside {
            name: title.to_owned(),
        },
    }
}

// ---- limits and masking ---------------------------------------------------

/// The longest prefix of `text` within `limit` bytes whose JSON encoding also
/// fits `budget`, cut on a character boundary.
fn clip(text: &str, limit: usize, budget: usize) -> (&str, bool) {
    let mut kept = 0;
    let mut encoded = 0;
    for ch in text.chars() {
        let width = match ch {
            '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
            '\u{0}'..='\u{1f}' => 6,
            _ => ch.len_utf8(),
        };
        if kept + ch.len_utf8() > limit || encoded + width > budget {
            return (&text[..kept], true);
        }
        kept += ch.len_utf8();
        encoded += width;
    }
    (text, false)
}

/// Cut first (raw), then mask with the cut known: a secret the cut falls in
/// the middle of is hidden up to the edge, and one that starts before it is
/// never completed by the part that was dropped.
fn limited_text(mask: bool, text: &str, limit: usize) -> (String, bool) {
    let (kept, truncated) = clip(text, limit, MAX_RESPONSE - RESPONSE_MARGIN);
    (scrub::block(mask, kept, truncated), truncated)
}

fn tabs_json(
    mask: bool,
    roots: &Roots,
    ids: &TabIds,
    data: &TabsData,
    deadline: Instant,
) -> Result<Value, &'static str> {
    let all: Vec<&str> = data
        .panes
        .iter()
        .flat_map(|pane| pane.tabs.iter().map(|tab| tab.id.as_str()))
        .collect();
    let mut opaque = ids.translate(&all)?.into_iter();
    // Resolving a path asks the filesystem, which can be slow: between two
    // tabs, a request that is past its deadline stops.
    let mut files = Vec::with_capacity(all.len());
    for tab in data.panes.iter().flat_map(|pane| &pane.tabs) {
        expired(deadline)?;
        files.push(tab.file_path.as_deref().map(|path| roots.locate(path)));
    }
    let mut files = files.into_iter();
    Ok(json!({"panes": data.panes.iter().map(|pane| json!({
        "index": pane.index,
        "active": pane.active,
        "tabs": pane.tabs.iter().map(|tab| json!({
            "id": opaque.next(),
            "title": scrub::text(mask, &tab.title),
            "file": file_json(mask, &files.next().flatten()),
            "active": tab.active,
            "dirty": tab.dirty,
        })).collect::<Vec<_>>(),
    })).collect::<Vec<_>>()}))
}

fn document_json(
    mask: bool,
    roots: &Roots,
    ids: &TabIds,
    doc: Option<DocumentBody>,
) -> Result<Value, &'static str> {
    let Some(doc) = doc else {
        return Ok(json!({"document": null}));
    };
    let location = Some(locate_tab(roots, doc.file_path.as_deref(), &doc.title));
    let mut document = json!({
        "tabId": ids.one(&doc.tab_id)?,
        "title": scrub::text(mask, &doc.title),
        "file": file_json(mask, &location),
        "dirty": doc.dirty,
        "language": scrub::text(mask, &doc.language),
    });
    // A file outside the open folders, or a draft, is named, never read out.
    if !matches!(location, Some(Location::Outside { .. })) {
        let (text, truncated) = limited_text(mask, &doc.text, DOCUMENT_LIMIT);
        document["text"] = json!(text);
        document["truncated"] = json!(truncated);
    }
    Ok(json!({"document": document}))
}

/// The UTF-16 offsets an editor counts in, as byte offsets of `text`. An offset
/// past the end, inside a surrogate pair, or a start after the end is invalid.
fn byte_range(text: &str, start: u32, end: u32) -> Result<(usize, usize), &'static str> {
    if start > end {
        return Err(INVALID_RESPONSE);
    }
    let (mut from, mut to) = (None, None);
    let mut units = 0u64;
    for (at, ch) in text.char_indices() {
        if units == u64::from(start) {
            from = Some(at);
        }
        if units == u64::from(end) {
            to = Some(at);
        }
        units += ch.len_utf16() as u64;
    }
    if units == u64::from(start) {
        from = Some(text.len());
    }
    if units == u64::from(end) {
        to = Some(text.len());
    }
    from.zip(to).ok_or(INVALID_RESPONSE)
}

/// `selected`, with every character the masked document hides replaced (one
/// `[secret]` per run). `hidden` answers by offset inside `selected`.
fn render(selected: &str, hidden: impl Fn(usize) -> bool) -> String {
    let mut out = String::with_capacity(selected.len());
    let mut run = false;
    for (at, ch) in selected.char_indices() {
        if hidden(at) {
            if !run {
                out.push_str("[secret]");
            }
            run = true;
        } else {
            out.push(ch);
            run = false;
        }
    }
    out
}

/// The selected text, masked in the context of the whole document: the
/// document is masked first and the range is cut out of that, so a value
/// selected on its own, or a slice of a PEM body, is hidden by the text
/// around it that the selection does not include. `None` for an empty range.
/// The document is masked whole (it is at most `DOCUMENT_LIMIT`: a larger one
/// never gets here), so the answer never depends on where a window would have
/// started.
fn masked_selection(
    mask: bool,
    doc: &str,
    pick: &Pick,
) -> Result<Option<(String, bool)>, &'static str> {
    match pick {
        Pick::Offsets { start, end } => {
            if doc.len() > DOCUMENT_LIMIT {
                return Err(UNAVAILABLE);
            }
            let (from, to) = byte_range(doc, *start, *end)?;
            if from == to {
                return Ok(None);
            }
            let (kept, truncated) = clip(
                &doc[from..to],
                SELECTION_LIMIT,
                MAX_RESPONSE - RESPONSE_MARGIN,
            );
            // The whole document, from its first byte: a secret that starts
            // anywhere before the range hides it.
            let masked = scrub::block_tracked(mask, doc, false);
            let text = render(kept, |at| !masked.visible[from + at]);
            Ok(Some((text, truncated)))
        }
        Pick::Text(text) => {
            if text.is_empty() {
                return Ok(None);
            }
            let (kept, truncated) = clip(text, SELECTION_LIMIT, MAX_RESPONSE - RESPONSE_MARGIN);
            // No offsets exist for rendered text: it must be found in the
            // source exactly once. Not found (the rendering differs from the
            // source), found more than once (even overlapping), or a document
            // too large to mask whole: refused.
            if doc.len() > DOCUMENT_LIMIT {
                return Err(UNAVAILABLE);
            }
            let at = doc.find(kept).ok_or(UNAVAILABLE)?;
            // A second occurrence, overlapping the first included (the search
            // restarts one character after it), makes the source ambiguous:
            // the same rendered text could sit where the document hides it and
            // where it does not, and the selection does not say which.
            let after = at + kept.chars().next().map_or(1, char::len_utf8);
            if doc[after..].contains(kept) {
                return Err(UNAVAILABLE);
            }
            let masked = scrub::block_tracked(mask, doc, false);
            let hidden: Vec<bool> = (0..kept.len())
                .map(|offset| !masked.visible[at + offset])
                .collect();
            Ok(Some((render(kept, |at| hidden[at]), truncated)))
        }
    }
}

fn selection_json(
    mask: bool,
    ids: &TabIds,
    selection: &SelectionBody,
    location: &Option<Location>,
) -> Result<Value, &'static str> {
    let mut value = json!({
        "source": match selection.source { Source::Editor => "editor", Source::Preview => "preview" },
        "tabId": ids.one(&selection.tab_id)?,
        "file": file_json(mask, location),
    });
    if !matches!(location, Some(Location::Outside { .. })) {
        // Before any masking: the cost of a request must not grow with a
        // document the answer cannot carry. Same result as a preview
        // selection the source does not contain.
        if selection.oversized {
            return Err(UNAVAILABLE);
        }
        let Some((text, truncated)) = masked_selection(mask, &selection.document, &selection.pick)?
        else {
            return Ok(json!({"selection": null}));
        };
        value["text"] = json!(text);
        value["truncated"] = json!(truncated);
    }
    Ok(json!({"selection": value}))
}

fn bounded(value: Value) -> Result<Value, &'static str> {
    if serde_json::to_vec(&value).map_err(|_| TOO_LARGE)?.len() > MAX_RESPONSE - 128 {
        return Err(TOO_LARGE);
    }
    Ok(value)
}

/// The request is past its deadline: its answer is already gone, so work that
/// has not finished must not go on.
fn expired(deadline: Instant) -> Result<(), &'static str> {
    if Instant::now() >= deadline {
        Err(TIMED_OUT)
    } else {
        Ok(())
    }
}

/// Run on the blocking pool: it resolves paths and masks text. The closure
/// owns a share of the request's admission slot, so the request counts as
/// busy until this work has really finished, however the wait ended; one that
/// only starts after the deadline does nothing.
async fn blocking<T: Send + 'static>(
    slot: &Arc<Slot>,
    deadline: Instant,
    work: impl FnOnce() -> Result<T, &'static str> + Send + 'static,
) -> Result<T, &'static str> {
    let held = slot.clone();
    tokio::task::spawn_blocking(move || {
        let _held = held;
        expired(deadline)?;
        work()
    })
    .await
    .map_err(|_| UNAVAILABLE)?
}

impl Registry {
    /// The registered roots, copied under the read lock and nothing else:
    /// the filesystem is asked after the lock is gone.
    fn roots_snapshot(&self) -> Result<Roots, &'static str> {
        let pairs = self
            .roots
            .read()
            .map_err(|_| UNAVAILABLE)?
            .iter()
            .map(|root| (root.id.clone(), root.path.clone()))
            .collect();
        Ok(Roots::from_pairs(pairs))
    }
    pub(super) async fn state(
        self: &Arc<Self>,
        method: &str,
        arguments: Value,
    ) -> Result<Value, &'static str> {
        if !arguments.is_null() && arguments != json!({}) {
            return Err(INVALID_ARGUMENTS);
        }
        // Admitted for as long as any of its work runs, not only while it waits.
        let slot = self.work.admit()?;
        // One policy value for the whole request, whatever the UI does meanwhile.
        let mask = self.policy.mask();
        let deadline = self.bridge.deadline();
        let this = self.clone();
        // The deadline covers the asking and the work after it.
        let work = async {
            let ask = |kind| self.bridge.request(&self.window, kind, deadline);
            match method {
                "list_open_tabs" => {
                    let data = ask(Kind::Tabs).await?;
                    blocking(&slot, deadline, move || {
                        let tabs = parse_tabs(&data)?;
                        tabs_json(
                            mask,
                            &this.roots_snapshot()?,
                            &this.tab_ids,
                            &tabs,
                            deadline,
                        )
                        .and_then(bounded)
                    })
                    .await
                }
                "get_active_document" => {
                    let data = ask(Kind::ActiveDocument).await?;
                    blocking(&slot, deadline, move || {
                        let document = parse_document(data)?;
                        bounded(document_json(
                            mask,
                            &this.roots_snapshot()?,
                            &this.tab_ids,
                            document,
                        )?)
                    })
                    .await
                }
                "get_selection" => {
                    let data = ask(Kind::Selection).await?;
                    let selection =
                        blocking(&slot, deadline, move || parse_selection(data)).await?;
                    let Some(selection) = selection else {
                        return Ok(json!({"selection": null}));
                    };
                    // The selection does not say which file it is in; the tab list
                    // does, so a selection in a file outside the open folders is
                    // not read out. Same deadline, same stable tab id.
                    let tabs = ask(Kind::Tabs).await?;
                    blocking(&slot, deadline, move || {
                        let tabs = parse_tabs(&tabs)?;
                        let tab = tabs
                            .panes
                            .iter()
                            .flat_map(|pane| &pane.tabs)
                            .find(|tab| tab.id == selection.tab_id)
                            .ok_or(UNAVAILABLE)?;
                        let location = Some(locate_tab(
                            &this.roots_snapshot()?,
                            tab.file_path.as_deref(),
                            &tab.title,
                        ));
                        bounded(selection_json(mask, &this.tab_ids, &selection, &location)?)
                    })
                    .await
                }
                _ => Err(INVALID_ARGUMENTS),
            }
        };
        tokio::time::timeout_at(deadline.into(), work)
            .await
            .map_err(|_| TIMED_OUT)?
    }
}

#[cfg(test)]
#[path = "state_tests.rs"]
mod tests;
