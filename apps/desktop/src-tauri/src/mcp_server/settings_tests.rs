use super::*;
use std::{
    sync::mpsc,
    time::{Duration, Instant},
};

fn dir() -> tempfile::TempDir {
    tempfile::tempdir_in(std::env::temp_dir()).unwrap()
}
fn file(directory: &tempfile::TempDir) -> PathBuf {
    directory.path().join("config").join(FILE_NAME)
}
fn leftovers(path: &Path) -> Vec<String> {
    let Ok(read) = fs::read_dir(path.parent().unwrap()) else {
        return vec![];
    };
    read.map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name != FILE_NAME)
        .collect()
}

#[test]
fn masking_is_on_by_default_and_on_any_trouble() {
    let d = dir();
    assert!(Policy::default().mask(), "before any configuration");
    let path = file(&d);
    assert_eq!(load(&path), Settings { mask_secrets: true }, "missing file");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    for (name, content) in [
        ("empty", &b""[..]),
        ("not json", b"{maskSecrets: false}"),
        ("wrong type", br#"{"maskSecrets":"false"}"#),
        ("null", br#"{"maskSecrets":null}"#),
        ("missing key", b"{}"),
        ("unknown key", br#"{"maskSecrets":false,"other":1}"#),
        ("array", b"[false]"),
        ("not utf-8", b"\xff\xfe{\"maskSecrets\":false}"),
        (
            "oversized",
            format!(r#"{{"maskSecrets":false,"pad":"{}"}}"#, "x".repeat(8192)).as_bytes(),
        ),
    ] {
        fs::write(&path, content).unwrap();
        assert!(load(&path).mask_secrets, "{name}");
        let policy = Policy::default();
        policy.configure(path.clone());
        assert!(policy.mask(), "{name}");
    }
    // A directory where the file should be: unreadable.
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(load(&path).mask_secrets);
    // Control: the one shape that turns it off.
    fs::remove_dir(&path).unwrap();
    fs::write(&path, br#"{"maskSecrets":false}"#).unwrap();
    assert!(!load(&path).mask_secrets);
}

#[cfg(unix)]
#[test]
fn an_unreadable_file_means_masking() {
    use std::os::unix::fs::PermissionsExt;
    let d = dir();
    let path = file(&d);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, br#"{"maskSecrets":false}"#).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
    if fs::File::open(&path).is_ok() {
        println!("skipped: running with permission to read mode 000 files");
        return;
    }
    assert!(load(&path).mask_secrets);
}

#[test]
fn a_change_is_persisted_and_survives_a_restart() {
    let d = dir();
    let path = file(&d);
    let first = Policy::default();
    first.configure(path.clone());
    assert!(first.mask());
    first
        .set(Settings {
            mask_secrets: false,
        })
        .unwrap();
    assert!(!first.mask());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&fs::read(&path).unwrap()).unwrap(),
        serde_json::json!({"maskSecrets": false})
    );
    // "Restart": a new policy reads the file before it serves anything.
    let second = Policy::default();
    second.configure(path.clone());
    assert!(!second.mask());
    second.set(Settings { mask_secrets: true }).unwrap();
    let third = Policy::default();
    third.configure(path.clone());
    assert!(third.mask());
    assert_eq!(leftovers(&path), Vec::<String>::new());
}

#[test]
fn a_failed_write_changes_nothing() {
    let d = dir();
    let path = file(&d);
    let policy = Policy::default();
    policy.configure(path.clone());
    policy
        .set(Settings {
            mask_secrets: false,
        })
        .unwrap();
    let before = fs::read(&path).unwrap();
    // A disk that is full (the write fails): the state stays what it was.
    let full = policy.set_with(Settings { mask_secrets: true }, |_| {
        Err(io::Error::new(io::ErrorKind::StorageFull, "no space left"))
    });
    assert!(full.is_err());
    assert!(
        !policy.mask(),
        "state must not move before the write succeeds"
    );
    assert_eq!(fs::read(&path).unwrap(), before);
    // The same through the real writer: a folder that cannot be created.
    let blocked = d.path().join("blocked");
    fs::write(&blocked, "a regular file").unwrap();
    let broken = Policy::default();
    broken.configure(blocked.join("sub").join(FILE_NAME));
    assert!(broken
        .set(Settings {
            mask_secrets: false
        })
        .is_err());
    assert!(broken.mask());
}

#[cfg(unix)]
#[test]
fn a_directory_that_refuses_writes_keeps_the_old_file_and_leaves_no_temp_file() {
    use std::os::unix::fs::PermissionsExt;
    let d = dir();
    let path = file(&d);
    save(
        &path,
        Settings {
            mask_secrets: false,
        },
    )
    .unwrap();
    let folder = path.parent().unwrap();
    fs::set_permissions(folder, fs::Permissions::from_mode(0o500)).unwrap();
    let restore = || fs::set_permissions(folder, fs::Permissions::from_mode(0o700)).unwrap();
    if fs::File::create(folder.join("probe")).is_ok() {
        restore();
        println!("skipped: running with permission to write read-only directories");
        return;
    }
    let result = save(&path, Settings { mask_secrets: true });
    restore();
    assert!(result.is_err());
    assert!(!load(&path).mask_secrets, "the old file is untouched");
    assert_eq!(leftovers(&path), Vec::<String>::new());
}

#[test]
fn setting_before_the_config_directory_is_known_fails() {
    let policy = Policy::default();
    assert!(policy
        .set(Settings {
            mask_secrets: false
        })
        .is_err());
    assert!(policy.mask());
}

#[test]
fn configuring_twice_does_not_reopen_the_decision() {
    let d = dir();
    let path = file(&d);
    let policy = Policy::default();
    policy.configure(path.clone());
    policy
        .set(Settings {
            mask_secrets: false,
        })
        .unwrap();
    // A second configure (a different file saying "mask") is ignored.
    let other = d.path().join("other").join(FILE_NAME);
    policy.configure(other);
    assert!(!policy.mask());
}

#[test]
fn concurrent_changes_are_serialized_and_the_state_follows_the_write() {
    let policy = Arc::new(Policy::default());
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let order = Arc::new(Mutex::new(Vec::new()));
    let inside = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let first = {
        let (policy, order, inside) = (policy.clone(), order.clone(), inside.clone());
        std::thread::spawn(move || {
            policy
                .set_with(
                    Settings {
                        mask_secrets: false,
                    },
                    |_| {
                        assert_eq!(inside.fetch_add(1, Ordering::SeqCst), 0);
                        order.lock().unwrap().push("first");
                        entered_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        inside.fetch_sub(1, Ordering::SeqCst);
                        Ok(())
                    },
                )
                .unwrap()
        })
    };
    entered_rx.recv().unwrap();
    // The first write is in flight: its value is not published yet.
    assert!(policy.mask());
    let second = {
        let (policy, order, inside) = (policy.clone(), order.clone(), inside.clone());
        std::thread::spawn(move || {
            policy
                .set_with(Settings { mask_secrets: true }, |_| {
                    assert_eq!(
                        inside.fetch_add(1, Ordering::SeqCst),
                        0,
                        "writes overlapped"
                    );
                    order.lock().unwrap().push("second");
                    inside.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                })
                .unwrap()
        })
    };
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(
        *order.lock().unwrap(),
        ["first"],
        "the second ran inside the first"
    );
    release_tx.send(()).unwrap();
    first.join().unwrap();
    second.join().unwrap();
    assert_eq!(*order.lock().unwrap(), ["first", "second"]);
    assert!(policy.mask());
}

#[test]
fn many_concurrent_changes_leave_the_file_equal_to_the_state() {
    let d = dir();
    let path = file(&d);
    let policy = Arc::new(Policy::default());
    policy.configure(path.clone());
    let handles: Vec<_> = (0..16)
        .map(|n| {
            let (policy, path) = (policy.clone(), path.clone());
            std::thread::spawn(move || {
                for round in 0..10 {
                    policy
                        .set(Settings {
                            mask_secrets: (n + round) % 2 == 0,
                        })
                        .unwrap();
                    // A reader never sees a half-written file: whenever it
                    // exists, it parses (rename is the only way it changes).
                    if let Ok(bytes) = fs::read(&path) {
                        serde_json::from_slice::<Settings>(&bytes).expect("torn file");
                    }
                }
            })
        })
        .collect();
    for handle in handles {
        handle.join().unwrap();
    }
    assert_eq!(load(&path).mask_secrets, policy.mask());
    assert_eq!(leftovers(&path), Vec::<String>::new());
}

// ---- F4: turning masking off asks the user, natively -------------------------

use crate::mcp_server::testkit::FakeConfirm;

fn configured(d: &tempfile::TempDir) -> (Policy, PathBuf) {
    let path = file(d);
    let policy = Policy::default();
    policy.configure(path.clone());
    (policy, path)
}
const OFF: Settings = Settings {
    mask_secrets: false,
};
const ON: Settings = Settings { mask_secrets: true };

#[test]
fn turning_masking_off_writes_only_after_the_user_says_yes() {
    let d = dir();
    let (policy, path) = configured(&d);
    // No: nothing changes, in memory or on disk.
    let no = FakeConfirm::new(false);
    assert!(policy
        .change(OFF, || no.disable_masking_for_test())
        .is_err());
    assert!(policy.mask());
    assert!(!path.exists());
    assert_eq!(no.shown(), 1);
    // Yes (after the pause a no starts): the dialog was shown exactly once,
    // then the file and the value change.
    let yes = FakeConfirm::new(true);
    policy
        .change_with(
            OFF,
            || Instant::now() + PAUSE,
            || yes.disable_masking_for_test(),
        )
        .unwrap();
    assert_eq!(yes.shown(), 1);
    assert!(!policy.mask());
    assert!(!load(&path).mask_secrets);
    // Turning it back on never asks.
    let never = FakeConfirm::new(false);
    policy
        .change(ON, || never.disable_masking_for_test())
        .unwrap();
    assert_eq!(never.shown(), 0);
    assert!(policy.mask() && load(&path).mask_secrets);
    // Writing "on" while it is on never asks either.
    policy.change(ON, || panic!("asked")).unwrap();
}

#[test]
fn without_a_native_confirmation_the_change_is_refused() {
    let registry = Registry::default();
    let d = dir();
    registry.configure(&d.path().join("config"));
    let refused = registry
        .policy
        .change(OFF, || registry.confirm.disable_masking());
    assert!(refused.is_err());
    assert!(registry.policy.mask());
    FakeConfirm::attach(&registry, true);
    // (Refusing for want of a confirmer is a "no": it pauses the question.)
    registry
        .policy
        .change_with(
            OFF,
            || Instant::now() + PAUSE,
            || registry.confirm.disable_masking(),
        )
        .unwrap();
    assert!(!registry.policy.mask());
}

#[test]
fn a_second_request_while_the_dialog_is_open_is_refused_without_a_second_dialog() {
    let d = dir();
    let (policy, _) = configured(&d);
    let policy = Arc::new(policy);
    let confirm = FakeConfirm::new(true);
    let inner = policy.clone();
    let probe = confirm.clone();
    confirm.while_open(move || {
        // The dialog is on screen: another attempt cannot open another one.
        let second = inner.change(OFF, || {
            probe
                .shown
                .fetch_add(100, std::sync::atomic::Ordering::SeqCst);
            true
        });
        assert!(second.is_err());
    });
    policy
        .change(OFF, || confirm.disable_masking_for_test())
        .unwrap();
    assert_eq!(confirm.shown(), 1, "only the first dialog was opened");
    // Control: once it is closed, a new attempt can open one.
    policy.change(ON, || false).unwrap();
    let again = FakeConfirm::new(true);
    policy
        .change(OFF, || again.disable_masking_for_test())
        .unwrap();
    assert_eq!(again.shown(), 1);
}

#[test]
fn a_confirmation_open_while_the_page_reloads_grants_nothing() {
    let d = dir();
    let (policy, path) = configured(&d);
    let policy = Arc::new(policy);
    let confirm = FakeConfirm::new(true);
    let inner = policy.clone();
    confirm.while_open(move || inner.page_reloading());
    let voided = policy.change(OFF, || confirm.disable_masking_for_test());
    assert!(matches!(voided, Err(Refused::Failed(_))), "{voided:?}");
    assert!(policy.mask());
    assert!(!path.exists());
    // A reload is not a "no": it starts no pause.
    // Control: without a reload the same yes is honored.
    let fresh = FakeConfirm::new(true);
    policy
        .change(OFF, || fresh.disable_masking_for_test())
        .unwrap();
    assert!(!policy.mask());
}

// ---- a "no" pauses the question for 30 s ---------------------------------------

#[test]
fn a_no_pauses_turning_masking_off_for_exactly_thirty_seconds() {
    let d = dir();
    let (policy, path) = configured(&d);
    let t0 = Instant::now();
    let now = std::cell::Cell::new(t0);
    let clock = || now.get();
    let no = FakeConfirm::new(false);
    let first = policy.change_with(OFF, clock, || no.disable_masking_for_test());
    assert!(matches!(first, Err(Refused::Declined)), "{first:?}");
    assert_eq!(no.shown(), 1);
    // Inside the pause: the same answer as the "no", and no dialog, even if the
    // user would now say yes.
    let yes = FakeConfirm::new(true);
    for at in [
        Duration::ZERO,
        Duration::from_secs(1),
        PAUSE - Duration::from_nanos(1),
    ] {
        now.set(t0 + at);
        let paused = policy.change_with(OFF, clock, || yes.disable_masking_for_test());
        assert!(
            matches!(paused, Err(Refused::Declined)),
            "{at:?}: {paused:?}"
        );
    }
    assert_eq!(yes.shown(), 0, "the pause opens no dialog");
    assert!(policy.mask() && !path.exists());
    // Turning masking on is never blocked, not even inside the pause.
    now.set(t0 + Duration::from_secs(5));
    policy.change_with(ON, clock, || panic!("asked")).unwrap();
    // Exactly at the end of the pause the question is asked again.
    now.set(t0 + PAUSE);
    policy
        .change_with(OFF, clock, || yes.disable_masking_for_test())
        .unwrap();
    assert_eq!(yes.shown(), 1);
    assert!(!policy.mask());
}

#[test]
fn a_looping_page_gets_one_dialog_per_pause_and_a_reload_does_not_reset_it() {
    let d = dir();
    let (policy, _) = configured(&d);
    let t0 = Instant::now();
    let now = std::cell::Cell::new(t0);
    let clock = || now.get();
    let no = FakeConfirm::new(false);
    for round in 0..50 {
        let result = policy.change_with(OFF, clock, || no.disable_masking_for_test());
        assert!(matches!(result, Err(Refused::Declined)), "{round}");
        // The page reloads between attempts: the pause survives it.
        policy.page_reloading();
        now.set(now.get() + Duration::from_millis(100));
    }
    assert_eq!(no.shown(), 1, "fifty requests, one dialog");
    // A second pause starts from the next "no".
    now.set(t0 + PAUSE + Duration::from_secs(1));
    let again = policy.change_with(OFF, clock, || no.disable_masking_for_test());
    assert!(matches!(again, Err(Refused::Declined)));
    assert_eq!(no.shown(), 2);
    now.set(t0 + PAUSE + Duration::from_secs(10));
    let still = policy.change_with(OFF, clock, || panic!("asked"));
    assert!(matches!(still, Err(Refused::Declined)));
}

// ---- round 4, F1: the decision is taken under the lock that writes ----------

#[test]
fn a_turn_off_racing_a_turn_on_cannot_persist_off_without_asking() {
    let d = dir();
    let (policy, path) = configured(&d);
    let policy = Arc::new(policy);
    // Masking is already off (the user allowed it earlier).
    policy.set(OFF).unwrap();
    // A turn-on is inside its write: the file is not written, the value is
    // not published yet.
    let (inside, wait_inside) = mpsc::channel();
    let (release, released) = mpsc::channel::<()>();
    let on = {
        let (policy, path) = (policy.clone(), path.clone());
        std::thread::spawn(move || {
            policy
                .set_with(ON, |settings| {
                    inside.send(()).unwrap();
                    released.recv().unwrap();
                    save(&path, settings)
                })
                .unwrap()
        })
    };
    wait_inside.recv().unwrap();
    // Meanwhile a turn-off arrives and reads "off" if it reads before the lock.
    let asked = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let off = {
        let (policy, asked) = (policy.clone(), asked.clone());
        std::thread::spawn(move || {
            policy.change(OFF, || {
                asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                false
            })
        })
    };
    std::thread::sleep(Duration::from_millis(150));
    release.send(()).unwrap();
    on.join().unwrap();
    let result = off.join().unwrap();
    // It saw "on" under the lock, so it asked, and the "no" kept masking on,
    // in memory and on disk.
    assert!(matches!(result, Err(Refused::Declined)), "{result:?}");
    assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert!(policy.mask());
    assert!(load(&path).mask_secrets);
}

#[test]
fn turning_off_when_it_is_already_off_asks_and_writes_nothing() {
    let d = dir();
    let (policy, path) = configured(&d);
    policy.set(OFF).unwrap();
    fs::remove_file(&path).unwrap();
    policy.change(OFF, || panic!("asked")).unwrap();
    assert!(!policy.mask());
    assert!(!path.exists(), "a redundant request writes nothing");
    // Control: from "on" the same request does ask.
    policy.set(ON).unwrap();
    let no = FakeConfirm::new(false);
    assert!(policy
        .change(OFF, || no.disable_masking_for_test())
        .is_err());
    assert_eq!(no.shown(), 1);
}

#[test]
fn a_no_publishes_the_pause_before_the_dialog_is_free() {
    let d = dir();
    let (policy, path) = configured(&d);
    let policy = Arc::new(policy);
    let second_asked = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let second = Arc::new(Mutex::new(None));
    // The clock is read when the pause is published. A second request arrives
    // right then: with the dialog freed before the pause existed, it would
    // open a new dialog; it must find the pause instead.
    let clock = {
        let (policy, asked, second) = (policy.clone(), second_asked.clone(), second.clone());
        let once = std::sync::atomic::AtomicBool::new(false);
        move || {
            if !once.swap(true, std::sync::atomic::Ordering::SeqCst) {
                let (policy, asked) = (policy.clone(), asked.clone());
                *second.lock().unwrap() = Some(std::thread::spawn(move || {
                    policy.change(OFF, || {
                        asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        true
                    })
                }));
                std::thread::sleep(Duration::from_millis(150));
            }
            Instant::now()
        }
    };
    let no = FakeConfirm::new(false);
    let first = policy.change_with(OFF, clock, || no.disable_masking_for_test());
    assert!(matches!(first, Err(Refused::Declined)), "{first:?}");
    let result = second.lock().unwrap().take().unwrap().join().unwrap();
    assert!(matches!(result, Err(Refused::Declined)), "{result:?}");
    assert_eq!(second_asked.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert!(policy.mask() && !path.exists());
}

#[test]
fn a_dialog_that_panics_is_a_no_and_frees_the_reservation() {
    let d = dir();
    let (policy, path) = configured(&d);
    let t0 = Instant::now();
    let result = policy.change_with(OFF, || t0, || panic!("dialog crashed"));
    assert!(matches!(result, Err(Refused::Declined)), "{result:?}");
    assert!(policy.mask() && !path.exists());
    // Past the pause the dialog can open again: the reservation is not stuck.
    let yes = FakeConfirm::new(true);
    policy
        .change_with(OFF, || t0 + PAUSE, || yes.disable_masking_for_test())
        .unwrap();
    assert!(!policy.mask());
}
