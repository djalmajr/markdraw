//! Confined binary read for media (images, PDF) that the asset protocol
//! cannot serve: its glob scope (`**`) requires a literal leading dot, so any
//! path with a dot component (`.docs/img.png`) is refused. Opening the scope
//! to hidden folders would expose `~/.ssh` and friends to the webview, so the
//! frontend asks this command instead, for a file inside an opened root only.
//!
//! Contract, in the order the checks run:
//! 1. the relative path is split and checked lexically (no I/O);
//! 2. a read slot is taken BEFORE the blocking pool is asked for a thread
//!    (at most [`MAX_CONCURRENT_READS`] reads at once, [`MAX_INFLIGHT_BYTES`]
//!    of file bytes in flight in total; beyond that the answer is [`BUSY`] at
//!    once, nothing queues, the pool is not touched). The slot and its bytes
//!    are held until the IPC response has been built from the bytes ([`serve`]);
//! 3. the received root is looked up by exact string among the registered
//!    roots BEFORE any filesystem access (an unregistered string, UNC paths
//!    included, never reaches the disk), and the file is opened while the
//!    registry guard is held (see `Registry::with_root`);
//! 4. the file is reached from the canonical root without following a link
//!    (Unix: `openat` + `O_NOFOLLOW` per component; Windows: a chain of
//!    handles opened with `FILE_OPEN_REPARSE_POINT`, each refused when its
//!    attributes say reparse point, so no I/O reaches a link's target; the
//!    final path of the OPEN handle must still be exactly root + components).
//!
//! Every failure returns a fixed code and message that never contain the path.
use serde::Serialize;
use std::fs::File;
use std::io::Read;
use std::path::{Component, Path};
use std::sync::Mutex;

/// Largest file this command will return.
pub const MAX_BYTES: u64 = 100 * 1024 * 1024;
/// Reads allowed at the same time.
pub const MAX_CONCURRENT_READS: usize = 2;
/// File bytes in flight (sum of the sizes of the reads in progress).
pub const MAX_INFLIGHT_BYTES: u64 = 200 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ReadError {
    pub code: &'static str,
    pub message: &'static str,
}

pub const NOT_ALLOWED: ReadError = ReadError {
    code: "not_allowed",
    message: "Path is not allowed",
};
pub const UNAVAILABLE: ReadError = ReadError {
    code: "unavailable",
    message: "File is unavailable",
};
pub const TOO_LARGE: ReadError = ReadError {
    code: "too_large",
    message: "File is too large",
};
pub const NOT_REGULAR: ReadError = ReadError {
    code: "not_regular",
    message: "Not a regular file",
};
pub const BUSY: ReadError = ReadError {
    code: "busy",
    message: "Too many reads in progress",
};

/// Admission control: a count of reads and a byte budget, both checked and
/// updated under one lock, so two reads racing for the last slot or the last
/// bytes cannot both get it. Refusal is immediate ([`BUSY`]); nothing waits.
pub struct Admission {
    max_reads: usize,
    max_bytes: u64,
    /// (reads in progress, bytes reserved)
    state: Mutex<(usize, u64)>,
}

/// A read slot plus the bytes reserved under it; both go back on drop, also
/// when the read fails or panics.
pub struct Permit<'a> {
    admission: &'a Admission,
    bytes: u64,
}

impl Admission {
    pub const fn new(max_reads: usize, max_bytes: u64) -> Self {
        Self {
            max_reads,
            max_bytes,
            state: Mutex::new((0, 0)),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, (usize, u64)> {
        // The state is two counters: a panic elsewhere cannot leave it torn.
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn admit(&self) -> Result<Permit<'_>, ReadError> {
        let mut state = self.lock();
        if state.0 >= self.max_reads {
            return Err(BUSY);
        }
        state.0 += 1;
        Ok(Permit {
            admission: self,
            bytes: 0,
        })
    }

    #[cfg(test)]
    fn in_flight(&self) -> (usize, u64) {
        *self.lock()
    }
}

impl Permit<'_> {
    /// Reserve `bytes` more of the budget, or [`BUSY`] when the total in
    /// flight would pass the limit (exactly the limit still fits).
    pub fn reserve(&mut self, bytes: u64) -> Result<(), ReadError> {
        let mut state = self.admission.lock();
        match state.1.checked_add(bytes) {
            Some(total) if total <= self.admission.max_bytes => {
                state.1 = total;
                self.bytes += bytes;
                Ok(())
            }
            _ => Err(BUSY),
        }
    }
}

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        let mut state = self.admission.lock();
        state.0 -= 1;
        state.1 -= self.bytes;
    }
}

/// Reads of the running app share this one budget.
static ADMISSION: Admission = Admission::new(MAX_CONCURRENT_READS, MAX_INFLIGHT_BYTES);

/// Opens the file under a canonical root (given by the authority).
pub type OpenUnder<'a> = &'a mut dyn FnMut(&Path) -> Result<File, ReadError>;

/// The only authority on which folders may be read. It gets the root string
/// exactly as the webview sent it (never canonicalized by this module) and
/// either refuses, or calls `open` with the CANONICAL root of the registered
/// folder and returns its result, keeping whatever guard protects the
/// registration until `open` has returned.
pub type Authorize<'a> = &'a dyn Fn(&str, OpenUnder<'_>) -> Result<File, ReadError>;

/// The production authority: the open-roots registry.
pub fn registry_authority(
    registry: &crate::mcp_server::Registry,
) -> impl Fn(&str, OpenUnder<'_>) -> Result<File, ReadError> + '_ {
    move |received, open| {
        registry
            .with_root(received, |canonical| open(canonical))
            .unwrap_or(Err(NOT_ALLOWED))
    }
}

/// Split a root-relative path into safe components. Rejects empty paths,
/// absolute paths, empty/`.`/`..` components, NUL, and (on Windows) `\` and `:`.
fn components(relative: &str) -> Result<Vec<&str>, ReadError> {
    if relative.is_empty() || relative.contains('\0') {
        return Err(NOT_ALLOWED);
    }
    if cfg!(windows) && relative.contains(['\\', ':']) {
        return Err(NOT_ALLOWED);
    }
    let parts: Vec<&str> = relative.split('/').collect();
    if parts
        .iter()
        .any(|p| p.is_empty() || *p == "." || *p == "..")
    {
        return Err(NOT_ALLOWED);
    }
    Ok(parts)
}

/// A read that was admitted but has not touched the disk yet: the lexical
/// checks passed and the slot is taken. It owns its inputs so it can move to
/// the blocking pool; dropping it gives the slot back.
pub struct Ticket<'a> {
    permit: Permit<'a>,
    root: String,
    parts: Vec<String>,
}

/// The bytes of a finished read, still holding the slot and the reserved
/// bytes. They go back only through [`Held::finish`], after the response has
/// been built from the bytes (or when it is dropped).
pub struct Held<'a> {
    bytes: Vec<u8>,
    permit: Permit<'a>,
}

impl<'a> Held<'a> {
    /// Build the response from the bytes while the budget is still held, then
    /// give the slot and the bytes back.
    pub fn finish<R>(self, build: impl FnOnce(Vec<u8>) -> R) -> R {
        let Held { bytes, permit } = self;
        let response = build(bytes);
        drop(permit);
        response
    }
}

/// Lexical checks (no I/O), then the slot: [`BUSY`] at once when the shared
/// budget is full.
fn begin_with<'a>(
    admission: &'a Admission,
    root: &str,
    relative: &str,
) -> Result<Ticket<'a>, ReadError> {
    let parts: Vec<String> = components(relative)?
        .into_iter()
        .map(str::to_owned)
        .collect();
    if !Path::new(root).is_absolute() {
        return Err(NOT_ALLOWED);
    }
    Ok(Ticket {
        permit: admission.admit()?,
        root: root.to_owned(),
        parts,
    })
}

impl<'a> Ticket<'a> {
    /// Authorize the root, open the file without following links and read at
    /// most `limit` bytes. On any error the slot goes back.
    fn read_limit(mut self, limit: u64, authorize: Authorize<'_>) -> Result<Held<'a>, ReadError> {
        let parts: Vec<&str> = self.parts.iter().map(String::as_str).collect();
        // Symlinks UNDER the root are refused, even those that stay inside it:
        // the open never follows a link (conservative choice, keeps the
        // confinement independent of where a link points; the plain asset path
        // still serves non-hidden files behind such links).
        let file = authorize(&self.root, &mut |canonical| native::open(canonical, &parts))?;
        let bytes = read_limited(file, limit, &mut self.permit)?;
        Ok(Held {
            bytes,
            permit: self.permit,
        })
    }

    pub fn read(self, authorize: Authorize<'_>) -> Result<Held<'a>, ReadError> {
        self.read_limit(MAX_BYTES, authorize)
    }
}

/// Serve one read: admit FIRST (a full budget answers [`BUSY`] without
/// scheduling anything), then run `job` (the blocking part) through `spawn`,
/// then build the response from the bytes while the budget is still held.
/// `spawn` is the blocking pool; `Err(())` from it means the task was lost.
pub async fn serve<S, F, J, B, R>(
    admission: &'static Admission,
    root: &str,
    relative: &str,
    job: J,
    spawn: S,
    build: B,
) -> Result<R, ReadError>
where
    J: FnOnce(Ticket<'static>) -> Result<Held<'static>, ReadError> + Send + 'static,
    S: FnOnce(Box<dyn FnOnce() -> Result<Held<'static>, ReadError> + Send>) -> F,
    F: std::future::Future<Output = Result<Result<Held<'static>, ReadError>, ()>>,
    B: FnOnce(Vec<u8>) -> R,
{
    let ticket = begin_with(admission, root, relative)?;
    let held = spawn(Box::new(move || job(ticket)))
        .await
        .map_err(|()| UNAVAILABLE)??;
    Ok(held.finish(build))
}

/// The one budget the running app shares.
pub fn shared_admission() -> &'static Admission {
    &ADMISSION
}

fn read_limited(file: File, limit: u64, permit: &mut Permit<'_>) -> Result<Vec<u8>, ReadError> {
    let meta = file.metadata().map_err(|_| UNAVAILABLE)?;
    if !meta.is_file() {
        return Err(NOT_REGULAR);
    }
    let len = meta.len();
    if len > limit {
        return Err(TOO_LARGE);
    }
    // Reserve before allocating: this is the memory the read will hold.
    permit.reserve(len)?;
    // The file may grow after the metadata read: the read is bounded by what
    // was reserved, and a file that changed size meanwhile is unavailable.
    let mut bytes = Vec::with_capacity(usize::try_from(len).unwrap_or(0));
    file.take(len + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| UNAVAILABLE)?;
    if bytes.len() as u64 > len {
        return Err(UNAVAILABLE);
    }
    Ok(bytes)
}

/// Is `found` (the final path of an open handle) exactly the canonical `root`
/// followed by `parts`? Names compare case-insensitively (NTFS), whole
/// components only: a link that lands elsewhere inside the root, one level
/// up, or outside it never matches.
#[cfg_attr(not(windows), allow(dead_code))]
fn is_expected_location(found: &Path, root: &Path, parts: &[&str]) -> bool {
    let mut found = found.components();
    for expected in root.components() {
        if found.next() != Some(expected) {
            return false;
        }
    }
    for part in parts {
        match found.next() {
            Some(Component::Normal(name))
                if name.to_str().is_some_and(|name| {
                    name == *part || name.to_lowercase() == part.to_lowercase()
                }) => {}
            _ => return false,
        }
    }
    found.next().is_none()
}

#[cfg(unix)]
mod native {
    use super::*;
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    fn open_at(parent: &File, name: &str, last: bool) -> Result<File, ReadError> {
        let name = CString::new(name).map_err(|_| NOT_ALLOWED)?;
        // Classify without following and without opening: a FIFO or device
        // must be refused before `open` can block on it.
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe {
            libc::fstatat(
                parent.as_raw_fd(),
                name.as_ptr(),
                &mut stat,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return Err(match std::io::Error::last_os_error().kind() {
                std::io::ErrorKind::NotFound => UNAVAILABLE,
                _ => NOT_ALLOWED,
            });
        }
        let kind = stat.st_mode & libc::S_IFMT;
        if kind == libc::S_IFLNK {
            return Err(NOT_ALLOWED);
        }
        if last && kind != libc::S_IFREG {
            return Err(if kind == libc::S_IFDIR {
                NOT_ALLOWED
            } else {
                NOT_REGULAR
            });
        }
        if !last && kind != libc::S_IFDIR {
            return Err(NOT_ALLOWED);
        }
        let mut flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
        if !last {
            flags |= libc::O_DIRECTORY;
        }
        // O_NONBLOCK: the entry can still be swapped for a FIFO after fstatat.
        let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(match std::io::Error::last_os_error().kind() {
                std::io::ErrorKind::NotFound => UNAVAILABLE,
                _ => NOT_ALLOWED,
            });
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    pub fn open(root: &Path, parts: &[&str]) -> Result<File, ReadError> {
        // Walk the (canonical, symlink-free) root with handles too.
        let mut dir = File::open("/").map_err(|_| UNAVAILABLE)?;
        for part in root.components() {
            match part {
                std::path::Component::RootDir => (),
                std::path::Component::Normal(name) => {
                    let name = std::str::from_utf8(name.as_bytes()).map_err(|_| NOT_ALLOWED)?;
                    dir = open_at(&dir, name, false)?;
                }
                _ => return Err(NOT_ALLOWED),
            }
        }
        let (last, dirs) = parts.split_last().ok_or(NOT_ALLOWED)?;
        for part in dirs {
            dir = open_at(&dir, part, false)?;
        }
        open_at(&dir, last, true)
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::PathBuf;
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;

    fn io_error(error: &std::io::Error) -> ReadError {
        match error.kind() {
            std::io::ErrorKind::NotFound => UNAVAILABLE,
            _ => NOT_ALLOWED,
        }
    }

    /// `\\?\C:\...` path the open handle really is, as the system resolved it.
    pub fn final_path(file: &File) -> Option<PathBuf> {
        let handle = file.as_raw_handle();
        let mut buf = vec![0u16; 1024];
        loop {
            // SAFETY: `buf` is valid for `buf.len()` u16 and `handle` stays
            // open for the whole call (`file` is borrowed).
            let n = unsafe {
                GetFinalPathNameByHandleW(handle as _, buf.as_mut_ptr(), buf.len() as u32, 0)
            } as usize;
            if n == 0 || n > 32 * 1024 {
                return None;
            }
            if n < buf.len() {
                buf.truncate(n);
                return Some(PathBuf::from(OsString::from_wide(&buf)));
            }
            // Too small: `n` is the size needed, NUL included.
            buf.resize(n, 0);
        }
    }

    pub fn open(root: &Path, parts: &[&str]) -> Result<File, ReadError> {
        // 1. A chain of handles from the volume root: every component is
        //    opened relative to the previous handle with
        //    FILE_OPEN_REPARSE_POINT and refused when its attributes say
        //    reparse point (symlink or junction, whichever way it points), so
        //    no I/O reaches the target of a link, not even a metadata query
        //    (`mcp_server::open_confined`, the MCP disk tools' open). The
        //    names carry no `\` or `:` (see `components`).
        let file = crate::mcp_server::open_confined(root, parts).map_err(|e| io_error(&e))?;
        // The last component must be a file (a directory is not readable).
        if file.metadata().map_err(|_| UNAVAILABLE)?.is_dir() {
            return Err(NOT_ALLOWED);
        }
        // 2. Still confirm on the OPEN handle where it really is. Nothing is
        //    read before this check.
        let found = final_path(&file).ok_or(NOT_ALLOWED)?;
        if !is_expected_location(&found, root, parts) {
            return Err(NOT_ALLOWED);
        }
        Ok(file)
    }
}

#[cfg(not(any(unix, windows)))]
mod native {
    use super::*;

    // No confined open on this platform: refuse rather than guess.
    pub fn open(_root: &Path, _parts: &[&str]) -> Result<File, ReadError> {
        Err(NOT_ALLOWED)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp_server::{Registry, RootInput};
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc, Barrier};
    use std::time::Duration;
    use tempfile::tempdir;

    /// Roomy admission for tests that are not about admission.
    fn roomy() -> Admission {
        Admission::new(64, u64::MAX)
    }
    fn s(path: &Path) -> &str {
        path.to_str().unwrap()
    }

    /// The whole blocking part, on a local admission, as the entry point runs it.
    fn read_with(
        admission: &Admission,
        root: &str,
        relative: &str,
        limit: u64,
        authorize: Authorize<'_>,
    ) -> Result<Vec<u8>, ReadError> {
        Ok(begin_with(admission, root, relative)?
            .read_limit(limit, authorize)?
            .finish(|bytes| bytes))
    }

    /// An admission that lives for the whole test run (what `serve` needs).
    fn leaked(max_reads: usize, max_bytes: u64) -> &'static Admission {
        Box::leak(Box::new(Admission::new(max_reads, max_bytes)))
    }

    /// Authority that trusts every root (only the canonical form matters).
    fn passthrough(root: &str, open: OpenUnder<'_>) -> Result<File, ReadError> {
        let canonical = fs::canonicalize(root).map_err(|_| NOT_ALLOWED)?;
        open(&canonical)
    }
    fn rd(root: &Path, relative: &str) -> Result<Vec<u8>, ReadError> {
        read_with(&roomy(), s(root), relative, MAX_BYTES, &passthrough)
    }
    fn rdl(root: &Path, relative: &str, limit: u64) -> Result<Vec<u8>, ReadError> {
        read_with(&roomy(), s(root), relative, limit, &passthrough)
    }

    fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempdir().unwrap();
        let root = dir.path().join("ws");
        fs::create_dir_all(root.join(".docs")).unwrap();
        fs::write(root.join(".docs/img.png"), b"\x89PNGdata").unwrap();
        fs::write(root.join("plain.pdf"), b"%PDF-1").unwrap();
        fs::write(dir.path().join("secret.txt"), b"outside").unwrap();
        (dir, root)
    }

    #[test]
    fn reads_a_file_inside_a_hidden_folder_of_the_root() {
        let (_d, root) = fixture();
        assert_eq!(rd(&root, ".docs/img.png").unwrap(), b"\x89PNGdata");
        assert_eq!(rd(&root, "plain.pdf").unwrap(), b"%PDF-1");
    }

    #[test]
    fn reads_when_the_root_itself_has_dot_components() {
        let dir = tempdir().unwrap();
        let root = dir.path().join(".local").join("notes");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("a.png"), b"x").unwrap();
        assert_eq!(rd(&root, "a.png").unwrap(), b"x");
    }

    #[test]
    fn rejects_dotdot_dot_empty_absolute_and_nul_paths_with_fixed_error() {
        let (_d, root) = fixture();
        for bad in [
            "../secret.txt",
            ".docs/../../secret.txt",
            "./plain.pdf",
            ".docs//img.png",
            "/etc/passwd",
            "",
            "plain.pdf/",
            "a\0b",
        ] {
            let err = rd(&root, bad).unwrap_err();
            assert_eq!(err, NOT_ALLOWED, "{bad:?}");
        }
    }

    #[test]
    fn rejects_a_relative_root_and_a_missing_root_without_an_existence_oracle() {
        let (d, root) = fixture();
        assert_eq!(rd(Path::new("ws"), "plain.pdf").unwrap_err(), NOT_ALLOWED);
        // Root closed between the request and the read.
        fs::remove_dir_all(&root).unwrap();
        assert_eq!(rd(&root, "plain.pdf").unwrap_err(), NOT_ALLOWED);
        drop(d);
    }

    #[test]
    fn missing_file_is_unavailable_without_leaking_the_path() {
        let (_d, root) = fixture();
        let err = rd(&root, ".docs/nope.png").unwrap_err();
        assert_eq!(err, UNAVAILABLE);
        assert!(!err.message.contains("nope") && !err.message.contains(".docs"));
    }

    #[test]
    fn a_directory_is_not_readable_as_a_file() {
        let (_d, root) = fixture();
        assert_eq!(rd(&root, ".docs").unwrap_err(), NOT_ALLOWED);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escaping_the_root_is_refused() {
        use std::os::unix::fs::symlink;
        let (d, root) = fixture();
        symlink(d.path().join("secret.txt"), root.join(".docs/link.png")).unwrap();
        symlink(d.path(), root.join("out")).unwrap();
        assert_eq!(rd(&root, ".docs/link.png").unwrap_err(), NOT_ALLOWED);
        // A directory link that leaves the root.
        assert_eq!(rd(&root, "out/secret.txt").unwrap_err(), NOT_ALLOWED);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_staying_inside_the_root_is_also_refused() {
        // Documented choice: the handle chain never follows links, so even an
        // in-root link is refused (the plain asset path still serves those).
        use std::os::unix::fs::symlink;
        let (_d, root) = fixture();
        symlink(root.join("plain.pdf"), root.join("inner.pdf")).unwrap();
        assert_eq!(rd(&root, "inner.pdf").unwrap_err(), NOT_ALLOWED);
    }

    #[cfg(unix)]
    #[test]
    fn fifo_is_refused_without_blocking() {
        let (_d, root) = fixture();
        let fifo = root.join(".docs/pipe.png");
        let c = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        let (tx, rx) = mpsc::channel();
        let r = root.clone();
        std::thread::spawn(move || tx.send(rd(&r, ".docs/pipe.png")).unwrap());
        let got = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("read of a FIFO must not block");
        assert_eq!(got.unwrap_err(), NOT_REGULAR);
    }

    #[test]
    fn file_over_the_limit_is_refused_with_a_fixed_error() {
        let (_d, root) = fixture();
        let big = vec![0u8; 1025];
        fs::write(root.join(".docs/big.png"), &big).unwrap();
        assert_eq!(rdl(&root, ".docs/big.png", 1024).unwrap_err(), TOO_LARGE);
        // Exactly at the limit still reads (control).
        assert_eq!(rdl(&root, ".docs/big.png", 1025).unwrap().len(), 1025);
    }

    #[test]
    fn errors_serialize_to_fixed_code_and_message_only() {
        let json = serde_json::to_string(&NOT_ALLOWED).unwrap();
        assert_eq!(
            json,
            r#"{"code":"not_allowed","message":"Path is not allowed"}"#
        );
        let json = serde_json::to_string(&BUSY).unwrap();
        assert_eq!(
            json,
            r#"{"code":"busy","message":"Too many reads in progress"}"#
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_root_that_is_itself_a_link_is_resolved_as_the_opened_folder() {
        // The user opened this folder, so a link as the ROOT is resolved
        // (canonicalize); only links under the root are refused.
        use std::os::unix::fs::symlink;
        let (d, root) = fixture();
        let link = d.path().join("rootlink");
        symlink(&root, &link).unwrap();
        assert_eq!(rd(&link, "plain.pdf").unwrap(), b"%PDF-1");
    }

    // ── the open-roots registry is the only authority ─────────────────────

    fn open_roots(paths: &[&Path]) -> Arc<Registry> {
        let registry = Arc::new(Registry::default());
        registry
            .replace(
                paths
                    .iter()
                    .enumerate()
                    .map(|(i, p)| RootInput {
                        name: format!("r{i}"),
                        path: p.to_path_buf(),
                    })
                    .collect(),
            )
            .unwrap();
        registry
    }
    /// Through the production authority, with its own roomy admission.
    fn via(registry: &Registry, root: &Path, rel: &str) -> Result<Vec<u8>, ReadError> {
        via_str(registry, s(root), rel)
    }
    fn via_str(registry: &Registry, root: &str, rel: &str) -> Result<Vec<u8>, ReadError> {
        read_with(
            &roomy(),
            root,
            rel,
            MAX_BYTES,
            &registry_authority(registry),
        )
    }

    #[test]
    fn a_root_that_is_open_reads_and_one_that_is_not_open_is_refused() {
        let (d, root) = fixture();
        let registry = open_roots(&[&root]);
        assert_eq!(
            via(&registry, &root, ".docs/img.png").unwrap(),
            b"\x89PNGdata"
        );
        // The parent folder holds `secret.txt` but is not open.
        assert_eq!(
            via(&registry, d.path(), "secret.txt").unwrap_err(),
            NOT_ALLOWED
        );
        // Nothing open at all.
        let none = open_roots(&[]);
        assert_eq!(via(&none, &root, "plain.pdf").unwrap_err(), NOT_ALLOWED);
    }

    #[test]
    fn a_webview_chosen_broad_root_cannot_reach_hidden_files() {
        // The attack: root = an ancestor of the open folder, hidden path below.
        let dir = tempdir().unwrap();
        let home = dir.path().join("home");
        let ws = home.join("ws");
        fs::create_dir_all(home.join(".ssh")).unwrap();
        fs::create_dir_all(&ws).unwrap();
        fs::write(home.join(".ssh/id_ed25519"), b"KEY").unwrap();
        let registry = open_roots(&[&ws]);
        assert_eq!(
            via(&registry, &home, ".ssh/id_ed25519").unwrap_err(),
            NOT_ALLOWED
        );
        // `..` out of the open root is refused by the component check.
        assert_eq!(
            via(&registry, &ws, "../.ssh/id_ed25519").unwrap_err(),
            NOT_ALLOWED
        );
        // Filesystem root as the requested root.
        assert_eq!(
            via(&registry, Path::new("/"), "etc/hostname").unwrap_err(),
            NOT_ALLOWED
        );
    }

    #[test]
    fn prefix_roots_do_not_match_an_open_root() {
        // `/a` and `/a/bc` against an open `/a/b`: whole components, not prefixes.
        let dir = tempdir().unwrap();
        let a = dir.path().join("a");
        let b = a.join("b");
        let bc = a.join("bc");
        fs::create_dir_all(&b).unwrap();
        fs::create_dir_all(&bc).unwrap();
        fs::write(b.join("ok.png"), b"b").unwrap();
        fs::write(bc.join("no.png"), b"bc").unwrap();
        fs::write(a.join("up.png"), b"a").unwrap();
        let registry = open_roots(&[&b]);
        assert_eq!(via(&registry, &b, "ok.png").unwrap(), b"b");
        assert_eq!(via(&registry, &a, "up.png").unwrap_err(), NOT_ALLOWED);
        assert_eq!(via(&registry, &bc, "no.png").unwrap_err(), NOT_ALLOWED);
        // A sub-folder of the open root is not itself an open root either.
        fs::create_dir_all(b.join("sub")).unwrap();
        fs::write(b.join("sub/x.png"), b"x").unwrap();
        assert_eq!(
            via(&registry, &b.join("sub"), "x.png").unwrap_err(),
            NOT_ALLOWED
        );
    }

    #[test]
    fn a_root_closed_after_being_open_is_refused() {
        let (_d, root) = fixture();
        let registry = open_roots(&[&root]);
        assert!(via(&registry, &root, "plain.pdf").is_ok());
        // `mcp_set_roots` replaces the registry: the root is closed.
        registry.replace(vec![]).unwrap();
        assert_eq!(via(&registry, &root, "plain.pdf").unwrap_err(), NOT_ALLOWED);
    }

    #[test]
    fn an_open_root_deleted_from_disk_is_refused_with_the_fixed_error() {
        let (_d, root) = fixture();
        let registry = open_roots(&[&root]);
        fs::remove_dir_all(&root).unwrap();
        let err = via(&registry, &root, "plain.pdf").unwrap_err();
        assert_eq!(err, NOT_ALLOWED);
        assert!(!err.message.contains("ws"));
    }

    // ── F3: the root string is authorized before any filesystem access ────

    #[cfg(unix)]
    #[test]
    fn only_the_registered_string_is_a_root_not_a_spelling_that_resolves_to_it() {
        // Mutation (canonicalize the received root, then compare): each of
        // these resolves to the registered folder and would read.
        use std::os::unix::fs::symlink;
        let (d, root) = fixture();
        let link = d.path().join("rootlink");
        symlink(&root, &link).unwrap();
        let registry = open_roots(&[&root]);
        assert_eq!(via(&registry, &root, "plain.pdf").unwrap(), b"%PDF-1");
        for spelling in [
            s(&link).to_string(),
            format!("{}/", s(&root)),
            format!("{}/./", s(&root)),
            format!("{}/../ws", s(&root)),
            format!("{}//", s(&root)),
        ] {
            assert_eq!(
                via_str(&registry, &spelling, "plain.pdf").unwrap_err(),
                NOT_ALLOWED,
                "{spelling:?}"
            );
        }
        // Registered through the link: that same string reads, the canonical
        // folder spelling does not (registered string is what counts).
        let through_link = open_roots(&[&link]);
        assert_eq!(via(&through_link, &link, "plain.pdf").unwrap(), b"%PDF-1");
        assert_eq!(
            via(&through_link, &root, "plain.pdf").unwrap_err(),
            NOT_ALLOWED
        );
    }

    #[test]
    fn an_unregistered_root_never_reaches_the_authority_open_nor_the_disk() {
        // UNC, device and verbatim spellings, plus a path that does not exist:
        // the registry refuses them by string, and `open` is never called.
        let (_d, root) = fixture();
        let registry = open_roots(&[&root]);
        let opened = AtomicUsize::new(0);
        let authority = registry_authority(&registry);
        for hostile in [
            r"\\server\share\.x",
            r"\\?\UNC\server\share",
            r"\\.\pipe\x",
            "//server/share/.x",
            "/definitely/not/registered",
            "C:/",
        ] {
            let got = read_with(&roomy(), hostile, "a.png", MAX_BYTES, &|r, open| {
                authority(r, &mut |c| {
                    opened.fetch_add(1, Ordering::SeqCst);
                    open(c)
                })
            });
            assert_eq!(got.unwrap_err(), NOT_ALLOWED, "{hostile:?}");
        }
        assert_eq!(opened.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn the_authority_gets_the_root_string_untouched() {
        let (_d, root) = fixture();
        let sent = format!("{}/./", s(&root));
        let seen = std::sync::Mutex::new(None);
        let got = read_with(&roomy(), &sent, "plain.pdf", MAX_BYTES, &|received, _| {
            *seen.lock().unwrap() = Some(received.to_string());
            Err(NOT_ALLOWED)
        });
        assert_eq!(got.unwrap_err(), NOT_ALLOWED);
        assert_eq!(seen.lock().unwrap().as_deref(), Some(sent.as_str()));
    }

    // ── F5: the registry guard is held until the file is open ─────────────

    #[test]
    fn closing_a_root_waits_for_a_read_that_is_opening_its_file() {
        // Mutation (drop the guard before `open`): the close completes while
        // the read is still inside `with_root`.
        let (_d, root) = fixture();
        let registry = open_roots(&[&root]);
        let (inside_tx, inside_rx) = mpsc::channel();
        let (go_tx, go_rx) = mpsc::channel::<()>();
        let (closed_tx, closed_rx) = mpsc::channel();
        let (registry_ref, root_ref) = (&*registry, &root);
        std::thread::scope(|scope| {
            scope.spawn(move || {
                registry_ref
                    .with_root(s(root_ref), |_| {
                        inside_tx.send(()).unwrap();
                        // Bounded: a failed assertion below must not hang the join.
                        go_rx.recv_timeout(Duration::from_secs(20)).ok();
                    })
                    .expect("root is open");
            });
            inside_rx.recv().unwrap();
            scope.spawn(move || {
                registry_ref.replace(vec![]).unwrap();
                closed_tx.send(()).unwrap();
            });
            assert!(
                closed_rx.recv_timeout(Duration::from_millis(300)).is_err(),
                "the close must wait for the open to finish"
            );
            go_tx.send(()).unwrap();
            closed_rx
                .recv_timeout(Duration::from_secs(10))
                .expect("the close completes once the open returned");
        });
        // After the close, no new read starts (control).
        assert_eq!(via(&registry, &root, "plain.pdf").unwrap_err(), NOT_ALLOWED);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_to_a_folder_that_is_not_open_is_refused() {
        use std::os::unix::fs::symlink;
        let (d, root) = fixture();
        let other = d.path().join("other");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("x.png"), b"x").unwrap();
        let link = d.path().join("sneaky");
        symlink(&other, &link).unwrap();
        let registry = open_roots(&[&root]);
        assert_eq!(via(&registry, &link, "x.png").unwrap_err(), NOT_ALLOWED);
    }

    #[test]
    fn reads_race_with_registry_replacement_without_panic_or_wrong_data() {
        // Shared state: `mcp_set_roots` writes the registry while reads happen.
        // Every read either returns the file or the fixed refusal; never data
        // from a root that was closed before the check, never a panic.
        let (_d, root) = fixture();
        let registry = open_roots(&[&root]);
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let writer = {
            let (registry, root, stop) = (registry.clone(), root.clone(), stop.clone());
            std::thread::spawn(move || {
                let mut open = false;
                while !stop.load(Ordering::SeqCst) {
                    let roots = if open {
                        vec![]
                    } else {
                        vec![RootInput {
                            name: "r".into(),
                            path: root.clone(),
                        }]
                    };
                    registry.replace(roots).unwrap();
                    open = !open;
                }
            })
        };
        for _ in 0..300 {
            match via(&registry, &root, "plain.pdf") {
                Ok(bytes) => assert_eq!(bytes, b"%PDF-1"),
                Err(e) => assert_eq!(e, NOT_ALLOWED),
            }
        }
        stop.store(true, Ordering::SeqCst);
        writer.join().unwrap();
        // After the writer stops with a known state, the outcome is definite.
        registry.replace(vec![]).unwrap();
        assert_eq!(via(&registry, &root, "plain.pdf").unwrap_err(), NOT_ALLOWED);
    }

    // ── F2: admission (reads in flight and bytes in flight) ───────────────

    #[test]
    fn the_production_limits_are_two_reads_and_200_mib() {
        assert_eq!(MAX_CONCURRENT_READS, 2);
        assert_eq!(MAX_INFLIGHT_BYTES, 200 * 1024 * 1024);
        assert_eq!(MAX_BYTES, 100 * 1024 * 1024);
    }

    #[test]
    fn exactly_two_reads_are_admitted_and_the_third_is_busy_until_one_ends() {
        let adm = Admission::new(2, u64::MAX);
        let first = adm.admit().unwrap();
        let _second = adm.admit().unwrap();
        assert_eq!(adm.admit().err(), Some(BUSY));
        drop(first);
        let _third = adm.admit().expect("a slot came back");
        assert_eq!(adm.in_flight(), (2, 0));
    }

    #[test]
    fn exactly_the_byte_budget_fits_and_one_byte_more_is_busy() {
        let adm = Admission::new(10, 200);
        let mut a = adm.admit().unwrap();
        let mut b = adm.admit().unwrap();
        let mut c = adm.admit().unwrap();
        a.reserve(100).unwrap();
        b.reserve(100).unwrap(); // exactly 200
        assert_eq!(c.reserve(1), Err(BUSY));
        assert_eq!(c.reserve(u64::MAX), Err(BUSY), "no overflow wrap-around");
        drop(b);
        c.reserve(100).expect("the released bytes are usable");
        assert_eq!(adm.in_flight(), (2, 200));
        drop((a, c));
        assert_eq!(adm.in_flight(), (0, 0));
    }

    #[test]
    fn sixteen_simultaneous_admissions_get_exactly_two_slots() {
        // Interleaved inside the check-then-increment window: all threads
        // reach `admit` together and hold their permit until all have tried.
        let adm = Admission::new(2, u64::MAX);
        let start = Barrier::new(16);
        let done = Barrier::new(16);
        let admitted = AtomicUsize::new(0);
        let busy = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..16 {
                scope.spawn(|| {
                    start.wait();
                    let permit = adm.admit();
                    match &permit {
                        Ok(_) => admitted.fetch_add(1, Ordering::SeqCst),
                        Err(e) => {
                            assert_eq!(*e, BUSY);
                            busy.fetch_add(1, Ordering::SeqCst)
                        }
                    };
                    done.wait();
                });
            }
        });
        assert_eq!(admitted.load(Ordering::SeqCst), 2);
        assert_eq!(busy.load(Ordering::SeqCst), 14);
        assert_eq!(adm.in_flight(), (0, 0));
    }

    #[test]
    fn a_third_read_is_busy_while_two_are_opening_and_runs_after_they_finish() {
        // Through the entry point: two reads held inside the authority (their
        // slots are taken before authorization), then a third and a fourth.
        let (_d, root) = fixture();
        let adm = Admission::new(2, u64::MAX);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (gate_txs, gate_rxs): (Vec<_>, Vec<_>) = (0..2).map(|_| mpsc::channel::<()>()).unzip();
        std::thread::scope(|scope| {
            let mut handles = Vec::new();
            for gate_rx in gate_rxs {
                let (adm, root, entered_tx) = (&adm, &root, entered_tx.clone());
                handles.push(scope.spawn(move || {
                    read_with(adm, s(root), "plain.pdf", MAX_BYTES, &|r, open| {
                        entered_tx.send(()).unwrap();
                        // Bounded: a failed assertion in the test body must not hang the join.
                        gate_rx.recv_timeout(Duration::from_secs(20)).ok();
                        passthrough(r, open)
                    })
                }));
            }
            entered_rx.recv().unwrap();
            entered_rx.recv().unwrap();
            let third = read_with(&adm, s(&root), "plain.pdf", MAX_BYTES, &passthrough);
            assert_eq!(third.unwrap_err(), BUSY);
            for gate_tx in &gate_txs {
                gate_tx.send(()).unwrap();
            }
            for handle in handles {
                assert_eq!(handle.join().unwrap().unwrap(), b"%PDF-1");
            }
        });
        let fourth = read_with(&adm, s(&root), "plain.pdf", MAX_BYTES, &passthrough);
        assert_eq!(fourth.unwrap(), b"%PDF-1");
        assert_eq!(adm.in_flight(), (0, 0));
    }

    #[test]
    fn a_file_over_the_byte_budget_is_busy_and_exactly_the_budget_reads() {
        let (_d, root) = fixture();
        fs::write(root.join("ten.bin"), [7u8; 10]).unwrap();
        fs::write(root.join("eleven.bin"), [7u8; 11]).unwrap();
        let adm = Admission::new(2, 10);
        let read = |rel| read_with(&adm, s(&root), rel, MAX_BYTES, &passthrough);
        assert_eq!(read("ten.bin").unwrap(), [7u8; 10]);
        assert_eq!(read("eleven.bin").unwrap_err(), BUSY);
        assert_eq!(
            adm.in_flight(),
            (0, 0),
            "a refused read gives everything back"
        );
    }

    #[test]
    fn every_outcome_gives_the_slot_and_the_bytes_back() {
        let (_d, root) = fixture();
        fs::write(root.join("big.bin"), [1u8; 64]).unwrap();
        let adm = Admission::new(2, 1024);
        let go =
            |root: &str, rel: &str, limit: u64| read_with(&adm, root, rel, limit, &passthrough);
        assert!(go(s(&root), "plain.pdf", MAX_BYTES).is_ok());
        assert_eq!(go(s(&root), "big.bin", 8).unwrap_err(), TOO_LARGE);
        assert_eq!(
            go(s(&root), "nope.bin", MAX_BYTES).unwrap_err(),
            UNAVAILABLE
        );
        assert_eq!(go(s(&root), ".docs", MAX_BYTES).unwrap_err(), NOT_ALLOWED);
        assert_eq!(go("/not/a/root", "x", MAX_BYTES).unwrap_err(), NOT_ALLOWED);
        assert_eq!(go(s(&root), "../x", MAX_BYTES).unwrap_err(), NOT_ALLOWED);
        assert_eq!(adm.in_flight(), (0, 0));
    }

    // ── admission before the pool, budget held until the response ─────────

    /// Run `serve` the way the command does, with a counting stand-in for the
    /// blocking pool (it runs the job inline).
    fn serve_counted<R>(
        admission: &'static Admission,
        root: &Path,
        relative: &str,
        spawned: &AtomicUsize,
        build: impl FnOnce(Vec<u8>) -> R,
    ) -> Result<R, ReadError> {
        tauri::async_runtime::block_on(serve(
            admission,
            s(root),
            relative,
            |ticket| ticket.read(&passthrough),
            |job| {
                spawned.fetch_add(1, Ordering::SeqCst);
                async move { Ok(job()) }
            },
            build,
        ))
    }

    #[test]
    fn a_full_budget_is_busy_before_anything_is_scheduled_on_the_pool() {
        let (_d, root) = fixture();
        let adm = leaked(2, u64::MAX);
        let (_a, _b) = (adm.admit().unwrap(), adm.admit().unwrap());
        let spawned = AtomicUsize::new(0);
        let got = serve_counted(adm, &root, "plain.pdf", &spawned, |bytes| bytes);
        assert_eq!(got.unwrap_err(), BUSY);
        assert_eq!(
            spawned.load(Ordering::SeqCst),
            0,
            "the blocking pool was not asked for a thread"
        );
        assert_eq!(adm.in_flight(), (2, 0), "the two held slots are untouched");
    }

    #[test]
    fn a_full_budget_answers_even_when_the_pool_never_runs_the_task() {
        // A saturated pool never starts the job: the refusal must not wait.
        let (_d, root) = fixture();
        let adm = leaked(1, u64::MAX);
        let _held = adm.admit().unwrap();
        let got = tauri::async_runtime::block_on(serve(
            adm,
            s(&root),
            "plain.pdf",
            |ticket| ticket.read(&passthrough),
            |_job| std::future::pending(),
            |bytes| bytes,
        ));
        assert_eq!(got.unwrap_err(), BUSY);
    }

    #[test]
    fn a_malformed_path_never_takes_a_slot_nor_the_pool() {
        let (_d, root) = fixture();
        let adm = leaked(2, u64::MAX);
        let spawned = AtomicUsize::new(0);
        for bad in ["../secret.txt", "", "a\0b", "./plain.pdf"] {
            let got = serve_counted(adm, &root, bad, &spawned, |bytes| bytes);
            assert_eq!(got.unwrap_err(), NOT_ALLOWED, "{bad:?}");
        }
        assert_eq!(spawned.load(Ordering::SeqCst), 0);
        assert_eq!(adm.in_flight(), (0, 0));
    }

    #[test]
    fn the_budget_is_held_until_the_response_is_built() {
        let (_d, root) = fixture();
        fs::write(root.join("ten.bin"), [7u8; 10]).unwrap();
        let adm = leaked(2, 15);
        let spawned = AtomicUsize::new(0);
        let seen = serve_counted(adm, &root, "ten.bin", &spawned, |bytes| {
            // While the response is being built, the bytes still count: a
            // second read of the same size is over the 15-byte budget...
            let during = adm.in_flight();
            let second = begin_with(adm, s(&root), "ten.bin")
                .and_then(|t| t.read(&passthrough))
                .err();
            (bytes, during, second, adm.in_flight())
        })
        .unwrap();
        assert_eq!(seen.0, [7u8; 10]);
        assert_eq!(seen.1, (1, 10), "slot and bytes held during the build");
        assert_eq!(seen.2, Some(BUSY), "no second read above the budget");
        assert_eq!(seen.3, (1, 10), "the refused read gave back only its own");
        assert_eq!(adm.in_flight(), (0, 0), "released after the response");
        // Control: with the first response gone, the same read fits.
        assert!(serve_counted(adm, &root, "ten.bin", &spawned, |b| b).is_ok());
    }

    #[test]
    fn exactly_the_budget_and_zero_bytes_through_the_entry_point() {
        let (_d, root) = fixture();
        fs::write(root.join("ten.bin"), [7u8; 10]).unwrap();
        fs::write(root.join("empty.bin"), b"").unwrap();
        let adm = leaked(2, 10);
        let spawned = AtomicUsize::new(0);
        let ten = serve_counted(adm, &root, "ten.bin", &spawned, |b| b).unwrap();
        assert_eq!(ten, [7u8; 10]);
        let empty = serve_counted(adm, &root, "empty.bin", &spawned, |b| b).unwrap();
        assert!(empty.is_empty());
        assert_eq!(adm.in_flight(), (0, 0));
    }

    #[test]
    fn a_failed_read_and_a_lost_task_give_the_slot_back() {
        let (_d, root) = fixture();
        let adm = leaked(1, u64::MAX);
        let spawned = AtomicUsize::new(0);
        let missing = serve_counted(adm, &root, "nope.bin", &spawned, |b| b);
        assert_eq!(missing.unwrap_err(), UNAVAILABLE);
        assert_eq!(adm.in_flight(), (0, 0));
        // The pool loses the task: the ticket moved into the job is dropped.
        let lost = tauri::async_runtime::block_on(serve(
            adm,
            s(&root),
            "plain.pdf",
            |ticket| ticket.read(&passthrough),
            |job| async move {
                drop(job);
                Err(())
            },
            |bytes| bytes,
        ));
        assert_eq!(lost.unwrap_err(), UNAVAILABLE);
        assert_eq!(adm.in_flight(), (0, 0));
    }

    // ── final location of an open handle (Windows check, pure logic) ──────

    #[test]
    fn the_final_path_must_be_exactly_the_root_plus_the_components() {
        let root = Path::new("/ws");
        let parts = ["a", ".docs", "x.png"];
        assert!(is_expected_location(
            Path::new("/ws/a/.docs/x.png"),
            root,
            &parts
        ));
        // NTFS is case-insensitive: the on-disk casing may differ.
        assert!(is_expected_location(
            Path::new("/ws/A/.Docs/X.PNG"),
            root,
            &parts
        ));
        for wrong in [
            "/ws/a/.docs",          // too short
            "/ws/a/.docs/x.png/y",  // too long
            "/other/a/.docs/x.png", // outside the root
            "/ws/b/.docs/x.png",    // a link landed on a sibling inside the root
            "/ws/a/x.png",          // a link skipped a level
            "/ws2/a/.docs/x.png",   // prefix, not a component
            "/ws/a/.docs/../x.png", // not normal components
            "/",
        ] {
            assert!(
                !is_expected_location(Path::new(wrong), root, &parts),
                "{wrong}"
            );
        }
    }

    // ── Windows: reparse points and junctions (the native CI runs these) ──

    #[cfg(windows)]
    fn junction(link: &Path, target: &Path) {
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .expect("cmd runs");
        assert!(
            status.status.success(),
            "mklink /J failed: {}",
            String::from_utf8_lossy(&status.stdout)
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_to_a_folder_outside_the_root_is_refused() {
        let (d, root) = fixture();
        junction(&root.join("out"), d.path());
        assert_eq!(rd(&root, "out/secret.txt").unwrap_err(), NOT_ALLOWED);
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_to_a_folder_inside_the_root_is_also_refused() {
        let (_d, root) = fixture();
        junction(&root.join("alias"), &root.join(".docs"));
        assert_eq!(rd(&root, "alias/img.png").unwrap_err(), NOT_ALLOWED);
        // The real path of the same file still reads (control).
        assert_eq!(rd(&root, ".docs/img.png").unwrap(), b"\x89PNGdata");
    }

    #[cfg(windows)]
    #[test]
    fn a_file_symlink_inside_or_outside_the_root_is_refused() {
        use std::os::windows::fs::symlink_file;
        let (d, root) = fixture();
        // Creating a symlink needs a privilege some accounts lack
        // (ERROR_PRIVILEGE_NOT_HELD = 1314): skip with a message ONLY then,
        // and never on CI, where the runner has it. Any other error is a
        // failure of the test, not a reason to skip.
        if let Err(e) = symlink_file(d.path().join("secret.txt"), root.join("out.png")) {
            assert!(
                e.raw_os_error() == Some(1314) && std::env::var_os("CI").is_none(),
                "cannot create a symlink: {e}"
            );
            eprintln!("skipped: this account lacks the symlink privilege ({e})");
            return;
        }
        symlink_file(root.join("plain.pdf"), root.join("in.pdf")).unwrap();
        assert_eq!(rd(&root, "out.png").unwrap_err(), NOT_ALLOWED);
        assert_eq!(rd(&root, "in.pdf").unwrap_err(), NOT_ALLOWED);
    }

    #[cfg(windows)]
    #[test]
    fn the_open_handle_is_confirmed_to_sit_at_the_expected_location() {
        // A real file read goes through `final_path`: it must have matched.
        let (_d, root) = fixture();
        let canonical = fs::canonicalize(&root).unwrap();
        let file = native::open(&canonical, &[".docs", "img.png"]).unwrap();
        let found = native::final_path(&file).expect("final path");
        assert!(is_expected_location(
            &found,
            &canonical,
            &[".docs", "img.png"]
        ));
    }
}
