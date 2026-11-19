//! Local-only named pipes with a protected DACL containing only the current
//! process user's SID. Token files and directories use the same explicit DACL.
use super::{handle_connection, identity, random_id, Registry, MAX_CONNECTIONS};
use std::{
    ffi::c_void,
    fs::{File, OpenOptions},
    io::{self, Read, Write},
    os::windows::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
        io::{AsRawHandle, FromRawHandle},
    },
    path::{Path, PathBuf},
    ptr,
    sync::Arc,
};
use tokio::net::windows::named_pipe::{
    ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, LocalFree, GENERIC_WRITE, INVALID_HANDLE_VALUE},
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            GetSecurityInfo, SE_FILE_OBJECT,
        },
        GetAce, GetTokenInformation, TokenUser, ACCESS_ALLOWED_ACE, ACL, DACL_SECURITY_INFORMATION,
        OWNER_SECURITY_INFORMATION, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    },
    Storage::FileSystem::{
        CreateDirectoryW, CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        FILE_SHARE_WRITE,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};
pub type Stream = NamedPipeClient;
fn wide(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}
fn denied() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "Unsafe MCP endpoint ACL")
}
struct Local(*mut c_void);
impl Drop for Local {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
fn sid_string(sid: *mut c_void) -> io::Result<String> {
    let mut text = ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let _allocated = Local(text.cast());
    let mut len = 0;
    unsafe {
        while *text.add(len) != 0 {
            len += 1;
        }
        Ok(String::from_utf16_lossy(std::slice::from_raw_parts(
            text, len,
        )))
    }
}
fn current_sid() -> io::Result<String> {
    let mut token = ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let result = (|| {
        let mut size = 0;
        unsafe {
            GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut size);
        }
        // usize storage provides the alignment required by TOKEN_USER.
        let mut bytes = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
        if unsafe {
            GetTokenInformation(token, TokenUser, bytes.as_mut_ptr().cast(), size, &mut size)
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        sid_string(unsafe { (*(bytes.as_ptr().cast::<TOKEN_USER>())).User.Sid })
    })();
    unsafe {
        CloseHandle(token);
    }
    result
}
struct Security {
    descriptor: Local,
    sid: String,
}
impl Security {
    fn new() -> io::Result<Self> {
        let sid = current_sid()?;
        let sddl = wide(format!("O:{sid}D:P(A;;GA;;;{sid})"));
        let mut descriptor = ptr::null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            descriptor: Local(descriptor),
            sid,
        })
    }
    fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.descriptor.0,
            bInheritHandle: 0,
        }
    }
    fn validate(&self, file: &File) -> io::Result<()> {
        if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(denied());
        }
        let mut owner = ptr::null_mut();
        let mut acl: *mut ACL = ptr::null_mut();
        let mut descriptor = ptr::null_mut();
        let error = unsafe {
            GetSecurityInfo(
                file.as_raw_handle().cast(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                ptr::null_mut(),
                &mut acl,
                ptr::null_mut(),
                &mut descriptor,
            )
        };
        if error != 0 {
            return Err(io::Error::from_raw_os_error(error as i32));
        }
        let _allocated = Local(descriptor);
        if owner.is_null()
            || sid_string(owner)? != self.sid
            || acl.is_null()
            || unsafe { (*acl).AceCount } != 1
        {
            return Err(denied());
        }
        let mut ace = ptr::null_mut();
        if unsafe { GetAce(acl, 0, &mut ace) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let ace = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
        // ACCESS_ALLOWED_ACE_TYPE == 0; require a non-inherited, user-only ACE.
        if ace.Header.AceType != 0
            || ace.Header.AceFlags != 0
            || sid_string(ptr::addr_of!(ace.SidStart).cast_mut().cast())? != self.sid
        {
            return Err(denied());
        }
        Ok(())
    }
    fn directory(&self, path: &Path) -> io::Result<File> {
        if unsafe { CreateDirectoryW(wide(path).as_ptr(), &self.attributes()) } == 0 {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::AlreadyExists {
                return Err(error);
            }
        }
        self.open_directory(path)
    }
    fn open_directory(&self, path: &Path) -> io::Result<File> {
        let file = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        self.validate(&file)?;
        if !file.metadata()?.is_dir() {
            return Err(denied());
        }
        Ok(file)
    }
    fn read_token(&self, path: &Path) -> io::Result<String> {
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        self.validate(&file)?;
        if !file.metadata()?.is_file() || file.metadata()?.len() != 64 {
            return Err(denied());
        }
        let mut token = String::new();
        file.read_to_string(&mut token)?;
        Ok(token)
    }
    fn pipe(&self, name: &str, first: bool) -> io::Result<NamedPipeServer> {
        let mut attrs = self.attributes();
        unsafe {
            ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .max_instances(MAX_CONNECTIONS + 1)
                .create_with_security_attributes_raw(name, ptr::addr_of_mut!(attrs).cast())
        }
    }
}
fn pipe_name(sid: &str) -> String {
    format!(r"\\.\pipe\markdraw-{sid}-{}", identity())
}
pub fn default_directory() -> io::Result<PathBuf> {
    let base = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or_else(denied)?);
    if !base.is_absolute() {
        return Err(denied());
    }
    Ok(base.join("markdraw-mcp").join(identity()))
}
pub fn prepare_parent(path: &Path) -> io::Result<()> {
    let security = Security::new()?;
    let _parent = security.directory(path.parent().ok_or_else(denied)?)?;
    Ok(())
}
pub struct Endpoint {
    directory: File,
    token_path: PathBuf,
    token_created: bool,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Endpoint {
    fn drop(&mut self) {
        self.task.abort();
        if self.token_created {
            let _ = std::fs::remove_file(&self.token_path);
        }
        // Keep the directory handle (no delete sharing) through cleanup.
        let _ = &self.directory;
    }
}
impl Endpoint {
    pub fn start(path: &Path, registry: Arc<Registry>) -> io::Result<Self> {
        let security = Security::new()?;
        let directory = security.directory(path)?;
        let name = pipe_name(&security.sid);
        // Acquire the unique first pipe before touching a prior session token.
        let pipe = security.pipe(&name, true)?;
        let token_path = path.join("token");
        match std::fs::symlink_metadata(&token_path) {
            Ok(_) => {
                security.read_token(&token_path)?;
                std::fs::remove_file(&token_path)?;
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => (),
            Err(e) => return Err(e),
        }
        let token = random_id()?;
        let handle = unsafe {
            CreateFileW(
                wide(&token_path).as_ptr(),
                GENERIC_WRITE,
                0,
                &security.attributes(),
                CREATE_NEW,
                FILE_FLAG_OPEN_REPARSE_POINT,
                ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let mut file = unsafe { File::from_raw_handle(handle.cast()) };
        let write_result = file.write_all(token.as_bytes());
        drop(file);
        if let Err(error) = write_result {
            let _ = std::fs::remove_file(&token_path);
            return Err(error);
        }
        let task = tokio::spawn(async move {
            let mut pipe = pipe;
            let mut tasks = tokio::task::JoinSet::new();
            let limit = Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS));
            loop {
                tokio::select! {
                    connected = pipe.connect() => {
                        if connected.is_err() { break; }
                        let next = match Security::new().and_then(|security| security.pipe(&name, false)) { Ok(next) => next, Err(_) => break };
                        let stream = std::mem::replace(&mut pipe, next);
                        let permit = match limit.clone().try_acquire_owned() { Ok(permit) => permit, Err(_) => continue };
                        let registry = registry.clone();
                        let token = token.clone();
                        tasks.spawn(async move { let _permit = permit; let _ = handle_connection(stream, registry, &token).await; });
                    },
                    _ = tasks.join_next(), if !tasks.is_empty() => (),
                }
            }
        });
        Ok(Self {
            directory,
            token_path,
            token_created: true,
            task,
        })
    }
}
pub async fn connect(path: &Path) -> io::Result<(Stream, String)> {
    let security = Security::new()?;
    let _directory = security.open_directory(path)?;
    let token = security.read_token(&path.join("token"))?;
    let name = pipe_name(&security.sid);
    // ERROR_PIPE_BUSY is transient while the listener publishes its next instance.
    for _ in 0..50 {
        match ClientOptions::new().open(&name) {
            Ok(stream) => return Ok((stream, token)),
            Err(error) if error.raw_os_error() == Some(231) => {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await
            }
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(io::ErrorKind::TimedOut, "MCP pipe busy"))
}
