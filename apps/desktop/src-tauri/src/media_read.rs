//! Confined binary read for media (images, PDF) that the asset protocol
//! cannot serve: its glob scope (`**`) requires a literal leading dot, so any
//! path with a dot component (`.docs/img.png`) is refused. Opening the scope
//! to hidden folders would expose `~/.ssh` and friends to the webview, so the
//! frontend asks this command instead, for a file inside an opened root only.
//!
//! Contract: the file is reached through a chain of directory handles from the
//! canonical root (Unix: `openat` + `O_NOFOLLOW` per component, so a symlink
//! anywhere under the root is refused, never followed). Every failure returns
//! a fixed code and message that never contain the path.
use serde::Serialize;
use std::fs::File;
use std::io::Read;
use std::path::Path;

/// Largest file this command will return.
pub const MAX_BYTES: u64 = 100 * 1024 * 1024;

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

/// Read `relative` under `root`, at most [`MAX_BYTES`].
///
/// `is_open_root` is the only authority on which folders may be read: it gets
/// the CANONICAL root and must say whether it is one of the folders the user
/// has open (the webview-supplied `root` is never trusted by itself).
pub fn read_confined(
    root: &Path,
    relative: &str,
    is_open_root: &dyn Fn(&Path) -> bool,
) -> Result<Vec<u8>, ReadError> {
    read_confined_limit(root, relative, MAX_BYTES, is_open_root)
}

pub fn read_confined_limit(
    root: &Path,
    relative: &str,
    limit: u64,
    is_open_root: &dyn Fn(&Path) -> bool,
) -> Result<Vec<u8>, ReadError> {
    let parts = components(relative)?;
    if !root.is_absolute() {
        return Err(NOT_ALLOWED);
    }
    // Symlinks in the root itself are resolved (the user may have opened the
    // folder through one); membership is decided on the canonical path. A root
    // that cannot be canonicalized (missing, closed since the request) gets the
    // same `not_allowed` as a root that is not open, so the answer never
    // reveals whether an arbitrary path exists.
    let root = std::fs::canonicalize(root).map_err(|_| NOT_ALLOWED)?;
    if !is_open_root(&root) {
        return Err(NOT_ALLOWED);
    }
    // Symlinks UNDER the root are refused, even those that stay inside it: the
    // handle chain never follows a link (conservative choice, keeps the
    // confinement independent of where a link points; the plain asset path
    // still serves non-hidden files behind such links).
    let file = native::open(&root, &parts)?;
    read_limited(file, limit)
}

fn read_limited(file: File, limit: u64) -> Result<Vec<u8>, ReadError> {
    let meta = file.metadata().map_err(|_| UNAVAILABLE)?;
    if !meta.is_file() {
        return Err(NOT_REGULAR);
    }
    if meta.len() > limit {
        return Err(TOO_LARGE);
    }
    // The file may grow after the metadata read: bound the read itself.
    let mut bytes = Vec::with_capacity(usize::try_from(meta.len()).unwrap_or(0));
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| UNAVAILABLE)?;
    if bytes.len() as u64 > limit {
        return Err(TOO_LARGE);
    }
    Ok(bytes)
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

#[cfg(not(unix))]
mod native {
    use super::*;

    // No `openat` chain here: canonicalize the target and require it to stay
    // under the canonical root (a link that escapes resolves outside it).
    pub fn open(root: &Path, parts: &[&str]) -> Result<File, ReadError> {
        let mut target = root.to_path_buf();
        for part in parts {
            target.push(part);
        }
        let target = std::fs::canonicalize(&target).map_err(|_| UNAVAILABLE)?;
        if !target.starts_with(root) {
            return Err(NOT_ALLOWED);
        }
        File::open(&target).map_err(|_| UNAVAILABLE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn rd(root: &Path, relative: &str) -> Result<Vec<u8>, ReadError> {
        read_confined(root, relative, &|_| true)
    }
    fn rdl(root: &Path, relative: &str, limit: u64) -> Result<Vec<u8>, ReadError> {
        read_confined_limit(root, relative, limit, &|_| true)
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
        let (tx, rx) = std::sync::mpsc::channel();
        let r = root.clone();
        std::thread::spawn(move || tx.send(rd(&r, ".docs/pipe.png")).unwrap());
        let got = rx
            .recv_timeout(std::time::Duration::from_secs(5))
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
    use crate::mcp_server::{Registry, RootInput};
    use std::sync::Arc;

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
    fn via(registry: &Arc<Registry>, root: &Path, rel: &str) -> Result<Vec<u8>, ReadError> {
        read_confined(root, rel, &|canonical| registry.contains_root(canonical))
    }

    #[test]
    fn a_root_that_is_open_reads_and_one_that_is_not_open_is_refused() {
        // Mutation (drop the `is_open_root` check): the refused case reads.
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

    #[cfg(unix)]
    #[test]
    fn a_symlink_that_resolves_to_an_open_root_is_accepted_as_that_root() {
        use std::os::unix::fs::symlink;
        let (d, root) = fixture();
        let link = d.path().join("rootlink");
        symlink(&root, &link).unwrap();
        let registry = open_roots(&[&root]);
        assert_eq!(via(&registry, &link, "plain.pdf").unwrap(), b"%PDF-1");
        // And the reverse: the folder was opened through the link.
        let through_link = open_roots(&[&link]);
        assert_eq!(via(&through_link, &root, "plain.pdf").unwrap(), b"%PDF-1");
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
                while !stop.load(std::sync::atomic::Ordering::SeqCst) {
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
        let mut ok = 0;
        for _ in 0..300 {
            match via(&registry, &root, "plain.pdf") {
                Ok(bytes) => {
                    assert_eq!(bytes, b"%PDF-1");
                    ok += 1;
                }
                Err(e) => assert_eq!(e, NOT_ALLOWED),
            }
        }
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
        writer.join().unwrap();
        // After the writer stops with a known state, the outcome is definite.
        registry.replace(vec![]).unwrap();
        assert_eq!(via(&registry, &root, "plain.pdf").unwrap_err(), NOT_ALLOWED);
        let _ = ok;
    }
}
