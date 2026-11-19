//! Filesystem authority is a chain of directory handles, never a checked path.
use std::{fs::File, io, path::Path};

// Classify Windows namespaces textually so the policy is testable on any
// host. This runs before opening a registered root for each disk tool.
pub(super) fn supported_root(path: &Path) -> Result<(), &'static str> {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let verbatim_disk = normalized.strip_prefix("//?/").is_some_and(|rest| {
        let bytes = rest.as_bytes();
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/'
    });
    if normalized.starts_with("//") && !verbatim_disk {
        return Err("root not supported");
    }
    Ok(())
}

pub(in crate::mcp_server) fn components(
    path: &str,
    allow_root: bool,
) -> Result<Vec<&str>, &'static str> {
    if path.is_empty() {
        return if allow_root {
            Ok(vec![])
        } else {
            Err("not allowed")
        };
    }
    if path.contains(['\\', ':', '\0'])
        || path
            .split('/')
            .any(|p| p.is_empty() || p == ".." || p == ".")
    {
        return Err("not allowed");
    }
    Ok(path.split('/').collect())
}

#[cfg(unix)]
mod native {
    use super::*;
    use std::{
        ffi::{CStr, CString},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::ffi::OsStrExt,
        },
    };
    fn at(parent: &File, name: &[u8]) -> io::Result<File> {
        let name = CString::new(name)?;
        // Reject known special files before opening them; re-check the opened
        // handle as well, since the entry can change after this metadata read.
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
            return Err(io::Error::last_os_error());
        }
        let kind = stat.st_mode & libc::S_IFMT;
        if kind != libc::S_IFREG && kind != libc::S_IFDIR && kind != libc::S_IFLNK {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        // NONBLOCK prevents FIFOs/devices from blocking before fstat rejects them.
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let kind = file.metadata()?.file_type();
        if !kind.is_dir() && !kind.is_file() {
            return Err(io::Error::from(io::ErrorKind::PermissionDenied));
        }
        Ok(file)
    }
    pub(in crate::mcp_server) fn root(path: &Path) -> io::Result<File> {
        let mut dir = File::open("/")?;
        for part in path.components() {
            match part {
                std::path::Component::RootDir => (),
                std::path::Component::Normal(name) => {
                    dir = at(&dir, name.as_bytes())?;
                    if !dir.metadata()?.is_dir() {
                        return Err(io::ErrorKind::NotADirectory.into());
                    }
                }
                _ => return Err(io::ErrorKind::PermissionDenied.into()),
            }
        }
        Ok(dir)
    }
    pub(in crate::mcp_server) fn child(parent: &File, name: &str) -> io::Result<File> {
        at(parent, name.as_bytes())
    }
    pub(in crate::mcp_server) struct Entries(*mut libc::DIR);
    impl Drop for Entries {
        fn drop(&mut self) {
            unsafe {
                libc::closedir(self.0);
            }
        }
    }
    impl Iterator for Entries {
        type Item = io::Result<String>;
        fn next(&mut self) -> Option<Self::Item> {
            loop {
                // readdir's returned storage belongs to this private DIR stream.
                let entry = unsafe { libc::readdir(self.0) };
                if entry.is_null() {
                    return None;
                }
                let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
                if name == b"." || name == b".." {
                    continue;
                }
                return Some(
                    std::str::from_utf8(name)
                        .map(str::to_owned)
                        .map_err(|_| io::ErrorKind::InvalidData.into()),
                );
            }
        }
    }
    pub(in crate::mcp_server) fn entries(dir: &File) -> io::Result<Entries> {
        // A new open-file description gives each listing an independent offset.
        let fresh = child(dir, ".")?;
        let fd = std::os::fd::IntoRawFd::into_raw_fd(fresh);
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() {
            unsafe {
                libc::close(fd);
            }
            return Err(io::Error::last_os_error());
        }
        Ok(Entries(stream))
    }
}

#[cfg(any(windows, test))]
fn ntstatus_error_kind(code: i32) -> io::ErrorKind {
    // Match the windows-sys Win32::Foundation values so Unix tests can run
    // without compiling the Windows-only dependency.
    match code as u32 {
        0xC000_000F // STATUS_NO_SUCH_FILE
        | 0xC000_0034 // STATUS_OBJECT_NAME_NOT_FOUND
        | 0xC000_003A => io::ErrorKind::NotFound, // STATUS_OBJECT_PATH_NOT_FOUND
        _ => io::ErrorKind::PermissionDenied,
    }
}

#[cfg(any(windows, test))]
fn directory_query_has_entry(code: i32, first_query: bool) -> Result<bool, io::ErrorKind> {
    match code as u32 {
        0x8000_0006 => Ok(false),                // STATUS_NO_MORE_FILES
        0xC000_000F if first_query => Ok(false), // STATUS_NO_SUCH_FILE
        _ if code < 0 => Err(ntstatus_error_kind(code)),
        _ => Ok(true),
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::{
        ffi::c_void,
        os::windows::{
            ffi::OsStrExt,
            io::{AsRawHandle, FromRawHandle},
        },
    };
    use windows_sys::Win32::{
        Foundation::INVALID_HANDLE_VALUE,
        Storage::FileSystem::{
            CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
            FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        },
    };
    #[repr(C)]
    struct Unicode {
        length: u16,
        maximum: u16,
        buffer: *mut u16,
    }
    #[repr(C)]
    struct Attributes {
        length: u32,
        root: *mut c_void,
        name: *mut Unicode,
        flags: u32,
        security: *mut c_void,
        qos: *mut c_void,
    }
    #[repr(C)]
    struct Status {
        status: usize,
        information: usize,
    }
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtCreateFile(
            handle: *mut *mut c_void,
            access: u32,
            attrs: *mut Attributes,
            status: *mut Status,
            size: *mut i64,
            file_attrs: u32,
            share: u32,
            disposition: u32,
            options: u32,
            ea: *mut c_void,
            ea_len: u32,
        ) -> i32;
        fn NtQueryDirectoryFile(
            handle: *mut c_void,
            event: *mut c_void,
            apc: *mut c_void,
            context: *mut c_void,
            status: *mut Status,
            buffer: *mut c_void,
            length: u32,
            class: u32,
            single: u8,
            name: *mut Unicode,
            restart: u8,
        ) -> i32;
    }
    fn checked(file: File) -> io::Result<File> {
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let kind = file.metadata()?.file_type();
        if !kind.is_dir() && !kind.is_file() {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        Ok(file)
    }
    pub(in crate::mcp_server) fn root(path: &Path) -> io::Result<File> {
        // Pin each ancestor, including the volume root, before descending.
        let mut parts = path.components();
        let prefix = parts.next().ok_or(io::ErrorKind::PermissionDenied)?;
        let std::path::Component::Prefix(prefix) = prefix else {
            return Err(io::ErrorKind::PermissionDenied.into());
        };
        if !matches!(
            prefix.kind(),
            std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)
        ) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        if parts.next() != Some(std::path::Component::RootDir) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let volume = format!("{}\\", prefix.as_os_str().to_string_lossy());
        let wide: Vec<_> = std::ffi::OsStr::new(&volume)
            .encode_wide()
            .chain(Some(0))
            .collect();
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                0x00100001,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let mut dir = checked(unsafe { File::from_raw_handle(handle) })?;
        for part in parts {
            let std::path::Component::Normal(name) = part else {
                return Err(io::ErrorKind::PermissionDenied.into());
            };
            dir = child(&dir, name.to_str().ok_or(io::ErrorKind::InvalidData)?)?;
            if !dir.metadata()?.is_dir() {
                return Err(io::ErrorKind::NotADirectory.into());
            }
        }
        Ok(dir)
    }
    pub(in crate::mcp_server) fn child(parent: &File, name: &str) -> io::Result<File> {
        let mut wide: Vec<u16> = name.encode_utf16().collect();
        let length = u16::try_from(wide.len() * 2).map_err(|_| io::ErrorKind::InvalidInput)?;
        let mut unicode = Unicode {
            length,
            maximum: length,
            buffer: wide.as_mut_ptr(),
        };
        open_relative(parent, &mut unicode)
    }
    fn open_relative(parent: &File, name: &mut Unicode) -> io::Result<File> {
        let mut attrs = Attributes {
            length: std::mem::size_of::<Attributes>() as u32,
            root: parent.as_raw_handle(),
            name,
            flags: 0x40,
            security: std::ptr::null_mut(),
            qos: std::ptr::null_mut(),
        };
        let mut status = Status {
            status: 0,
            information: 0,
        };
        let mut handle = std::ptr::null_mut();
        // FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT. Relative to
        // the pinned directory, so no path component can be retargeted.
        let code = unsafe {
            NtCreateFile(
                &mut handle,
                0x00100081,
                &mut attrs,
                &mut status,
                std::ptr::null_mut(),
                0,
                7,
                1,
                0x00200020,
                std::ptr::null_mut(),
                0,
            )
        };
        if code < 0 {
            return Err(ntstatus_error_kind(code).into());
        }
        checked(unsafe { File::from_raw_handle(handle) })
    }
    pub(in crate::mcp_server) struct Entries {
        dir: File,
        restart: bool,
    }
    impl Iterator for Entries {
        type Item = io::Result<String>;
        fn next(&mut self) -> Option<Self::Item> {
            loop {
                // FILE_NAMES_INFORMATION: NextEntryOffset, FileIndex,
                // FileNameLength, then UTF-16 FileName. Buffer is aligned.
                let mut buffer = [0u64; 8192];
                let mut status = Status {
                    status: 0,
                    information: 0,
                };
                let code = unsafe {
                    NtQueryDirectoryFile(
                        self.dir.as_raw_handle(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        &mut status,
                        buffer.as_mut_ptr().cast(),
                        65536,
                        12,
                        1,
                        std::ptr::null_mut(),
                        u8::from(self.restart),
                    )
                };
                let first_query = std::mem::replace(&mut self.restart, false);
                match directory_query_has_entry(code, first_query) {
                    Ok(true) => (),
                    Ok(false) => return None,
                    Err(kind) => return Some(Err(kind.into())),
                }
                let bytes = unsafe {
                    std::slice::from_raw_parts(
                        buffer.as_ptr().cast::<u8>(),
                        status.information.min(65536),
                    )
                };
                if bytes.len() < 12 {
                    return Some(Err(io::ErrorKind::InvalidData.into()));
                }
                let len = u32::from_ne_bytes(bytes[8..12].try_into().unwrap()) as usize;
                if len % 2 != 0 || len > bytes.len() - 12 {
                    return Some(Err(io::ErrorKind::InvalidData.into()));
                }
                let wide: Vec<u16> = bytes[12..12 + len]
                    .chunks_exact(2)
                    .map(|b| u16::from_ne_bytes([b[0], b[1]]))
                    .collect();
                let name = match String::from_utf16(&wide) {
                    Ok(n) => n,
                    Err(_) => return Some(Err(io::ErrorKind::InvalidData.into())),
                };
                if name == "." || name == ".." {
                    continue;
                }
                return Some(Ok(name));
            }
        }
    }
    pub(in crate::mcp_server) fn entries(dir: &File) -> io::Result<Entries> {
        // An empty relative name reopens the pinned directory itself. A new
        // file object gives each scan its own cursor.
        let mut empty_name = Unicode {
            length: 0,
            maximum: 0,
            buffer: std::ptr::null_mut(),
        };
        Ok(Entries {
            dir: open_relative(dir, &mut empty_name)?,
            restart: true,
        })
    }
}

pub(super) use native::{child, entries, root};
pub(in crate::mcp_server) fn open(root: &File, parts: &[&str]) -> io::Result<File> {
    let mut current = root.try_clone()?;
    for part in parts {
        if !current.metadata()?.is_dir() {
            return Err(io::ErrorKind::NotADirectory.into());
        }
        current = child(&current, part)?;
    }
    Ok(current)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_directory_query_distinguishes_entries_end_and_errors() {
        use io::ErrorKind::{NotFound, PermissionDenied};

        for (status, first_query, expected) in [
            (0_u32, true, Ok(true)),         // STATUS_SUCCESS
            (0x8000_0006, false, Ok(false)), // STATUS_NO_MORE_FILES
            (0x8000_0006, true, Ok(false)),
            (0xC000_000F, true, Ok(false)), // STATUS_NO_SUCH_FILE
            (0xC000_000F, false, Err(NotFound)),
            (0xC000_0034, true, Err(NotFound)), // STATUS_OBJECT_NAME_NOT_FOUND
            (0xC000_0022, true, Err(PermissionDenied)), // STATUS_ACCESS_DENIED
        ] {
            assert_eq!(
                directory_query_has_entry(status as i32, first_query),
                expected,
                "NTSTATUS {status:#010X}, first query: {first_query}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_lists_empty_and_single_entry_directories() {
        let fixture = tempfile::tempdir().unwrap();
        let dir = root(fixture.path()).unwrap();
        assert!(entries(&dir).unwrap().next().is_none());

        std::fs::write(fixture.path().join("only.txt"), "").unwrap();
        let names = entries(&dir)
            .unwrap()
            .take(2)
            .collect::<io::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(names, ["only.txt"]);
    }

    #[cfg(windows)]
    #[test]
    fn windows_overlapping_listings_have_independent_cursors() {
        let fixture = tempfile::tempdir().unwrap();
        let expected: Vec<_> = (0..400)
            .map(|i| format!("{i:03}-{}.txt", "x".repeat(90)))
            .collect();
        // The UTF-16 filenames alone exceed the 64 KiB query buffer.
        for name in &expected {
            std::fs::write(fixture.path().join(name), "").unwrap();
        }
        let dir = root(fixture.path()).unwrap();
        let mut first = entries(&dir).unwrap();
        let mut second = entries(&dir).unwrap();
        let mut first_names = vec![first.next().unwrap().unwrap()];
        let mut second_names = vec![second.next().unwrap().unwrap()];

        for (names, listing) in [(&mut first_names, first), (&mut second_names, second)] {
            for name in listing.take(expected.len()) {
                names.push(name.unwrap());
            }
            names.sort_unstable();
            assert_eq!(*names, expected);
        }
    }

    #[test]
    fn windows_missing_statuses_are_distinct_from_refusals() {
        use io::ErrorKind::{NotFound, PermissionDenied};

        for (status, expected) in [
            (0xC000_000F_u32, NotFound),     // STATUS_NO_SUCH_FILE
            (0xC000_0034, NotFound),         // STATUS_OBJECT_NAME_NOT_FOUND
            (0xC000_003A, NotFound),         // STATUS_OBJECT_PATH_NOT_FOUND
            (0xC000_0022, PermissionDenied), // STATUS_ACCESS_DENIED
            (0xC000_0279, PermissionDenied), // STATUS_IO_REPARSE_TAG_NOT_HANDLED
            (0xC000_050B, PermissionDenied), // STATUS_REPARSE_POINT_ENCOUNTERED
        ] {
            assert_eq!(
                ntstatus_error_kind(status as i32),
                expected,
                "NTSTATUS {status:#010X}"
            );
        }
    }

    #[test]
    fn unc_root_classification_is_platform_independent() {
        for path in [
            r"\\server\share",
            "//server/share",
            r"\\?\UNC\server\share",
            r"\\?\unc\server\share",
            r"\\.\UNC\server\share",
        ] {
            assert_eq!(
                supported_root(Path::new(path)),
                Err("root not supported"),
                "{path}"
            );
        }
        for path in ["/home/notes", r"C:\notes", r"\\?\C:\notes"] {
            assert_eq!(supported_root(Path::new(path)), Ok(()), "{path}");
        }
    }
}
