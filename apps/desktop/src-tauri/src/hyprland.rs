//! Hyprland window control through its per-instance Unix socket.
use std::path::{Component, Path, PathBuf};

fn socket_path(runtime: &Path, signature: &str) -> Option<PathBuf> {
    let mut components = Path::new(signature).components();
    if !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
        || signature.contains('/')
        || signature == "."
        || signature == ".."
    {
        return None;
    }
    Some(runtime.join("hypr").join(signature).join(".socket.sock"))
}

#[cfg(target_os = "linux")]
pub fn active_socket() -> Option<PathBuf> {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")?;
    let signature = std::env::var("HYPRLAND_INSTANCE_SIGNATURE").ok()?;
    let path = socket_path(Path::new(&runtime), &signature)?;
    path.exists().then_some(path)
}

fn client(json: &str, pid: u32) -> Result<(String, bool), String> {
    let clients: Vec<serde_json::Value> = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let c = clients
        .iter()
        .find(|c| c.get("pid").and_then(|v| v.as_u64()) == Some(pid as u64))
        .ok_or("window not found")?;
    let address = c
        .get("address")
        .and_then(|v| v.as_str())
        .ok_or("missing address")?;
    // The address is interpolated into a compositor command: accept only hex addresses.
    if !address
        .strip_prefix("0x")
        .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err("invalid address".into());
    }
    let state = c.get("fullscreen").ok_or("missing fullscreen")?;
    let maximized = if state.is_boolean() {
        false
    } else {
        state.as_i64().ok_or("invalid fullscreen")? == 1
    };
    Ok((address.into(), maximized))
}

fn lua_dispatch(address: &str) -> String {
    format!("dispatch hl.dsp.window.fullscreen({{ mode = \"maximized\", action = \"toggle\", window = \"address:{address}\" }})")
}
fn old_dispatch(address: &str) -> (String, &'static str) {
    (
        format!("dispatch focuswindow address:{address}"),
        "dispatch fullscreen 1",
    )
}
fn needs_fallback(response: &str) -> bool {
    response != "ok"
}

#[cfg(target_os = "linux")]
fn request(path: &Path, message: &str) -> Result<String, String> {
    use socket2::{Domain, SockAddr, Socket, Type};
    use std::io::{Read, Write};
    use std::os::fd::OwnedFd;
    use std::os::unix::net::UnixStream;
    use std::time::Duration;
    const TIMEOUT: Duration = Duration::from_secs(1);
    // Bound the connect too: a compositor that stopped accepting (full
    // backlog) would otherwise leave the caller waiting forever.
    let socket = Socket::new(Domain::UNIX, Type::STREAM, None).map_err(|e| e.to_string())?;
    let addr = SockAddr::unix(path).map_err(|e| e.to_string())?;
    socket
        .connect_timeout(&addr, TIMEOUT)
        .map_err(|e| e.to_string())?;
    let mut stream = UnixStream::from(OwnedFd::from(socket));
    stream
        .set_read_timeout(Some(TIMEOUT))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(TIMEOUT))
        .map_err(|e| e.to_string())?;
    stream
        .write_all(message.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|e| e.to_string())?;
    if response.is_empty() {
        return Err("empty compositor response".into());
    }
    Ok(response)
}

#[cfg(target_os = "linux")]
pub fn state(path: &Path, pid: u32) -> Result<(String, bool), String> {
    client(&request(path, "j/clients")?, pid)
}

#[cfg(target_os = "linux")]
pub fn toggle(path: &Path, pid: u32) -> Result<(), String> {
    let (address, _) = state(path, pid)?;
    let response = request(path, &lua_dispatch(&address))?;
    if needs_fallback(&response) {
        let (focus, fullscreen) = old_dispatch(&address);
        if request(path, &focus)? != "ok" {
            return Err("focus failed".into());
        }
        if request(path, fullscreen)? != "ok" {
            return Err("fullscreen failed".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_reject_hostile_signatures() {
        assert_eq!(
            socket_path(Path::new("/run/user/1"), "abc"),
            Some(PathBuf::from("/run/user/1/hypr/abc/.socket.sock"))
        );
        for s in ["", ".", "..", "../evil", "a/b", "/x"] {
            assert_eq!(socket_path(Path::new("/run"), s), None);
        }
    }
    #[test]
    fn client_selection_and_states() {
        let json = r#"[{"pid":1,"address":"0xabc","fullscreen":0},{"pid":1,"address":"0xdef","fullscreen":1},{"pid":2,"address":"0x123","fullscreen":2},{"pid":3,"address":"0x234","fullscreen":true}]"#;
        assert_eq!(client(json, 1).unwrap(), ("0xabc".into(), false));
        assert!(!client(json, 2).unwrap().1);
        assert!(!client(json, 3).unwrap().1);
        assert!(client(json, 4).is_err());
        assert!(client("[]", 1).is_err());
        assert!(client("", 1).is_err());
        assert!(client(r#"[{"pid":1,"address":"0x1;bad","fullscreen":1}]"#, 1).is_err());
        assert!(
            client(r#"[{"pid":1,"address":"0xa","fullscreen":1}]"#, 1)
                .unwrap()
                .1
        );
    }
    #[test]
    fn dispatch_and_fallback() {
        assert_eq!(lua_dispatch("0xabc"), "dispatch hl.dsp.window.fullscreen({ mode = \"maximized\", action = \"toggle\", window = \"address:0xabc\" })");
        assert_eq!(
            old_dispatch("0xabc"),
            (
                "dispatch focuswindow address:0xabc".into(),
                "dispatch fullscreen 1"
            )
        );
        assert!(!needs_fallback("ok"));
        assert!(needs_fallback("error: unsupported"));
        assert!(needs_fallback("unknown dispatcher"));
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn request_gives_up_when_the_socket_stops_accepting() {
        use socket2::{Domain, SockAddr, Socket, Type};
        use std::os::unix::net::UnixStream;
        use std::time::{Duration, Instant};
        let dir = std::env::temp_dir().join(format!("md-hypr-backlog-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("backlog.sock");
        let _ = std::fs::remove_file(&path);
        // A listener that never accepts, with its backlog already full.
        let listener = Socket::new(Domain::UNIX, Type::STREAM, None).unwrap();
        listener.bind(&SockAddr::unix(&path).unwrap()).unwrap();
        listener.listen(1).unwrap();
        let mut queued = Vec::new();
        while queued.len() < 8 {
            let s = Socket::new(Domain::UNIX, Type::STREAM, None).unwrap();
            s.set_nonblocking(true).unwrap();
            if s.connect(&SockAddr::unix(&path).unwrap()).is_err() {
                break;
            }
            queued.push(UnixStream::from(std::os::fd::OwnedFd::from(s)));
        }
        assert!(!queued.is_empty(), "could not fill the backlog");
        let started = Instant::now();
        let result = request(&path, "j/clients");
        let elapsed = started.elapsed();
        drop(queued);
        drop(listener);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(result.is_err());
        assert!(
            elapsed < Duration::from_secs(2),
            "request hung for {elapsed:?}"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires a live Hyprland window PID"]
    fn live_read_only() {
        let pid: u32 = std::env::var("MARKDRAW_PROBE_PID")
            .expect("MARKDRAW_PROBE_PID")
            .parse()
            .expect("numeric pid");
        let path = active_socket().expect("Hyprland socket");
        eprintln!(
            "client for pid {pid}: {:?}",
            state(&path, pid).expect("client state")
        );
    }
}
