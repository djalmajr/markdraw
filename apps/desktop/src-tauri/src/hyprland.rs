//! Hyprland window control through its per-instance Unix socket.
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

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

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Geometry {
    pub address: String,
    pub rect: Rect,
    pub monitor: i64,
    pub floating: bool,
    pub fullscreen: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub rect: Option<Rect>,
    pub monitor: i64,
    pub floating: bool,
    pub maximized: bool,
}

#[derive(Default)]
pub struct Memory {
    pub last_rect: Option<Rect>,
    pub saved: Option<Snapshot>,
    /// Bumped by every hide and show. A hide reads the compositor before it
    /// hides; if a show (or another hide) starts meanwhile, the number moves
    /// on and the earlier hide stands down, so the latest intent wins.
    generation: u64,
}

impl Memory {
    /// Start a hide; pass the ticket to `finish_hide` after reading the
    /// compositor.
    pub fn begin_hide(&mut self) -> u64 {
        self.generation += 1;
        self.generation
    }

    /// Record what the hide read and say whether it may still hide the
    /// window: false when a later show or hide started in the meantime.
    pub fn finish_hide(&mut self, ticket: u64, geometry: Option<&Geometry>) -> bool {
        if ticket != self.generation {
            return false;
        }
        self.saved = None;
        if let Some(g) = geometry {
            self.capture(g);
        }
        true
    }

    /// Start a show: overtakes any hide still reading, and hands over the
    /// geometry saved by the last hide (once).
    pub fn begin_show(&mut self) -> Option<Snapshot> {
        self.generation += 1;
        self.saved.take()
    }

    pub fn capture(&mut self, g: &Geometry) {
        if g.floating && g.fullscreen == 0 {
            self.last_rect = Some(g.rect);
        }
        self.saved = Some(Snapshot {
            rect: if g.fullscreen == 1 {
                self.last_rect
            } else {
                Some(g.rect)
            },
            monitor: g.monitor,
            floating: g.floating && g.fullscreen != 2,
            maximized: g.fullscreen == 1,
        });
    }
}

/// Lock the memory, recovering it if a panic poisoned the lock: it only holds
/// plain values, so the last state is still usable.
pub fn lock(memory: &Mutex<Memory>) -> MutexGuard<'_, Memory> {
    memory
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Finish a hide and run its effect (`window.hide()`) under the same lock, so
/// a show can't land between the ticket check and the hide. Returns `None`,
/// without running `hide`, when a later show or hide overtook this one. The
/// effect must not block: Tauri's `hide()` only posts to the main thread.
pub fn hide_if_current<R>(
    memory: &Mutex<Memory>,
    ticket: u64,
    geometry: Option<&Geometry>,
    hide: impl FnOnce() -> R,
) -> Option<R> {
    let mut memory = lock(memory);
    memory.finish_hide(ticket, geometry).then(hide)
}

/// Start a show and run its effect (`window.show()`) under the same lock as
/// `hide_if_current`, handing back the geometry the last hide saved.
pub fn show_with<R>(memory: &Mutex<Memory>, show: impl FnOnce() -> R) -> (Option<Snapshot>, R) {
    let mut memory = lock(memory);
    let saved = memory.begin_show();
    (saved, show())
}

fn geometry(json: &str, pid: u32) -> Result<Geometry, String> {
    let clients: Vec<serde_json::Value> = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let c = clients
        .iter()
        .find(|v| {
            v.get("pid").and_then(|v| v.as_u64()) == Some(pid as u64)
                && v.get("mapped").and_then(|v| v.as_bool()) == Some(true)
                && v.get("hidden").and_then(|v| v.as_bool()) == Some(false)
        })
        .ok_or("window not found")?;
    let address = c
        .get("address")
        .and_then(|v| v.as_str())
        .ok_or("missing address")?;
    if !address
        .strip_prefix("0x")
        .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err("invalid address".into());
    }
    let pair = |name: &str| -> Result<(i64, i64), String> {
        let a = c
            .get(name)
            .and_then(|v| v.as_array())
            .ok_or_else(|| format!("invalid {name}"))?;
        if a.len() != 2 {
            return Err(format!("invalid {name}"));
        }
        Ok((
            a[0].as_i64().ok_or_else(|| format!("invalid {name}"))?,
            a[1].as_i64().ok_or_else(|| format!("invalid {name}"))?,
        ))
    };
    let (x, y) = pair("at")?;
    let (width, height) = pair("size")?;
    if width <= 0 || height <= 0 {
        return Err("invalid size".into());
    }
    Ok(Geometry {
        address: address.into(),
        rect: Rect {
            x,
            y,
            width,
            height,
        },
        monitor: c
            .get("monitor")
            .and_then(|v| v.as_i64())
            .ok_or("invalid monitor")?,
        floating: c
            .get("floating")
            .and_then(|v| v.as_bool())
            .ok_or("invalid floating")?,
        fullscreen: c
            .get("fullscreen")
            .and_then(|v| v.as_i64())
            .ok_or("invalid fullscreen")?,
    })
}

#[derive(Debug, PartialEq)]
enum Action {
    Resize(i64, i64),
    Move(i64, i64),
    Maximize,
}

fn monitor_rect(json: &str, id: i64) -> Result<(f64, f64, f64, f64), String> {
    let monitors: Vec<serde_json::Value> = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let m = monitors
        .iter()
        .find(|m| m.get("id").and_then(|v| v.as_i64()) == Some(id))
        .ok_or("monitor not found")?;
    let n = |k: &str| {
        m.get(k)
            .and_then(|v| v.as_f64())
            .ok_or_else(|| format!("invalid {k}"))
    };
    let (x, y, mut w, mut h, scale) = (n("x")?, n("y")?, n("width")?, n("height")?, n("scale")?);
    let transform = m
        .get("transform")
        .and_then(|v| v.as_i64())
        .ok_or("invalid transform")?;
    if scale <= 0.0 || w <= 0.0 || h <= 0.0 {
        return Err("invalid monitor dimensions".into());
    }
    w /= scale;
    h /= scale;
    if transform % 2 != 0 {
        std::mem::swap(&mut w, &mut h);
    }
    Ok((x, y, w, h))
}

fn plan(
    saved: &Snapshot,
    current: &Geometry,
    monitor: Option<(f64, f64, f64, f64)>,
) -> Vec<Action> {
    let mut actions = Vec::new();
    if saved.floating && current.floating && saved.monitor == current.monitor {
        if let (Some(r), Some((x, y, w, h))) = (saved.rect, monitor) {
            if (r.x as f64) >= x
                && (r.y as f64) >= y
                && (r.x as f64) < x + w
                && (r.y as f64) < y + h
                && (r.width as f64) <= w
                && (r.height as f64) <= h
            {
                actions.push(Action::Resize(r.width, r.height));
                actions.push(Action::Move(r.x, r.y));
            }
        }
    }
    if saved.maximized && current.fullscreen == 0 {
        actions.push(Action::Maximize);
    }
    actions
}

fn commands(action: &Action, address: &str) -> (String, Vec<String>) {
    match action {
        Action::Resize(w,h) => (format!("dispatch hl.dsp.window.resize({{ x = {w}, y = {h}, relative = false, window = \"address:{address}\" }})"),vec![format!("dispatch resizewindowpixel exact {w} {h},address:{address}")]),
        Action::Move(x,y) => (format!("dispatch hl.dsp.window.move({{ x = {x}, y = {y}, relative = false, window = \"address:{address}\" }})"),vec![format!("dispatch movewindowpixel exact {x} {y},address:{address}")]),
        Action::Maximize => (format!("dispatch hl.dsp.window.fullscreen({{ mode = \"maximized\", action = \"set\", window = \"address:{address}\" }})"),vec![format!("dispatch focuswindow address:{address}"),"dispatch fullscreen 1".into()]),
    }
}

fn execute(
    actions: &[Action],
    address: &str,
    mut send: impl FnMut(&str) -> Result<String, String>,
) -> Result<(), String> {
    let mut old = false;
    for action in actions {
        let (lua, legacy) = commands(action, address);
        if !old {
            old = send(&lua)? != "ok";
        }
        if old {
            for cmd in legacy {
                if send(&cmd)? != "ok" {
                    return Err("dispatch failed".into());
                }
            }
        }
    }
    Ok(())
}

/// Query until the window is back, up to `attempts` times and never starting
/// a query once `expired` says the deadline has passed (one already running
/// may still take its socket timeout).
fn wait_for_client(
    mut query: impl FnMut() -> Result<Geometry, String>,
    mut sleep: impl FnMut(),
    mut expired: impl FnMut() -> bool,
    attempts: usize,
) -> Option<Geometry> {
    for i in 0..attempts {
        if expired() {
            break;
        }
        if let Ok(g) = query() {
            return Some(g);
        }
        if i + 1 < attempts {
            sleep();
        }
    }
    None
}

#[cfg(target_os = "linux")]
pub fn read_geometry(path: &Path, pid: u32) -> Result<Geometry, String> {
    geometry(&request(path, "j/clients")?, pid)
}

#[cfg(target_os = "linux")]
pub fn restore(path: &Path, pid: u32, saved: Snapshot) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    let current = wait_for_client(
        || read_geometry(path, pid),
        || std::thread::sleep(std::time::Duration::from_millis(50)),
        || std::time::Instant::now() >= deadline,
        40,
    );
    if let Some(current) = current {
        let monitor = request(path, "j/monitors")
            .ok()
            .and_then(|s| monitor_rect(&s, current.monitor).ok());
        let _ = execute(&plan(&saved, &current, monitor), &current.address, |cmd| {
            request(path, cmd)
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Geometry {
        geometry(r#"[{"pid":7,"mapped":true,"hidden":false,"address":"0xabc","at":[10,20],"size":[500,400],"monitor":1,"floating":true,"fullscreen":0}]"#, 7).unwrap()
    }

    #[test]
    fn geometry_reads_mapped_window_and_rejects_bad_data() {
        let g = fixture();
        assert_eq!(
            g.rect,
            Rect {
                x: 10,
                y: 20,
                width: 500,
                height: 400
            }
        );
        let json = r#"[{"pid":7,"mapped":false},{"pid":7,"mapped":true,"hidden":false,"address":"0xabc","at":[10,20],"size":[500,400],"monitor":1,"floating":true,"fullscreen":0}]"#;
        assert_eq!(geometry(json, 7).unwrap(), g);
        assert!(geometry("broken", 7).is_err());
        assert!(geometry("[]", 7).is_err());
        assert!(geometry(&json.replace("\"monitor\":1", "\"monitor\":null"), 7).is_err());
        assert!(geometry(&json.replace("0xabc", "0xabc;bad"), 7).is_err());
    }

    #[test]
    fn snapshot_and_restore_plan() {
        let mut memory = Memory::default();
        let mut g = fixture();
        memory.capture(&g);
        let rect = g.rect;
        let monitor = Some((0.0, 0.0, 1000.0, 800.0));
        assert_eq!(
            plan(memory.saved.as_ref().unwrap(), &g, monitor),
            vec![Action::Resize(500, 400), Action::Move(10, 20)]
        );
        g.fullscreen = 1;
        g.rect.width = 1000;
        memory.capture(&g);
        g.fullscreen = 0;
        assert_eq!(memory.saved.as_ref().unwrap().rect, Some(rect));
        assert_eq!(
            plan(memory.saved.as_ref().unwrap(), &g, monitor),
            vec![
                Action::Resize(500, 400),
                Action::Move(10, 20),
                Action::Maximize
            ]
        );
        g.monitor = 2;
        assert_eq!(
            plan(memory.saved.as_ref().unwrap(), &g, monitor),
            vec![Action::Maximize]
        );
        g.monitor = 1;
        assert_eq!(
            plan(
                memory.saved.as_ref().unwrap(),
                &g,
                Some((100.0, 100.0, 1000.0, 800.0))
            ),
            vec![Action::Maximize]
        );
        assert_eq!(
            plan(
                memory.saved.as_ref().unwrap(),
                &g,
                Some((0.0, 0.0, 100.0, 100.0))
            ),
            vec![Action::Maximize]
        );
        g.floating = false;
        assert_eq!(
            plan(memory.saved.as_ref().unwrap(), &g, monitor),
            vec![Action::Maximize]
        );
        g.fullscreen = 1;
        assert!(plan(memory.saved.as_ref().unwrap(), &g, monitor).is_empty());
        let mut empty = Memory::default();
        empty.capture(&g);
        assert_eq!(empty.saved.unwrap().rect, None);
        g.fullscreen = 0;
        empty = Memory::default();
        empty.capture(&g);
        assert!(plan(empty.saved.as_ref().unwrap(), &g, monitor).is_empty());

        // Maximized while floating, with no floating rect known yet: only the
        // maximized state comes back.
        let mut g = fixture();
        g.fullscreen = 1;
        let mut fresh = Memory::default();
        fresh.capture(&g);
        g.fullscreen = 0;
        assert_eq!(
            plan(fresh.saved.as_ref().unwrap(), &g, monitor),
            vec![Action::Maximize]
        );

        // Real fullscreen (mode 2) is out of scope: nothing is restored.
        let mut g = fixture();
        g.fullscreen = 2;
        let mut full = Memory::default();
        full.capture(&g);
        g.fullscreen = 0;
        assert!(plan(full.saved.as_ref().unwrap(), &g, monitor).is_empty());
    }

    #[test]
    fn monitor_scaling_and_fallback_order() {
        assert_eq!(
            monitor_rect(
                r#"[{"id":1,"x":100,"y":0,"width":1200,"height":800,"scale":2,"transform":1}]"#,
                1
            )
            .unwrap(),
            (100.0, 0.0, 400.0, 600.0)
        );
        let actions = vec![
            Action::Resize(500, 400),
            Action::Move(10, 20),
            Action::Maximize,
        ];
        let mut calls = Vec::new();
        execute(&actions, "0xabc", |cmd| {
            calls.push(cmd.to_string());
            Ok(if calls.len() == 1 { "unknown" } else { "ok" }.into())
        })
        .unwrap();
        assert_eq!(calls, vec!["dispatch hl.dsp.window.resize({ x = 500, y = 400, relative = false, window = \"address:0xabc\" })", "dispatch resizewindowpixel exact 500 400,address:0xabc", "dispatch movewindowpixel exact 10 20,address:0xabc", "dispatch focuswindow address:0xabc", "dispatch fullscreen 1"]);

        // Hyprland 0.56+: every step goes through the Lua dispatcher.
        let mut lua = Vec::new();
        execute(&actions, "0xabc", |cmd| {
            lua.push(cmd.to_string());
            Ok("ok".into())
        })
        .unwrap();
        assert_eq!(
            lua,
            vec![
                "dispatch hl.dsp.window.resize({ x = 500, y = 400, relative = false, window = \"address:0xabc\" })",
                "dispatch hl.dsp.window.move({ x = 10, y = 20, relative = false, window = \"address:0xabc\" })",
                "dispatch hl.dsp.window.fullscreen({ mode = \"maximized\", action = \"set\", window = \"address:0xabc\" })",
            ]
        );

        // A legacy step that fails stops the rest.
        let mut failed = Vec::new();
        assert!(execute(&actions, "0xabc", |cmd| {
            failed.push(cmd.to_string());
            Ok(if failed.len() == 2 {
                "error"
            } else {
                "unknown"
            }
            .into())
        })
        .is_err());
        assert_eq!(failed.len(), 2);
    }

    #[test]
    fn polling_stops_on_success_or_limit() {
        let mut n = 0;
        let mut sleeps = 0;
        assert!(wait_for_client(
            || {
                n += 1;
                if n == 3 {
                    Ok(fixture())
                } else {
                    Err("missing".into())
                }
            },
            || sleeps += 1,
            || false,
            5
        )
        .is_some());
        assert_eq!((n, sleeps), (3, 2));
        n = 0;
        sleeps = 0;
        assert!(wait_for_client(
            || {
                n += 1;
                Err("missing".into())
            },
            || sleeps += 1,
            || false,
            5
        )
        .is_none());
        assert_eq!((n, sleeps), (5, 4));
    }

    #[test]
    fn polling_starts_no_query_after_the_deadline() {
        // Fake clock: the first query takes past the deadline.
        let late = std::cell::Cell::new(false);
        let queries = std::cell::Cell::new(0);
        assert!(wait_for_client(
            || {
                queries.set(queries.get() + 1);
                late.set(true);
                Err("missing".into())
            },
            || {},
            || late.get(),
            40
        )
        .is_none());
        assert_eq!(queries.get(), 1);
    }

    #[test]
    fn a_show_cannot_land_between_the_ticket_check_and_the_hide() {
        use std::sync::{mpsc, Arc};
        let memory = Arc::new(Mutex::new(Memory::default()));
        let effects = Arc::new(Mutex::new(Vec::new()));
        let ticket = lock(&memory).begin_hide();
        let (checked, go) = mpsc::channel();

        // The hide's ticket is accepted; while its effect runs, a show starts
        // on another thread. The show must wait and come after the hide.
        let hide = {
            let (memory, effects) = (memory.clone(), effects.clone());
            std::thread::spawn(move || {
                hide_if_current(&memory, ticket, Some(&fixture()), || {
                    checked.send(()).unwrap();
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    effects.lock().unwrap().push("hide");
                })
            })
        };
        go.recv().unwrap();
        let (saved, ()) = show_with(&memory, || effects.lock().unwrap().push("show"));
        assert!(hide.join().unwrap().is_some());

        assert_eq!(*effects.lock().unwrap(), vec!["hide", "show"]);
        assert!(saved.is_some(), "the show gets what the hide saved");
    }

    #[test]
    fn a_later_show_overtakes_a_hide_still_reading() {
        let g = fixture();
        let mut memory = Memory::default();

        // hide starts reading → show runs → the read completes.
        let ticket = memory.begin_hide();
        assert_eq!(memory.begin_show(), None);
        assert!(!memory.finish_hide(ticket, Some(&g)));
        assert_eq!(memory.saved, None, "the overtaken hide saves nothing");

        // A hide nobody overtakes saves the geometry, and the next show
        // takes it once.
        let ticket = memory.begin_hide();
        assert!(memory.finish_hide(ticket, Some(&g)));
        assert!(memory.begin_show().is_some());
        assert_eq!(memory.begin_show(), None);

        // A newer hide also wins over an older one.
        let first = memory.begin_hide();
        let second = memory.begin_hide();
        assert!(!memory.finish_hide(first, Some(&g)));
        assert!(memory.finish_hide(second, None));
        assert_eq!(memory.saved, None);
    }

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
            read_geometry(&path, pid).expect("geometry")
        );
        eprintln!(
            "monitors: {}",
            request(&path, "j/monitors").expect("monitors")
        );
    }
}
