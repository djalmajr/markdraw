//! Loom-driven concurrency permutation tests for the WatcherHolder pattern
//! used in `apps/desktop/src-tauri/src/lib.rs`. The real type is
//!
//!   struct WatcherHolder(Mutex<Option<Debouncer<RecommendedWatcher>>>);
//!
//! Loom is exhaustive over thread interleavings; we model the smallest
//! shape that mirrors the production hot path:
//!
//!   watch_paths    → lock; *guard = None; ... lock; *guard = Some(d);
//!   stop_watching  → lock; *guard = None;
//!
//! and assert the slot only ever ends in a state production can observe
//! (None, or one of the known Some values).
//!
//! Run with:
//!   RUSTFLAGS="--cfg loom" cargo test -p loom-watcher-tests --release

use loom::sync::{Arc, Mutex};
use loom::thread;

struct StubWatcher(u32);

#[test]
fn watch_then_stop_resolves_to_a_legal_state() {
    loom::model(|| {
        let slot = Arc::new(Mutex::new(None::<StubWatcher>));

        let writer = {
            let slot = Arc::clone(&slot);
            thread::spawn(move || {
                {
                    let mut g = slot.lock().unwrap();
                    *g = None;
                }
                {
                    let mut g = slot.lock().unwrap();
                    *g = Some(StubWatcher(42));
                }
            })
        };

        let stopper = {
            let slot = Arc::clone(&slot);
            thread::spawn(move || {
                let mut g = slot.lock().unwrap();
                *g = None;
            })
        };

        writer.join().unwrap();
        stopper.join().unwrap();

        let final_state = slot.lock().unwrap();
        match &*final_state {
            None => {}
            Some(StubWatcher(v)) => assert_eq!(*v, 42),
        }
    });
}

#[test]
fn two_writers_one_stopper_resolves_consistently() {
    loom::model(|| {
        let slot = Arc::new(Mutex::new(None::<StubWatcher>));

        let w1 = {
            let slot = Arc::clone(&slot);
            thread::spawn(move || {
                let mut g = slot.lock().unwrap();
                *g = None;
                *g = Some(StubWatcher(1));
            })
        };

        let w2 = {
            let slot = Arc::clone(&slot);
            thread::spawn(move || {
                let mut g = slot.lock().unwrap();
                *g = None;
                *g = Some(StubWatcher(2));
            })
        };

        let s = {
            let slot = Arc::clone(&slot);
            thread::spawn(move || {
                let mut g = slot.lock().unwrap();
                *g = None;
            })
        };

        w1.join().unwrap();
        w2.join().unwrap();
        s.join().unwrap();

        let final_state = slot.lock().unwrap();
        match &*final_state {
            None => {}
            Some(StubWatcher(v)) => assert!(*v == 1 || *v == 2, "unexpected value {v}"),
        }
    });
}
