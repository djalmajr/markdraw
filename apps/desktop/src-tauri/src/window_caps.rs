//! Which window actions the compositor actually performs.
//!
//! Linux draws its own caption buttons (the native frame is off), so it has to
//! know what the compositor supports: tiling compositors such as Hyprland or
//! Sway don't minimize, and showing a button that does nothing is a bug. The
//! standard answer is xdg-shell's `xdg_toplevel.wm_capabilities` (v5+), the
//! same signal GTK 4 uses to hide its own buttons. GTK 3, which Tauri runs on,
//! never asks for it, so we probe it on a short-lived Wayland connection with
//! an unmapped toplevel: no buffer is ever attached, so nothing is shown.
//!
//! Anything that can't answer (X11 session, xdg-shell older than v5, other
//! platforms) reports every action as supported — the behaviour before this.

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct WindowCapabilities {
    pub minimize: bool,
    pub maximize: bool,
}

impl WindowCapabilities {
    pub const ALL: Self = Self {
        minimize: true,
        maximize: true,
    };
}

/// `xdg_toplevel.wm_capabilities` values (xdg-shell.xml, enum `wm_capabilities`).
const CAP_MAXIMIZE: u32 = 2;
const CAP_MINIMIZE: u32 = 4;

/// Decode the event's array argument: native-endian `u32` capability values.
/// Per the protocol, an action missing from the array is unsupported.
pub fn from_wm_capabilities(raw: &[u8]) -> WindowCapabilities {
    let caps: Vec<u32> = raw.as_chunks::<4>().0.iter().map(|c| u32::from_ne_bytes(*c)).collect();
    WindowCapabilities {
        minimize: caps.contains(&CAP_MINIMIZE),
        maximize: caps.contains(&CAP_MAXIMIZE),
    }
}

/// Probed once per process; the compositor doesn't change under a running app.
pub fn current() -> WindowCapabilities {
    static CAPS: std::sync::OnceLock<WindowCapabilities> = std::sync::OnceLock::new();
    *CAPS.get_or_init(|| {
        #[cfg(target_os = "linux")]
        {
            wayland::probe().unwrap_or(WindowCapabilities::ALL)
        }
        #[cfg(not(target_os = "linux"))]
        {
            WindowCapabilities::ALL
        }
    })
}

#[cfg(target_os = "linux")]
mod wayland {
    use super::{from_wm_capabilities, WindowCapabilities};
    use wayland_client::globals::{registry_queue_init, GlobalListContents};
    use wayland_client::protocol::{wl_compositor, wl_registry, wl_surface};
    use wayland_client::{Connection, Dispatch, QueueHandle};
    use wayland_protocols::xdg::shell::client::{xdg_surface, xdg_toplevel, xdg_wm_base};

    #[derive(Default)]
    struct Probe {
        caps: Option<Vec<u8>>,
        configured: bool,
    }

    pub fn probe() -> Option<WindowCapabilities> {
        let conn = Connection::connect_to_env().ok()?;
        let (globals, mut queue) = registry_queue_init::<Probe>(&conn).ok()?;
        let qh = queue.handle();
        let compositor: wl_compositor::WlCompositor = globals.bind(&qh, 1..=4, ()).ok()?;
        // wm_capabilities exists from v5 on; an older compositor can't tell us.
        let wm_base: xdg_wm_base::XdgWmBase = globals.bind(&qh, 5..=5, ()).ok()?;

        let surface = compositor.create_surface(&qh, ());
        let xdg_surface = wm_base.get_xdg_surface(&surface, &qh, ());
        let toplevel = xdg_surface.get_toplevel(&qh, ());
        // The initial commit (no buffer) asks for the first configure, which v5
        // guarantees is preceded by wm_capabilities.
        surface.commit();

        let mut state = Probe::default();
        for _ in 0..5 {
            if state.configured {
                break;
            }
            queue.roundtrip(&mut state).ok()?;
        }

        toplevel.destroy();
        xdg_surface.destroy();
        surface.destroy();
        wm_base.destroy();
        let _ = conn.flush();

        state.caps.map(|raw| from_wm_capabilities(&raw))
    }

    impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for Probe {
        fn event(
            _: &mut Self,
            _: &wl_registry::WlRegistry,
            _: wl_registry::Event,
            _: &GlobalListContents,
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
        }
    }

    impl Dispatch<wl_compositor::WlCompositor, ()> for Probe {
        fn event(
            _: &mut Self,
            _: &wl_compositor::WlCompositor,
            _: wl_compositor::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
        }
    }

    impl Dispatch<wl_surface::WlSurface, ()> for Probe {
        fn event(
            _: &mut Self,
            _: &wl_surface::WlSurface,
            _: wl_surface::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
        }
    }

    impl Dispatch<xdg_wm_base::XdgWmBase, ()> for Probe {
        fn event(
            _: &mut Self,
            wm_base: &xdg_wm_base::XdgWmBase,
            event: xdg_wm_base::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            if let xdg_wm_base::Event::Ping { serial } = event {
                wm_base.pong(serial);
            }
        }
    }

    impl Dispatch<xdg_surface::XdgSurface, ()> for Probe {
        fn event(
            state: &mut Self,
            _: &xdg_surface::XdgSurface,
            event: xdg_surface::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            if let xdg_surface::Event::Configure { .. } = event {
                state.configured = true;
            }
        }
    }

    impl Dispatch<xdg_toplevel::XdgToplevel, ()> for Probe {
        fn event(
            state: &mut Self,
            _: &xdg_toplevel::XdgToplevel,
            event: xdg_toplevel::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            if let xdg_toplevel::Event::WmCapabilities { capabilities } = event {
                state.caps = Some(capabilities);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(caps: &[u32]) -> Vec<u8> {
        caps.iter().flat_map(|c| c.to_ne_bytes()).collect()
    }

    #[test]
    fn tiling_compositor_without_minimize_hides_it() {
        // What Hyprland sends: fullscreen (3) + maximize (2), no minimize (4).
        // Mutation captured: treating "absent" as "supported" brings back a
        // minimize button that does nothing.
        let caps = from_wm_capabilities(&raw(&[3, 2]));
        assert_eq!(caps, WindowCapabilities { minimize: false, maximize: true });
    }

    #[test]
    fn stacking_compositor_keeps_both() {
        let caps = from_wm_capabilities(&raw(&[1, 2, 3, 4]));
        assert_eq!(caps, WindowCapabilities::ALL);
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "needs a live Wayland session"]
    fn probe_reads_the_live_compositor() {
        if std::env::var_os("WAYLAND_DISPLAY").is_none() {
            return;
        }
        let caps = wayland::probe().expect("an xdg-shell v5 compositor answers the probe");
        eprintln!("compositor capabilities: {caps:?}");
    }

    #[test]
    fn empty_array_means_neither() {
        // Mutation captured: swapping the 2/4 constants flips these fields.
        assert_eq!(
            from_wm_capabilities(&raw(&[4])),
            WindowCapabilities { minimize: true, maximize: false }
        );
        assert_eq!(
            from_wm_capabilities(&[]),
            WindowCapabilities { minimize: false, maximize: false }
        );
    }
}
