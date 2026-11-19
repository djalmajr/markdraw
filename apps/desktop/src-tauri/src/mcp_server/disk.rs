use super::{confined, random_id, scrub, Registry};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader},
    sync::Mutex,
    time::{Duration, Instant},
};

const BYTE_LIMIT: usize = 1024 * 1024;
const LINE_LIMIT: usize = 2000;
const LIST_LIMIT: usize = 500;
const SEARCH_LIMIT: usize = 200;
// Leave time for serialization and IPC within the five-second outer deadline.
const WORK_TIME: Duration = Duration::from_secs(4);
type Result<T> = std::result::Result<T, &'static str>;
#[derive(Clone)]
enum Job {
    Dir(String, usize),
    File(String, usize),
}
enum Cursor {
    List {
        root: String,
        path: String,
        offset: usize,
    },
    Search {
        root: String,
        query: String,
        jobs: Vec<Job>,
    },
}
#[derive(Default)]
pub(super) struct Cursors(Mutex<HashMap<String, Cursor>>);
impl Cursors {
    fn take(&self, token: &str) -> Result<Cursor> {
        if token.len() != 64 {
            return Err("invalid cursor");
        }
        self.0
            .lock()
            .map_err(|_| "not allowed")?
            .remove(token)
            .ok_or("invalid cursor")
    }
    fn insert(&self, cursor: Cursor) -> Result<String> {
        let mut map = self.0.lock().map_err(|_| "not allowed")?;
        if map.len() >= 128 {
            return Err("too many cursors");
        }
        let token = random_id().map_err(|_| "not allowed")?;
        map.insert(token.clone(), cursor);
        Ok(token)
    }
    pub(super) fn retain_roots(&self, ids: &[String]) {
        if let Ok(mut map) = self.0.lock() {
            map.retain(|_, cursor| {
                ids.contains(match cursor {
                    Cursor::List { root, .. } | Cursor::Search { root, .. } => root,
                })
            });
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListArgs {
    root_id: String,
    path: Option<String>,
    cursor: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadArgs {
    #[serde(rename = "root_id")]
    _root_id: String,
    path: String,
    start_line: Option<usize>,
    end_line: Option<usize>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchArgs {
    root_id: String,
    query: String,
    cursor: Option<String>,
}
fn args<T: serde::de::DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|_| "invalid arguments")
}
fn fs_error(error: std::io::Error) -> &'static str {
    match error.kind() {
        std::io::ErrorKind::NotFound => "not found",
        _ => "not allowed",
    }
}
fn resolve(root: &File, path: &str, allow_root: bool) -> Result<File> {
    confined::open(root, &confined::components(path, allow_root)?).map_err(fs_error)
}
fn relative(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.into()
    } else {
        format!("{parent}/{name}")
    }
}
fn ignored(name: &str, dir: bool) -> bool {
    name.starts_with('.')
        || (dir
            && (crate::ALWAYS_IGNORED_DIRS.contains(&name)
                || crate::HIDDEN_TOOL_DIRS.contains(&name)))
}
fn timed_out(deadline: Instant) -> bool {
    Instant::now() >= deadline
}

impl Registry {
    pub(super) fn disk(&self, method: &str, arguments: Value) -> Result<Value> {
        let deadline = Instant::now() + WORK_TIME;
        // Read ownership is held until every handle has been dropped. Closing
        // a root linearizes at replace's write lock and invalidates cursors.
        let roots = self.roots.read().map_err(|_| "not allowed")?;
        let id = arguments
            .get("root_id")
            .and_then(Value::as_str)
            .ok_or("invalid arguments")?;
        let authorized = roots.iter().find(|r| r.id == id).ok_or("root closed")?;
        confined::supported_root(&authorized.path)?;
        let root = confined::root(&authorized.path).map_err(fs_error)?;
        let result = match method {
            "list_files" => self.list_files(&root, args(arguments)?, deadline),
            "read_file" => read_file(&root, args(arguments)?, deadline),
            "search_workspace" => self.search(&root, args(arguments)?, deadline),
            _ => Err("invalid arguments"),
        }?;
        if serde_json::to_vec(&result)
            .map_err(|_| "not allowed")?
            .len()
            > super::MAX_RESPONSE - 128
        {
            return Err("not allowed");
        }
        Ok(result)
    }
    fn list_files(&self, root: &File, a: ListArgs, deadline: Instant) -> Result<Value> {
        if a.path.as_deref() == Some("") {
            return Err("not allowed");
        }
        let path = a.path.unwrap_or_default();
        // An explicitly empty path was rejected above;
        // absent path denotes the root.
        let mut offset = 0;
        if let Some(token) = a.cursor {
            match self.cursors.take(&token)? {
                Cursor::List {
                    root,
                    path: old,
                    offset: n,
                } if root == a.root_id && old == path => offset = n,
                _ => return Err("invalid cursor"),
            }
        }
        let dir = resolve(root, &path, true)?;
        if !dir.metadata().map_err(fs_error)?.is_dir() {
            return Err("not allowed");
        }
        let mut entries = Vec::new();
        let mut seen = 0;
        let mut more = false;
        for name in confined::entries(&dir).map_err(fs_error)? {
            if timed_out(deadline) {
                if entries.is_empty() {
                    return Err("timed out");
                }
                more = true;
                break;
            }
            let name = name.map_err(fs_error)?;
            confined::components(&name, false)?;
            let file = match confined::child(&dir, &name) {
                Ok(f) => f,
                Err(_) => continue,
            };
            let metadata = file.metadata().map_err(fs_error)?;
            if seen < offset {
                seen += 1;
                continue;
            }
            if entries.len() == LIST_LIMIT {
                more = true;
                break;
            }
            if timed_out(deadline) {
                if entries.is_empty() {
                    return Err("timed out");
                }
                more = true;
                break;
            }
            seen += 1;
            entries.push(json!({"name":scrub::short_text(&name),"path":scrub::short_text(&relative(&path,&name)),"kind":if metadata.is_dir(){"dir"}else{"file"}}));
        }
        let mut result = json!({"entries":entries});
        if more {
            result["next_cursor"] = json!(self.cursors.insert(Cursor::List {
                root: a.root_id,
                path,
                offset: seen
            })?);
        }
        Ok(result)
    }
    fn search(&self, root: &File, a: SearchArgs, deadline: Instant) -> Result<Value> {
        if a.query.is_empty() || a.query.len() > super::MAX_FRAME {
            return Err("invalid arguments");
        }
        let mut jobs = match a.cursor {
            None => vec![Job::Dir(String::new(), 0)],
            Some(token) => match self.cursors.take(&token)? {
                Cursor::Search { root, query, jobs } if root == a.root_id && query == a.query => {
                    jobs
                }
                _ => return Err("invalid cursor"),
            },
        };
        let mut matches = Vec::new();
        // Fetch one lookahead match so an exactly-full final page has no cursor.
        let mut lookahead = None;
        while let Some(job) = jobs.pop() {
            if timed_out(deadline) {
                jobs.push(job);
                break;
            }
            match job {
                Job::Dir(path, offset) => {
                    let dir = match resolve(root, &path, true) {
                        Ok(d) => d,
                        Err(_) => continue,
                    };
                    let read = match confined::entries(&dir) {
                        Ok(r) => r,
                        Err(_) => continue,
                    };
                    let mut children = Vec::new();
                    let mut seen = 0;
                    let mut resume = None;
                    for name in read {
                        if timed_out(deadline) {
                            resume = Some(seen);
                            break;
                        }
                        let name = match name {
                            Ok(n) => n,
                            Err(_) => continue,
                        };
                        if seen < offset {
                            seen += 1;
                            continue;
                        }
                        if children.len() == LIST_LIMIT {
                            resume = Some(seen);
                            break;
                        }
                        seen += 1;
                        if confined::components(&name, false).is_err() {
                            continue;
                        }
                        let child = match confined::child(&dir, &name) {
                            Ok(f) => f,
                            Err(_) => continue,
                        };
                        let meta = match child.metadata() {
                            Ok(m) => m,
                            Err(_) => continue,
                        };
                        if ignored(&name, meta.is_dir()) {
                            continue;
                        }
                        let path = relative(&path, &name);
                        if meta.is_dir() {
                            children.push(Job::Dir(path, 0));
                        } else if meta.len() <= crate::FIND_IN_FILES_FILE_SIZE_LIMIT {
                            children.push(Job::File(path, 0));
                        }
                    }
                    if let Some(offset) = resume {
                        jobs.push(Job::Dir(path, offset));
                    }
                    jobs.extend(children.into_iter().rev());
                }
                Job::File(path, offset) => {
                    let file = match resolve(root, &path, false) {
                        Ok(f) => f,
                        Err(_) => continue,
                    };
                    if file.metadata().map_err(fs_error)?.len()
                        > crate::FIND_IN_FILES_FILE_SIZE_LIMIT
                    {
                        continue;
                    }
                    // Read at most the app's per-file search limit, even if a
                    // concurrent writer grows the file after metadata.
                    use std::io::Read;
                    let mut bytes = Vec::new();
                    file.take(crate::FIND_IN_FILES_FILE_SIZE_LIMIT + 1)
                        .read_to_end(&mut bytes)
                        .map_err(fs_error)?;
                    if bytes.len() as u64 > crate::FIND_IN_FILES_FILE_SIZE_LIMIT
                        || bytes.contains(&0)
                    {
                        continue;
                    }
                    let text = match std::str::from_utf8(&bytes) {
                        Ok(t) => t,
                        Err(_) => continue,
                    };
                    // Advance redaction state from the beginning of the file, including
                    // lines before a cursor, before selecting matching lines.
                    let mut stream = scrub::Stream::default();
                    for (index, line) in text.lines().enumerate() {
                        let safe = stream.line(line);
                        if index < offset {
                            continue;
                        }
                        if timed_out(deadline) {
                            jobs.push(Job::File(path.clone(), index));
                            break;
                        }
                        if safe.contains(&a.query) {
                            if matches.len() == SEARCH_LIMIT {
                                lookahead = Some(Job::File(path.clone(), index));
                                break;
                            }
                            matches.push(json!({"path":scrub::short_text(&path),"line":index+1,"text":safe.chars().take(500).collect::<String>()}));
                        }
                    }
                    if lookahead.is_some() {
                        break;
                    }
                }
            }
        }
        if let Some(job) = lookahead {
            jobs.push(job);
        }
        if matches.is_empty() && !jobs.is_empty() && timed_out(deadline) {
            return Err("timed out");
        }
        let mut result = json!({"matches":matches});
        if !jobs.is_empty() {
            result["next_cursor"] = json!(self.cursors.insert(Cursor::Search {
                root: a.root_id,
                query: a.query,
                jobs
            })?);
        }
        Ok(result)
    }
}

// Bound retained line bytes while validating the ENTIRE stream (including
// discarded tails). UTF-8 codepoints split across BufRead chunks are carried.
fn line(reader: &mut impl BufRead, deadline: Instant) -> Result<Option<(String, bool)>> {
    let mut kept = Vec::new();
    let mut pending = Vec::new();
    let mut any = false;
    let mut overflow = false;
    loop {
        if timed_out(deadline) {
            return Err("timed out");
        }
        let chunk = reader.fill_buf().map_err(fs_error)?;
        if chunk.is_empty() {
            if !pending.is_empty() {
                return Err("not a text file");
            }
            return if any {
                Ok(Some((
                    String::from_utf8(kept).map_err(|_| "not a text file")?,
                    overflow,
                )))
            } else {
                Ok(None)
            };
        }
        any = true;
        let end = chunk.iter().position(|b| *b == b'\n');
        let count = end.map_or(chunk.len(), |n| n + 1);
        let bytes = &chunk[..count];
        if bytes.contains(&0) {
            return Err("not a text file");
        }
        pending.extend_from_slice(bytes);
        let valid = match std::str::from_utf8(&pending) {
            Ok(_) => pending.len(),
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            Err(_) => return Err("not a text file"),
        };
        if !overflow && kept.len() < BYTE_LIMIT {
            let mut n = valid.min(BYTE_LIMIT - kept.len());
            while std::str::from_utf8(&pending[..n]).is_err() {
                n -= 1;
            }
            kept.extend_from_slice(&pending[..n]);
            overflow |= n < valid;
        } else {
            overflow |= valid > 0;
        }
        pending.drain(..valid);
        reader.consume(count);
        if end.is_some() {
            if !pending.is_empty() {
                return Err("not a text file");
            }
            return Ok(Some((
                String::from_utf8(kept).map_err(|_| "not a text file")?,
                overflow,
            )));
        }
    }
}
fn read_file(root: &File, a: ReadArgs, deadline: Instant) -> Result<Value> {
    let start = a.start_line.unwrap_or(1);
    let end = a.end_line.unwrap_or(usize::MAX);
    if start == 0 || end < start {
        return Err("invalid arguments");
    }
    let file = resolve(root, &a.path, false)?;
    if !file.metadata().map_err(fs_error)?.is_file() {
        return Err("not allowed");
    }
    let mut reader = BufReader::new(file);
    let mut stream = scrub::Stream::default();
    let mut content = String::new();
    let mut total = 0;
    let mut returned = 0;
    let mut encoded = 0;
    let mut last = start.saturating_sub(1);
    let mut truncated = false;
    let mut opaque_tail = false;
    while let Some((text, overflow)) = line(&mut reader, deadline)? {
        total += 1;
        let (body, ending) = if let Some(body) = text.strip_suffix("\r\n") {
            (body, "\r\n")
        } else if let Some(body) = text.strip_suffix('\n') {
            (body, "\n")
        } else {
            (text.as_str(), "")
        };
        let mut safe = if opaque_tail {
            "[secret]".to_owned()
        } else {
            stream.line_with_cut(body, overflow)
        };
        safe.push_str(ending);
        opaque_tail |= overflow;
        if total < start || total > end {
            continue;
        }
        if returned == LINE_LIMIT
            || content.len() == BYTE_LIMIT
            || encoded >= super::MAX_RESPONSE - 1030
        {
            truncated = true;
            continue;
        }
        let available = BYTE_LIMIT - content.len();
        let mut n = 0;
        for ch in safe.chars() {
            let width = match ch {
                '"' | '\\' => 2,
                '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
                '\u{0}'..='\u{1f}' => 6,
                _ => ch.len_utf8(),
            };
            if n + ch.len_utf8() > available || encoded + width > super::MAX_RESPONSE - 1024 {
                break;
            }
            n += ch.len_utf8();
            encoded += width;
        }
        content.push_str(&safe[..n]);
        returned += 1;
        last = total;
        truncated |= n < safe.len() || overflow;
    }
    Ok(
        json!({"content":content,"total_lines":total,"start_line":start,"end_line":last,"truncated":truncated}),
    )
}

#[cfg(test)]
mod tests;
