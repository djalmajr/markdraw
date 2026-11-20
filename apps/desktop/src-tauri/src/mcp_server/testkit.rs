//! Shared test doubles for the `main` webview: records every event the
//! server emits and can answer from inside `emit`, which is exactly when a
//! request is registered but its receiver has not been polled yet.
use super::{Confirm, MainEmitter, Registry};
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex, OnceLock, Weak,
};

type Hook = Box<dyn Fn(&Registry, &str, &Value) + Send + Sync>;

pub(super) struct Fake {
    pub(super) events: Mutex<Vec<(String, Value)>>,
    pub(super) deliver: AtomicBool,
    registry: OnceLock<Weak<Registry>>,
    hook: Mutex<Option<Hook>>,
}
impl Fake {
    pub(super) fn attach(registry: &Arc<Registry>) -> Arc<Self> {
        let fake = Arc::new(Self {
            events: Mutex::default(),
            deliver: AtomicBool::new(true),
            registry: OnceLock::new(),
            hook: Mutex::default(),
        });
        fake.registry.set(Arc::downgrade(registry)).ok();
        registry.attach_window(fake.clone());
        fake
    }
    pub(super) fn on_emit(&self, hook: impl Fn(&Registry, &str, &Value) + Send + Sync + 'static) {
        *self.hook.lock().unwrap() = Some(Box::new(hook));
    }
    pub(super) fn named(&self, event: &str) -> Vec<Value> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(name, _)| name == event)
            .map(|(_, payload)| payload.clone())
            .collect()
    }
}
impl MainEmitter for Fake {
    fn emit(&self, event: &str, payload: Value) -> bool {
        self.events
            .lock()
            .unwrap()
            .push((event.to_owned(), payload.clone()));
        if !self.deliver.load(Ordering::SeqCst) {
            return false;
        }
        if let (Some(registry), Some(hook)) = (
            self.registry.get().and_then(Weak::upgrade),
            self.hook.lock().unwrap().as_ref(),
        ) {
            hook(&registry, event, &payload);
        }
        true
    }
}

/// The native "turn masking off?" dialog, simulated: answers `answer`, counts
/// how often it was shown, and can run a hook while it is "open".
pub(super) struct FakeConfirm {
    pub(super) answer: AtomicBool,
    pub(super) shown: AtomicUsize,
    during: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
}
impl FakeConfirm {
    pub(super) fn new(answer: bool) -> Arc<Self> {
        Arc::new(Self {
            answer: AtomicBool::new(answer),
            shown: AtomicUsize::new(0),
            during: Mutex::default(),
        })
    }
    pub(super) fn attach(registry: &Registry, answer: bool) -> Arc<Self> {
        let confirm = Self::new(answer);
        registry.attach_confirm(confirm.clone());
        confirm
    }
    pub(super) fn while_open(&self, hook: impl Fn() + Send + Sync + 'static) {
        *self.during.lock().unwrap() = Some(Box::new(hook));
    }
    pub(super) fn shown(&self) -> usize {
        self.shown.load(Ordering::SeqCst)
    }
}
impl FakeConfirm {
    /// What the app's own dialog would do, callable where a closure is wanted.
    pub(super) fn disable_masking_for_test(&self) -> bool {
        Confirm::disable_masking(self)
    }
}
impl Confirm for FakeConfirm {
    fn disable_masking(&self) -> bool {
        self.shown.fetch_add(1, Ordering::SeqCst);
        if let Some(hook) = self.during.lock().unwrap().as_ref() {
            hook();
        }
        self.answer.load(Ordering::SeqCst)
    }
}
