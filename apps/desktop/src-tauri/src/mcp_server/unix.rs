//! Private, per-build Unix endpoint. The directory lock covers stale cleanup,
//! token publication and the entire listener lifetime (including app shutdown).
use super::{identity, random_id, Registry};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::net::{UnixListener, UnixStream};

pub type Stream = UnixStream;

fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "Unsafe MCP endpoint permissions",
    )
}

fn open_directory(path: &Path) -> io::Result<File> {
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC)
        .open(path)?;
    let meta = directory.metadata()?;
    if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o7777 != 0o700 {
        return Err(denied());
    }
    Ok(directory)
}

fn private_directory(path: &Path) -> io::Result<File> {
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => (),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => (),
        Err(e) => return Err(e),
    }
    open_directory(path)
}

pub fn default_directory() -> io::Result<PathBuf> {
    // No global /tmp fallback: only an existing user-private runtime/cache.
    let base = if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR") {
        PathBuf::from(runtime)
    } else {
        #[cfg(target_os = "macos")]
        {
            PathBuf::from(std::env::var_os("HOME").ok_or_else(denied)?).join("Library/Caches")
        }
        #[cfg(not(target_os = "macos"))]
        return Err(io::Error::new(io::ErrorKind::NotFound, super::NOT_RUNNING));
    };
    if !base.is_absolute() {
        return Err(denied());
    }
    // Runtime directories have the strict XDG permission contract. macOS's
    // cache parent may be traversable; the child is always private.
    #[cfg(not(target_os = "macos"))]
    let _parent = open_directory(&base)?;
    let root = base.join("markdraw");
    Ok(root.join(identity()))
}

pub fn prepare_parent(path: &Path) -> io::Result<()> {
    let _parent = private_directory(path.parent().ok_or_else(denied)?)?;
    Ok(())
}

fn child_file(dir: &File, name: &std::ffi::CStr, flags: i32) -> io::Result<File> {
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn token_file(dir: &File) -> io::Result<File> {
    let file = child_file(dir, c"token", libc::O_RDONLY | libc::O_NONBLOCK)?;
    let meta = file.metadata()?;
    if !meta.is_file()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o7777 != 0o600
        || meta.nlink() != 1
        || meta.len() != 64
    {
        return Err(denied());
    }
    Ok(file)
}

fn check_socket(path: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.file_type().is_socket()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o7777 != 0o600
    {
        return Err(denied());
    }
    Ok(())
}

fn unlink(dir: &File, name: &std::ffi::CStr) {
    // The directory FD pins the created namespace even if the pathname moves.
    unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0) };
}

// A fresh private namespace hides the socket until its final mode is set.
// Drop also cleans failed bind/chmod/rename attempts, without recursive removal.
struct Staging {
    directory: PathBuf,
    socket: PathBuf,
}
impl Drop for Staging {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.socket);
        let _ = fs::remove_dir(&self.directory);
    }
}
fn bind_private(socket: &Path) -> io::Result<std::os::unix::net::UnixListener> {
    let directory = socket
        .parent()
        .ok_or_else(denied)?
        .join(format!(".mcp-{}", &random_id()?[..8]));
    fs::DirBuilder::new().mode(0o700).create(&directory)?;
    let staging = Staging {
        socket: directory.join("ipc.sock"),
        directory,
    };
    let _private = open_directory(&staging.directory)?;
    let listener = std::os::unix::net::UnixListener::bind(&staging.socket)?;
    fs::set_permissions(&staging.socket, fs::Permissions::from_mode(0o600))?;
    fs::rename(&staging.socket, socket)?;
    Ok(listener)
}

pub struct Endpoint {
    directory: File,
    socket_created: bool,
    token_created: bool,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl Drop for Endpoint {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
        if self.socket_created {
            unlink(&self.directory, c"ipc.sock");
        }
        if self.token_created {
            unlink(&self.directory, c"token");
        }
        // flock is released by File::drop, after cleanup.
    }
}

impl Endpoint {
    pub fn start(path: &Path, registry: Arc<Registry>) -> io::Result<Self> {
        let directory = private_directory(path)?;
        if unsafe { libc::flock(directory.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::new(
                io::ErrorKind::AddrInUse,
                "MCP endpoint in use",
            ));
        }
        let socket = path.join("ipc.sock");
        match fs::symlink_metadata(&socket) {
            Ok(_) => {
                check_socket(&socket)?;
                // Refuse *all* failures other than an actual orphan; in
                // particular permission errors must never authorize deletion.
                match std::os::unix::net::UnixStream::connect(&socket) {
                    Ok(_) => {
                        return Err(io::Error::new(
                            io::ErrorKind::AddrInUse,
                            "MCP endpoint in use",
                        ))
                    }
                    Err(e) if e.kind() == io::ErrorKind::ConnectionRefused => (),
                    Err(e) => return Err(e),
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => (),
            Err(e) => return Err(e),
        }
        match fs::symlink_metadata(path.join("token")) {
            Ok(_) => {
                let _token = token_file(&directory)?;
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => (),
            Err(e) => return Err(e),
        }
        // Nothing is removed until both old artifacts have been validated and
        // we hold the lock proving no cooperating app is publishing them.
        unlink(&directory, c"ipc.sock");
        unlink(&directory, c"token");
        let mut endpoint = Self {
            directory,
            socket_created: false,
            token_created: false,
            task: None,
        };
        let listener = bind_private(&socket)?;
        endpoint.socket_created = true;
        listener.set_nonblocking(true)?;
        let token = random_id()?;
        let mut file = child_file(
            &endpoint.directory,
            c"token",
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        )?;
        endpoint.token_created = true;
        file.write_all(token.as_bytes())?;
        // Verify final permissions too: an unusual umask can remove required bits.
        drop(token_file(&endpoint.directory)?);
        let listener = UnixListener::from_std(listener)?;
        endpoint.task = Some(tokio::spawn(super::accept_loop(listener, registry, token)));
        Ok(endpoint)
    }
}

pub async fn connect(path: &Path) -> io::Result<(Stream, String)> {
    let directory = open_directory(path)?;
    let mut token = String::new();
    token_file(&directory)?.read_to_string(&mut token)?;
    check_socket(&path.join("ipc.sock"))?;
    let stream = UnixStream::connect(path.join("ipc.sock")).await?;
    Ok((stream, token))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staging_cleans_failed_publication() {
        let fixture = tempfile::tempdir_in(std::env::var_os("TMPDIR").unwrap()).unwrap();
        let destination = fixture.path().join("ipc.sock");
        fs::create_dir(&destination).unwrap(); // rename of a socket over a directory must fail
        assert!(bind_private(&destination).is_err());
        let entries: Vec<_> = fs::read_dir(fixture.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from("ipc.sock")]);
        fs::remove_dir(&destination).unwrap();
        let _listener = bind_private(&destination).unwrap();
        assert_eq!(fs::read_dir(fixture.path()).unwrap().count(), 1);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn final_socket_first_publication_is_private_rename() {
        use std::ffi::CString;
        let fixture = tempfile::tempdir_in(std::env::var_os("TMPDIR").unwrap()).unwrap();
        let raw = unsafe { libc::inotify_init1(libc::IN_CLOEXEC | libc::IN_NONBLOCK) };
        assert!(raw >= 0);
        let mut events = unsafe { File::from_raw_fd(raw) };
        let path = CString::new(fixture.path().as_os_str().as_encoded_bytes()).unwrap();
        assert!(
            unsafe {
                libc::inotify_add_watch(
                    events.as_raw_fd(),
                    path.as_ptr(),
                    libc::IN_CREATE | libc::IN_MOVED_TO,
                )
            } >= 0
        );
        let socket = fixture.path().join("ipc.sock");
        let _listener = bind_private(&socket).unwrap();
        let mut buffer = [0u8; 4096];
        let count = events.read(&mut buffer).unwrap();
        let mut offset = 0;
        let mut found = false;
        while offset < count {
            let event = unsafe {
                std::ptr::read_unaligned(buffer.as_ptr().add(offset).cast::<libc::inotify_event>())
            };
            let start = offset + std::mem::size_of::<libc::inotify_event>();
            let name = &buffer[start..start + event.len as usize];
            if name.starts_with(b"ipc.sock\0") {
                assert_eq!(
                    event.mask & libc::IN_CREATE,
                    0,
                    "final socket must never be created before chmod"
                );
                assert_ne!(event.mask & libc::IN_MOVED_TO, 0);
                check_socket(&socket).unwrap();
                found = true;
            }
            offset = start + event.len as usize;
        }
        assert!(found, "must observe the final publication");
        assert_eq!(fs::read_dir(fixture.path()).unwrap().count(), 1);
    }
}
