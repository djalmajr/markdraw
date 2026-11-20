use super::*;
use crate::mcp_server::{platform, settings::Settings, testkit::Fake, Proxy, RootInput};
use rmcp::ServiceExt;
use std::sync::Arc;

const SHORT: Duration = Duration::from_millis(150);

struct Env {
    registry: Arc<Registry>,
    fake: Arc<Fake>,
    // parent/notes (open root), parent/elsewhere (not open), parent/notes-evil
    // (shares the root's name as a prefix, not a component).
    parent: tempfile::TempDir,
    root: PathBuf,
    root_id: String,
}
impl Env {
    fn new(timeout: Duration) -> Self {
        let parent = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        #[cfg(unix)]
        {
            // The endpoint check wants exactly 0700 (a setgid TMPDIR would add a bit).
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(parent.path(), std::fs::Permissions::from_mode(0o700))
                .unwrap();
        }
        let base = parent.path().canonicalize().unwrap();
        for dir in ["notes", "elsewhere", "notes-evil"] {
            std::fs::create_dir(base.join(dir)).unwrap();
        }
        let registry = Arc::new(Registry {
            bridge: Bridge::with_timeout(timeout),
            ..Registry::default()
        });
        let fake = Fake::attach(&registry);
        let root = base.join("notes");
        registry
            .replace(vec![RootInput {
                name: "notes".into(),
                path: root.clone(),
            }])
            .unwrap();
        let root_id = registry.list().unwrap()["roots"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        Self {
            registry,
            fake,
            parent,
            root,
            root_id,
        }
    }
    fn elsewhere(&self) -> PathBuf {
        self.parent.path().canonicalize().unwrap().join("elsewhere")
    }
    fn write(&self, dir: &Path, name: &str, text: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, text).unwrap();
        path
    }
    /// The webview answers every request with `data(kind)`.
    fn serve(&self, data: impl Fn(&str) -> Value + Send + Sync + 'static) {
        self.fake.on_emit(move |registry, event, payload| {
            if event == "mcp-state-request" {
                let kind = payload["kind"].as_str().unwrap();
                let result = registry.bridge.respond(
                    true,
                    json!({"id": payload["id"], "ok": true, "data": data(kind)}),
                );
                assert!(result.is_ok(), "valid answer refused: {result:?}");
            }
        });
    }
    async fn call(&self, tool: &str) -> Result<Value, &'static str> {
        self.registry.state(tool, Value::Null).await
    }
    fn pending(&self) -> usize {
        self.registry.bridge.lock().len()
    }
}

fn tab(id: &str, path: Option<&Path>) -> Value {
    json!({"id": id, "title": "t", "filePath": path.map(|p| p.to_string_lossy()), "active": true, "dirty": false})
}
fn tabs_data(tabs: Vec<Value>) -> Value {
    json!({"panes": [{"index": 0, "active": true, "tabs": tabs}]})
}
fn document(path: Option<&Path>, text: &str) -> Value {
    json!({"document": {"tabId": "t1", "title": "a.md", "filePath": path.map(|p| p.to_string_lossy()), "dirty": true, "language": "md", "text": text}})
}
/// A selection of the whole document text, in UTF-16 units as the editor counts.
fn selection(text: &str) -> Value {
    selection_of(text, 0, text.encode_utf16().count())
}
fn selection_of(document: &str, start: usize, end: usize) -> Value {
    json!({"selection": {"source": "editor", "tabId": "t1", "documentText": document, "start": start, "end": end}})
}
fn preview_of(document: &str, text: &str) -> Value {
    json!({"selection": {"source": "preview", "tabId": "t1", "documentText": document, "text": text}})
}

// ---- authorization of the paths the webview sends ---------------------------

#[tokio::test]
async fn tab_paths_are_authorized_by_rust_against_the_open_roots() {
    let e = Env::new(SHORT);
    std::fs::create_dir(e.root.join("sub")).unwrap();
    let inside = e.write(&e.root.join("sub"), "a.md", "a");
    let outside = e.write(&e.elsewhere(), "x.md", "x");
    let evil = e.write(&e.root.with_file_name("notes-evil"), "b.md", "b");
    let dotdot = e.root.join("..").join("elsewhere").join("x.md");
    let unsaved = e.root.join("sub").join("new.md");
    let missing_parent = e.elsewhere().join("nope").join("c.md");
    let root_itself = e.root.clone();
    let data = tabs_data(vec![
        tab("inside", Some(&inside)),
        tab("outside", Some(&outside)),
        tab("evil", Some(&evil)),
        tab("dotdot", Some(&dotdot)),
        tab("relative", Some(Path::new("sub/a.md"))),
        tab("scratch", None),
        tab("missing", Some(&missing_parent)),
        tab("unsaved", Some(&unsaved)),
        tab("root", Some(&root_itself)),
    ]);
    e.serve(move |_| data.clone());
    let value = e.call("list_open_tabs").await.unwrap();
    let files: Vec<&Value> = value["panes"][0]["tabs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| &t["file"])
        .collect();
    let out = |name: &str| json!({"name": name, "outsideRoots": true});
    assert_eq!(files[0], &json!({"rootId": e.root_id, "path": "sub/a.md"}));
    assert_eq!(files[1], &out("x.md"));
    assert_eq!(files[2], &out("b.md"), "a name that only shares a prefix");
    assert_eq!(files[3], &out("x.md"), "`..` is never resolved into a root");
    assert_eq!(files[4], &out("a.md"), "relative paths are not claims");
    assert_eq!(files[5], &Value::Null);
    assert_eq!(files[6], &out("c.md"));
    assert_eq!(
        files[7],
        &json!({"rootId": e.root_id, "path": "sub/new.md"}),
        "a saved file that is gone is still under its root"
    );
    assert_eq!(files[8], &out("notes"), "the root itself is not a file");
    // No absolute path of any kind reaches the client.
    let text = value.to_string();
    assert!(!text.contains(&e.parent.path().to_string_lossy().to_string()));
    assert!(!text.contains(&*e.root.to_string_lossy()));
    assert_eq!(e.pending(), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn a_symlink_inside_a_root_does_not_launder_an_outside_file() {
    let e = Env::new(SHORT);
    let target = e.write(&e.elsewhere(), "secret.md", "outside text");
    std::os::unix::fs::symlink(&target, e.root.join("file-link.md")).unwrap();
    std::os::unix::fs::symlink(e.elsewhere(), e.root.join("dir-link")).unwrap();
    let data = tabs_data(vec![
        tab("a", Some(&e.root.join("file-link.md"))),
        tab("b", Some(&e.root.join("dir-link").join("secret.md"))),
    ]);
    e.serve(move |_| data.clone());
    let value = e.call("list_open_tabs").await.unwrap();
    // Named as the tab claims; never located under the root.
    for (tab, name) in value["panes"][0]["tabs"]
        .as_array()
        .unwrap()
        .iter()
        .zip(["file-link.md", "secret.md"])
    {
        assert_eq!(
            tab["file"],
            json!({"name": name, "outsideRoots": true}),
            "{tab}"
        );
    }
}

#[test]
fn location_rejects_hostile_paths_as_a_class() {
    let e = Env::new(SHORT);
    let roots = e.registry.roots_snapshot().unwrap();
    let inside = e.write(&e.root, "ok.md", "");
    for hostile in [
        "".to_owned(),
        "ok.md".to_owned(),
        "./ok.md".to_owned(),
        format!("{}\0/x", e.root.display()),
        format!("{}/../notes/ok.md", e.root.display()),
        format!("{}/sub/../../elsewhere/x", e.root.display()),
        format!("{}-evil/ok.md", e.root.display()),
        "C:\\Users\\a\\ok.md".to_owned(),
        "\\\\server\\share\\ok.md".to_owned(),
    ] {
        assert!(
            matches!(roots.locate(&hostile), Location::Outside { .. }),
            "{hostile:?}"
        );
    }
    // Control: the same root, a plain path.
    assert!(matches!(
        roots.locate(&inside.to_string_lossy()),
        Location::Inside { .. }
    ));
}

#[tokio::test]
async fn nested_roots_resolve_to_the_deepest_root() {
    let e = Env::new(SHORT);
    let inner = e.root.join("inner");
    std::fs::create_dir(&inner).unwrap();
    let file = e.write(&inner, "a.md", "");
    e.registry
        .replace(vec![
            RootInput {
                name: "notes".into(),
                path: e.root.clone(),
            },
            RootInput {
                name: "inner".into(),
                path: inner.clone(),
            },
        ])
        .unwrap();
    let inner_id = e.registry.list().unwrap()["roots"][1]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let data = tabs_data(vec![tab("a", Some(&file))]);
    e.serve(move |_| data.clone());
    let value = e.call("list_open_tabs").await.unwrap();
    assert_eq!(
        value["panes"][0]["tabs"][0]["file"],
        json!({"rootId": inner_id, "path": "a.md"})
    );
}

// ---- the three tools ---------------------------------------------------------

#[tokio::test]
async fn active_document_returns_the_unsaved_buffer_only_for_authorized_files() {
    let e = Env::new(SHORT);
    let inside = e.write(&e.root, "a.md", "on disk");
    let outside = e.write(&e.elsewhere(), "x.md", "outside text");
    let buffer = "unsaved edit";
    let (i, o) = (inside.clone(), outside.clone());
    let which = Arc::new(Mutex::new(Some(i)));
    let pick = which.clone();
    e.serve(move |_| document(pick.lock().unwrap().as_deref(), buffer));
    let value = e.call("get_active_document").await.unwrap();
    let doc = &value["document"];
    assert_eq!(doc["text"], buffer);
    assert_eq!(doc["truncated"], false);
    assert_eq!(doc["dirty"], true);
    assert_eq!(doc["language"], "md");
    assert_eq!(doc["tabId"], json!(e.registry.tab_ids.one("t1").unwrap()));
    assert_ne!(doc["tabId"], "t1");
    assert_eq!(doc["file"], json!({"rootId": e.root_id, "path": "a.md"}));
    // Outside every root: named, and its text is not in the answer at all.
    *which.lock().unwrap() = Some(o);
    let value = e.call("get_active_document").await.unwrap();
    let doc = &value["document"];
    assert_eq!(doc["file"], json!({"name": "x.md", "outsideRoots": true}));
    assert!(doc.get("text").is_none(), "{doc}");
    assert!(!value.to_string().contains(buffer));
    // A draft has no file, so it is under no root: the same as outside them.
    *which.lock().unwrap() = None;
    let value = e.call("get_active_document").await.unwrap();
    let doc = &value["document"];
    assert_eq!(doc["file"], json!({"name": "a.md", "outsideRoots": true}));
    assert!(
        doc.get("text").is_none() && doc.get("truncated").is_none(),
        "{doc}"
    );
    assert!(!value.to_string().contains(buffer));
    assert_eq!(e.pending(), 0);
}

#[tokio::test]
async fn a_draft_is_never_read_out_whatever_its_size_or_content() {
    const SECRET: &str = "sk-aaaaaaaaaaaaaaaaaaaa";
    let e = Env::new(SHORT);
    let texts = [
        String::new(),
        "short draft".to_owned(),
        format!("key {SECRET}"),
        "d".repeat(DOCUMENT_LIMIT),
        "d".repeat(DOCUMENT_LIMIT + 1),
        "é".repeat(DOCUMENT_LIMIT),
    ];
    for text in texts {
        let sent = text.clone();
        e.serve(move |kind| match kind {
            "active_document" => json!({"document": {"tabId": "t1", "title": SECRET, "filePath": null, "dirty": true, "language": "", "text": sent}}),
            "selection" => selection(&sent),
            _ => json!({"panes": [{"index": 0, "active": true, "tabs": [{"id": "t1", "title": SECRET, "filePath": null, "active": true, "dirty": true}]}]}),
        });
        let doc = e.call("get_active_document").await.unwrap();
        let sel = e.call("get_selection").await.unwrap();
        for (value, key) in [(&doc, "document"), (&sel, "selection")] {
            let body = &value[key];
            // Only the (masked) title, flagged as not under any open root.
            assert_eq!(
                body["file"],
                json!({"name": "[secret]", "outsideRoots": true}),
                "{key}"
            );
            assert!(
                body.get("text").is_none() && body.get("truncated").is_none(),
                "{key}: {body}"
            );
            assert!(!value.to_string().contains(SECRET));
            if text.len() > 32 {
                assert!(
                    value.to_string().len() < 1024,
                    "{key}: the draft leaked into the answer"
                );
            }
        }
        // Control: the tab list still shows the draft, with no file.
        let tabs = e.call("list_open_tabs").await.unwrap();
        assert_eq!(tabs["panes"][0]["tabs"][0]["file"], Value::Null);
    }
    assert_eq!(e.pending(), 0);
}

#[tokio::test]
async fn no_active_document_and_no_selection_are_null() {
    let e = Env::new(SHORT);
    e.serve(|kind| match kind {
        "active_document" => json!({"document": null}),
        _ => json!({"selection": null}),
    });
    assert_eq!(
        e.call("get_active_document").await.unwrap(),
        json!({"document": null})
    );
    assert_eq!(
        e.call("get_selection").await.unwrap(),
        json!({"selection": null})
    );
    // Nothing selected means nothing more to ask.
    assert_eq!(e.fake.named("mcp-state-request").len(), 2);
}

#[tokio::test]
async fn selection_is_authorized_through_its_tab() {
    let e = Env::new(SHORT);
    let inside = e.write(&e.root, "a.md", "");
    let outside = e.write(&e.elsewhere(), "x.md", "");
    let file: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(Some(inside)));
    let pick = file.clone();
    e.serve(move |kind| match kind {
        "selection" => selection("picked words"),
        _ => tabs_data(vec![tab("t1", pick.lock().unwrap().as_deref())]),
    });
    let value = e.call("get_selection").await.unwrap();
    assert_eq!(value["selection"]["text"], "picked words");
    assert_eq!(value["selection"]["source"], "editor");
    assert_eq!(
        value["selection"]["file"],
        json!({"rootId": e.root_id, "path": "a.md"})
    );
    *file.lock().unwrap() = Some(outside);
    let value = e.call("get_selection").await.unwrap();
    assert_eq!(value["selection"]["file"]["outsideRoots"], true);
    assert!(value["selection"].get("text").is_none(), "{value}");
    assert!(!value.to_string().contains("picked words"));
    // A draft is under no root either: named by its tab title, never read out.
    *file.lock().unwrap() = None;
    let value = e.call("get_selection").await.unwrap();
    assert_eq!(
        value["selection"]["file"],
        json!({"name": "t", "outsideRoots": true})
    );
    assert!(value["selection"].get("text").is_none(), "{value}");
    assert!(!value.to_string().contains("picked words"));
    assert_eq!(e.pending(), 0);
}

#[tokio::test]
async fn selection_in_a_tab_the_list_does_not_have_is_unavailable() {
    let e = Env::new(SHORT);
    e.serve(|kind| match kind {
        "selection" => selection("words"),
        _ => tabs_data(vec![tab("another", None)]),
    });
    assert_eq!(e.call("get_selection").await, Err(UNAVAILABLE));
}

#[tokio::test]
async fn selection_and_its_tab_lookup_share_one_deadline() {
    let e = Env::new(SHORT);
    // Answers the selection, never the tab list.
    e.fake.on_emit(|registry, event, payload| {
        if event == "mcp-state-request" && payload["kind"] == "selection" {
            registry
                .bridge
                .respond(
                    true,
                    json!({"id": payload["id"], "ok": true, "data": selection("w")}),
                )
                .unwrap();
        }
    });
    let started = Instant::now();
    assert_eq!(e.call("get_selection").await, Err(TIMED_OUT));
    assert!(started.elapsed() < SHORT * 4, "{:?}", started.elapsed());
    assert_eq!(e.pending(), 0);
}

#[tokio::test]
async fn tools_refuse_arguments_without_asking_the_webview() {
    let e = Env::new(SHORT);
    for tool in TOOLS {
        for args in [json!({"x": 1}), json!([]), json!("a"), json!(1)] {
            assert_eq!(
                e.registry.state(tool, args).await,
                Err("invalid arguments"),
                "{tool}"
            );
        }
        assert!(e.registry.state(tool, json!({})).await.is_err());
    }
    assert_eq!(
        e.registry.state("nope", Value::Null).await,
        Err("invalid arguments")
    );
    assert!(
        e.fake.named("mcp-state-request").len() == TOOLS.len(),
        "only the `{{}}` calls may ask"
    );
}

// ---- limits ----------------------------------------------------------------

#[test]
fn text_limits_are_exact_at_the_boundary() {
    for limit in [DOCUMENT_LIMIT, SELECTION_LIMIT] {
        let exact = "a".repeat(limit);
        let (text, truncated) = limited_text(true, &exact, limit);
        assert_eq!((text.len(), truncated), (limit, false));
        let above = "a".repeat(limit + 1);
        let (text, truncated) = limited_text(true, &above, limit);
        assert_eq!((text.len(), truncated), (limit, true));
        assert_eq!(limited_text(true, "", limit), (String::new(), false));
        // A character that would cross the limit is dropped whole.
        let crossing = format!("{}é", "a".repeat(limit - 1));
        let (text, truncated) = limited_text(true, &crossing, limit);
        assert_eq!((text.len(), truncated), (limit - 1, true));
    }
}

#[test]
fn control_characters_are_cut_to_what_fits_the_response() {
    let (text, truncated) = limited_text(false, &"\u{1}".repeat(DOCUMENT_LIMIT), DOCUMENT_LIMIT);
    assert!(truncated);
    let encoded = serde_json::to_vec(&json!({"text": text})).unwrap().len();
    assert!(encoded < MAX_RESPONSE - 128, "{encoded}");
}

#[tokio::test]
async fn documents_and_selections_above_their_limit_are_marked_truncated() {
    // Masking a megabyte in a debug build under a loaded machine needs room.
    let e = Env::new(Duration::from_secs(20));
    let file = e.write(&e.root, "a.md", "");
    let f = file.clone();
    e.serve(move |kind| match kind {
        "active_document" => document(Some(&f), &"d".repeat(DOCUMENT_LIMIT + 1)),
        "selection" => selection(&"s".repeat(SELECTION_LIMIT + 1)),
        _ => tabs_data(vec![tab("t1", Some(&f))]),
    });
    let doc = &e.call("get_active_document").await.unwrap()["document"];
    assert_eq!(doc["text"].as_str().unwrap().len(), DOCUMENT_LIMIT);
    assert_eq!(doc["truncated"], true);
    let sel = &e.call("get_selection").await.unwrap()["selection"];
    assert_eq!(sel["text"].as_str().unwrap().len(), SELECTION_LIMIT);
    assert_eq!(sel["truncated"], true);
}

#[test]
fn a_secret_cut_by_the_limit_is_hidden_up_to_the_edge() {
    let l = SELECTION_LIMIT;
    let filler = |n: usize| " ".repeat(n);
    for (name, tail, forbidden) in [
        ("key", "sk-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "sk-"),
        ("assignment", "token=abcdefghijklmnopqrstuvwxyz", "token"),
        ("bearer", "Bearer abcdefghijklmnopqrstuvwxyz", "Bearer"),
        (
            "pem",
            "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----",
            "BEGIN",
        ),
    ] {
        // Place the secret so the limit falls inside it (past its first few bytes).
        let head = filler(l - 10 - usize::from(name == "pem") * 20);
        let raw = format!("{head}{tail}");
        let (text, truncated) = limited_text(true, &raw, l);
        assert!(truncated, "{name}");
        assert!(!text.contains(forbidden), "{name}: {:?}", &text[text.len() - 40..]);
        assert!(!text.contains("MIIE"), "{name}");
        assert!(text.trim_end().ends_with("[secret]"), "{name}");
        // Control: with masking off the same cut shows the raw edge.
        let (raw_text, _) = limited_text(false, &raw, l);
        assert!(raw_text.contains(forbidden), "{name}");
    }
    // A secret that ends exactly at the limit is masked as a whole, not cut.
    let secret = "sk-bbbbbbbbbbbbbbbbbbbbbbbb";
    let raw = format!("{}{secret}", filler(l - secret.len()));
    assert_eq!(raw.len(), l);
    let (text, truncated) = limited_text(true, &raw, l);
    assert!(!truncated);
    assert!(
        text.ends_with(" [secret]"),
        "{:?}",
        &text[text.len() - 20..]
    );
}

// ---- the mask policy -------------------------------------------------------

#[tokio::test]
async fn the_mask_policy_governs_text_titles_and_paths() {
    let e = Env::new(SHORT);
    let named = e.write(&e.root, "sk-aaaaaaaaaaaaaaaaaaaa.md", "");
    let secret = "key sk-aaaaaaaaaaaaaaaaaaaa end";
    let f = named.clone();
    e.serve(move |kind| match kind {
        "tabs" => json!({"panes": [{"index": 0, "active": true, "tabs": [
            {"id": "t1", "title": "sk-aaaaaaaaaaaaaaaaaaaa", "filePath": f.to_string_lossy(), "active": true, "dirty": false}]}]}),
        "selection" => selection(secret),
        _ => document(Some(&f), secret),
    });
    let masked = [
        e.call("list_open_tabs").await.unwrap(),
        e.call("get_active_document").await.unwrap(),
        e.call("get_selection").await.unwrap(),
    ];
    for value in &masked {
        assert!(!value.to_string().contains("sk-aaaa"), "{value}");
    }
    assert_eq!(masked[1]["document"]["text"], "key [secret] end");
    e.registry
        .policy
        .set_with(
            Settings {
                mask_secrets: false,
            },
            |_| Ok(()),
        )
        .unwrap();
    let raw = [
        e.call("list_open_tabs").await.unwrap(),
        e.call("get_active_document").await.unwrap(),
        e.call("get_selection").await.unwrap(),
    ];
    assert_eq!(raw[1]["document"]["text"], secret);
    assert_eq!(raw[2]["selection"]["text"], secret);
    assert_eq!(
        raw[0]["panes"][0]["tabs"][0]["title"],
        "sk-aaaaaaaaaaaaaaaaaaaa"
    );
    assert_eq!(
        raw[0]["panes"][0]["tabs"][0]["file"]["path"],
        "sk-aaaaaaaaaaaaaaaaaaaa.md"
    );
}

#[tokio::test]
async fn one_request_uses_one_policy_value_even_if_the_ui_changes_it_midway() {
    let e = Env::new(SHORT);
    let file = e.write(&e.root, "a.md", "").to_string_lossy().into_owned();
    e.fake.on_emit(move |registry, event, payload| {
        if event == "mcp-state-request" {
            registry
                .policy
                .set_with(Settings { mask_secrets: false }, |_| Ok(()))
                .unwrap();
            registry
                .bridge
                .respond(
                    true,
                    json!({"id": payload["id"], "ok": true, "data": document(Some(Path::new(&file)), "k sk-aaaaaaaaaaaaaaaaaaaa")}),
                )
                .unwrap();
        }
    });
    // Read before the request started: masked, although the policy flipped
    // while the webview was answering.
    let value = e.call("get_active_document").await.unwrap();
    assert_eq!(value["document"]["text"], "k [secret]");
    let value = e.call("get_active_document").await.unwrap();
    assert_eq!(value["document"]["text"], "k sk-aaaaaaaaaaaaaaaaaaaa");
}

// ---- the request/response protocol ------------------------------------------

fn capture_id(e: &Env) -> Arc<Mutex<Vec<String>>> {
    let ids = Arc::new(Mutex::new(Vec::new()));
    let sink = ids.clone();
    e.fake.on_emit(move |_, event, payload| {
        if event == "mcp-state-request" {
            sink.lock()
                .unwrap()
                .push(payload["id"].as_str().unwrap().into());
        }
    });
    ids
}
fn valid(kind_data: Value, id: &str) -> Value {
    json!({"id": id, "ok": true, "data": kind_data})
}

#[tokio::test]
async fn the_request_event_carries_a_random_id_and_the_kind_only() {
    let e = Env::new(SHORT);
    let ids = capture_id(&e);
    for tool in TOOLS {
        let _ = e.call(tool).await;
    }
    let requests = e.fake.named("mcp-state-request");
    assert_eq!(requests.len(), 3);
    for (request, kind) in requests
        .iter()
        .zip(["tabs", "active_document", "selection"])
    {
        assert_eq!(request.as_object().unwrap().len(), 2);
        assert_eq!(request["kind"], kind);
        assert_eq!(request["id"].as_str().unwrap().len(), 64);
    }
    let ids = ids.lock().unwrap();
    assert_ne!(ids[0], ids[1]);
    assert_ne!(ids[1], ids[2]);
}

#[tokio::test]
async fn a_silent_frontend_times_out_without_stale_data() {
    let e = Env::new(SHORT);
    let started = Instant::now();
    assert_eq!(e.call("list_open_tabs").await, Err(TIMED_OUT));
    assert!(started.elapsed() >= SHORT);
    assert_eq!(e.pending(), 0);
    // A later request is a fresh one: the earlier silence cached nothing.
    e.serve(|_| tabs_data(vec![]));
    assert_eq!(
        e.call("list_open_tabs").await.unwrap(),
        json!({"panes": [{"index": 0, "active": true, "tabs": []}]})
    );
}

#[test]
fn the_default_deadline_is_three_seconds() {
    assert_eq!(STATE_TIMEOUT, Duration::from_secs(3));
    assert_eq!(Bridge::default().timeout, STATE_TIMEOUT);
}

#[tokio::test]
async fn no_main_window_means_unavailable() {
    let registry = Arc::new(Registry::default());
    assert_eq!(
        registry.state("get_selection", Value::Null).await,
        Err(UNAVAILABLE)
    );
    let e = Env::new(SHORT);
    e.fake.deliver.store(false, Ordering::SeqCst);
    assert_eq!(e.call("list_open_tabs").await, Err(UNAVAILABLE));
    assert_eq!(
        e.pending(),
        0,
        "an event that was not delivered leaves no id"
    );
}

#[tokio::test]
async fn an_answer_from_another_window_is_refused_and_changes_nothing() {
    let e = Env::new(SHORT);
    let ids = capture_id(&e);
    let registry = e.registry.clone();
    let call = tokio::spawn(async move { registry.state("list_open_tabs", Value::Null).await });
    while ids.lock().unwrap().is_empty() {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    let id = ids.lock().unwrap()[0].clone();
    let forged = e
        .registry
        .bridge
        .respond(false, valid(tabs_data(vec![]), &id));
    assert!(forged.is_err());
    assert_eq!(e.pending(), 1, "the forged answer must not consume the id");
    // Control: the right window can still answer the same request.
    assert!(e
        .registry
        .bridge
        .respond(true, valid(tabs_data(vec![]), &id))
        .is_ok());
    assert!(call.await.unwrap().is_ok());
}

#[tokio::test]
async fn an_unknown_id_is_refused_and_the_real_request_is_not_completed() {
    let e = Env::new(SHORT);
    e.fake.on_emit(|registry, event, _| {
        if event == "mcp-state-request" {
            let wrong = registry
                .bridge
                .respond(true, valid(tabs_data(vec![]), &"f".repeat(64)));
            assert!(wrong.is_err(), "an id nobody asked for was accepted");
        }
    });
    assert_eq!(e.call("list_open_tabs").await, Err(TIMED_OUT));
    assert_eq!(e.pending(), 0);
}

#[tokio::test]
async fn a_repeated_answer_is_refused_and_the_first_one_wins() {
    let e = Env::new(SHORT);
    e.fake.on_emit(|registry, event, payload| {
        if event == "mcp-state-request" {
            let id = payload["id"].as_str().unwrap();
            let first = registry
                .bridge
                .respond(true, valid(tabs_data(vec![tab("first", None)]), id));
            let second = registry
                .bridge
                .respond(true, valid(tabs_data(vec![tab("second", None)]), id));
            assert!(first.is_ok() && second.is_err());
        }
    });
    let value = e.call("list_open_tabs").await.unwrap();
    assert_eq!(
        value["panes"][0]["tabs"][0]["id"],
        json!(e.registry.tab_ids.one("first").unwrap())
    );
    assert_eq!(
        e.registry.tab_ids.0.lock().unwrap().len(),
        1,
        "the second answer was read"
    );
}

#[tokio::test]
async fn a_late_answer_is_refused() {
    let e = Env::new(SHORT);
    let ids = capture_id(&e);
    assert_eq!(e.call("list_open_tabs").await, Err(TIMED_OUT));
    let id = ids.lock().unwrap()[0].clone();
    assert!(e
        .registry
        .bridge
        .respond(true, valid(tabs_data(vec![]), &id))
        .is_err());
    assert_eq!(e.pending(), 0);
}

#[tokio::test]
async fn answers_of_the_wrong_shape_fail_the_request_whole() {
    let big_title = "t".repeat(MAX_TITLE + 1);
    let too_many = tabs_data(
        (0..MAX_TABS + 1)
            .map(|i| tab(&i.to_string(), None))
            .collect(),
    );
    let cases: Vec<(&str, &str, Value)> = vec![
        ("list_open_tabs", "panes is a string", json!({"panes": "x"})),
        (
            "list_open_tabs",
            "extra field",
            json!({"panes": [], "extra": 1}),
        ),
        (
            "list_open_tabs",
            "tab id is a number",
            tabs_data(vec![
                json!({"id": 1, "title": "t", "filePath": null, "active": true, "dirty": false}),
            ]),
        ),
        (
            "list_open_tabs",
            "dirty is a string",
            tabs_data(vec![
                json!({"id": "a", "title": "t", "filePath": null, "active": true, "dirty": "no"}),
            ]),
        ),
        (
            "list_open_tabs",
            "title too long",
            tabs_data(vec![
                tab("a", None),
                json!({"id": "b", "title": big_title, "filePath": null, "active": true, "dirty": false}),
            ]),
        ),
        ("list_open_tabs", "too many tabs", too_many),
        (
            "list_open_tabs",
            "a document answer to a tabs request",
            document(None, "x"),
        ),
        (
            "get_active_document",
            "text is a number",
            json!({"document": {"tabId": "a", "title": "t", "filePath": null, "dirty": false, "language": "md", "text": 1}}),
        ),
        (
            "get_active_document",
            "document is a string",
            json!({"document": "x"}),
        ),
        ("get_active_document", "no document key", json!({})),
        (
            "get_selection",
            "unknown source",
            json!({"selection": {"source": "terminal", "tabId": "a", "text": "x"}}),
        ),
        (
            "get_selection",
            "selection is a list",
            json!({"selection": []}),
        ),
    ];
    for (tool, why, data) in cases {
        let e = Env::new(SHORT);
        e.serve(move |_| data.clone());
        assert_eq!(e.call(tool).await, Err("invalid response"), "{why}");
        assert_eq!(e.pending(), 0, "{why}");
    }
}

#[tokio::test]
async fn the_envelope_must_be_exactly_ok_with_data_or_unavailable() {
    for (envelope, expected) in [
        (json!({"ok": true, "data": {"panes": []}}), Ok(())),
        (
            json!({"ok": false, "error": "unavailable"}),
            Err(UNAVAILABLE),
        ),
        (
            json!({"ok": false, "error": "boom /home/x"}),
            Err("invalid response"),
        ),
        (json!({"ok": true}), Err("invalid response")),
        (
            json!({"ok": true, "data": {"panes": []}, "error": "unavailable"}),
            Err("invalid response"),
        ),
        (
            json!({"ok": "yes", "data": {"panes": []}}),
            Err("invalid response"),
        ),
        (
            json!({"ok": true, "data": {"panes": []}, "extra": 1}),
            Err("invalid response"),
        ),
        (json!({"data": {"panes": []}}), Err("invalid response")),
    ] {
        let e = Env::new(SHORT);
        let envelope2 = envelope.clone();
        e.fake.on_emit(move |registry, event, payload| {
            if event == "mcp-state-request" {
                let mut response = envelope2.clone();
                response["id"] = payload["id"].clone();
                // A malformed answer for a waiting id still consumes it, so the
                // request ends at once instead of waiting out the deadline.
                let accepted = registry.bridge.respond(true, response);
                assert!(accepted.is_ok(), "{envelope2}");
            }
        });
        let started = Instant::now();
        let result = e.call("list_open_tabs").await.map(|_| ());
        assert_eq!(result, expected, "{envelope}");
        assert!(started.elapsed() < SHORT, "{envelope}");
    }
}

#[tokio::test]
async fn an_answer_with_a_wrong_typed_or_missing_id_is_refused() {
    let e = Env::new(SHORT);
    for response in [
        json!({"id": 1, "ok": true, "data": {}}),
        json!({"ok": true}),
        json!("x"),
        json!(null),
        json!([]),
    ] {
        assert!(e.registry.bridge.respond(true, response).is_err());
    }
}

#[tokio::test]
async fn racing_answers_for_one_id_complete_it_exactly_once() {
    for _ in 0..50 {
        let e = Env::new(Duration::from_secs(10));
        let ids = capture_id(&e);
        let registry = e.registry.clone();
        let call = tokio::spawn(async move { registry.state("list_open_tabs", Value::Null).await });
        while ids.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        let id = ids.lock().unwrap()[0].clone();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = ["first", "second"]
            .into_iter()
            .map(|name| {
                let registry = e.registry.clone();
                let barrier = barrier.clone();
                let answer = valid(tabs_data(vec![tab(name, None)]), &id);
                std::thread::spawn(move || {
                    barrier.wait();
                    registry.bridge.respond(true, answer).is_ok()
                })
            })
            .collect();
        let accepted = handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .filter(|ok| *ok)
            .count();
        assert_eq!(accepted, 1);
        assert!(call.await.unwrap().is_ok());
    }
}

#[tokio::test]
async fn a_page_reload_fails_waiting_requests_at_once_and_a_close_refuses_new_ones() {
    let e = Env::new(Duration::from_secs(30));
    let ids = capture_id(&e);
    let registry = e.registry.clone();
    let call =
        tokio::spawn(async move { registry.state("get_active_document", Value::Null).await });
    while ids.lock().unwrap().is_empty() {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    let started = Instant::now();
    e.registry.page_reloading();
    assert_eq!(call.await.unwrap(), Err(UNAVAILABLE));
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(e.pending(), 0);
    // After shutdown nothing new is asked.
    let before = e.fake.named("mcp-state-request").len();
    e.registry.shutdown();
    assert_eq!(e.call("get_active_document").await, Err(UNAVAILABLE));
    assert_eq!(e.fake.named("mcp-state-request").len(), before);
}

#[tokio::test]
async fn a_dropped_request_leaves_no_answerable_id() {
    let e = Env::new(Duration::from_secs(30));
    let ids = capture_id(&e);
    let dropped = tokio::time::timeout(Duration::from_millis(50), e.call("get_selection")).await;
    assert!(dropped.is_err());
    assert_eq!(e.pending(), 0);
    let id = ids.lock().unwrap()[0].clone();
    assert!(e
        .registry
        .bridge
        .respond(true, valid(selection("x"), &id))
        .is_err());
}

#[tokio::test]
async fn pending_requests_are_bounded() {
    let e = Env::new(Duration::from_secs(30));
    let ids = capture_id(&e);
    let mut calls = Vec::new();
    for _ in 0..MAX_PENDING {
        let registry = e.registry.clone();
        calls.push(tokio::spawn(async move {
            registry.state("list_open_tabs", Value::Null).await
        }));
    }
    while ids.lock().unwrap().len() < MAX_PENDING {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    assert_eq!(e.call("list_open_tabs").await, Err(BUSY));
    e.registry.page_reloading();
    for call in calls {
        assert_eq!(call.await.unwrap(), Err(UNAVAILABLE));
    }
}

#[tokio::test]
async fn errors_carry_no_path_and_no_content() {
    let e = Env::new(SHORT);
    e.serve(|_| json!({"panes": [], "leak": "/home/user/secret.md sk-aaaaaaaaaaaaaaaaaaaa"}));
    let error = e.call("list_open_tabs").await.unwrap_err();
    assert_eq!(error, "invalid response");
}

#[test]
fn the_response_guard_refuses_what_the_ipc_frame_cannot_carry() {
    assert!(bounded(json!({"text": "a".repeat(MAX_RESPONSE)})).is_err());
    assert!(bounded(json!({"text": "a".repeat(1024)})).is_ok());
}

// ---- through the real IPC and MCP stack ----------------------------------

#[cfg(unix)]
#[tokio::test]
async fn real_rmcp_client_reaches_the_live_tools_and_cannot_pass_arguments() {
    use rmcp::model::CallToolRequestParams;
    use std::os::unix::fs::PermissionsExt;
    let e = Env::new(SHORT);
    let file = e.write(&e.root, "a.md", "");
    let f = file.clone();
    e.serve(move |kind| match kind {
        "active_document" => document(Some(&f), "hello sk-aaaaaaaaaaaaaaaaaaaa"),
        _ => tabs_data(vec![tab("t1", Some(&f))]),
    });
    let directory = e.parent.path().join("endpoint");
    std::fs::create_dir(&directory).unwrap();
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    let _endpoint = platform::Endpoint::start(&directory, e.registry.clone()).unwrap();
    let (client_io, server_io) = tokio::io::duplex(MAX_RESPONSE);
    let server = tokio::spawn(async move {
        Proxy::new(directory)
            .serve(server_io)
            .await
            .unwrap()
            .waiting()
            .await
            .unwrap();
    });
    let client = ().serve(client_io).await.unwrap();
    let tools = client.list_all_tools().await.unwrap();
    for name in TOOLS {
        let tool = tools.iter().find(|tool| tool.name == name).expect(name);
        assert_eq!(
            tool.annotations.as_ref().unwrap().read_only_hint,
            Some(true)
        );
        assert!(!tool.description.as_deref().unwrap().contains("always"));
    }
    let result = client
        .call_tool(CallToolRequestParams::new("get_active_document"))
        .await
        .unwrap();
    let value = result.structured_content.unwrap();
    assert_eq!(value["document"]["text"], "hello [secret]");
    assert_eq!(value["document"]["file"]["rootId"], e.root_id);
    let result = client
        .call_tool(CallToolRequestParams::new("list_open_tabs"))
        .await
        .unwrap();
    assert_eq!(
        result.structured_content.unwrap()["panes"][0]["tabs"][0]["file"]["path"],
        "a.md"
    );
    let error = client
        .call_tool(
            CallToolRequestParams::new("get_selection")
                .with_arguments(json!({"x": 1}).as_object().unwrap().clone()),
        )
        .await
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("Unknown tool or invalid arguments"));
    // A frontend that does not answer is a tool error with fixed text.
    e.fake.on_emit(|_, _, _| {});
    let result = client
        .call_tool(CallToolRequestParams::new("get_selection"))
        .await
        .unwrap();
    assert_eq!(result.is_error, Some(true));
    assert_eq!(result.content[0].as_text().unwrap().text, TIMED_OUT);
    client.cancel().await.unwrap();
    server.await.unwrap();
}

// ---- F1: the client never sees the webview's tab id --------------------------

const SECRET_KEY: &str = "sk-aaaaaaaaaaaaaaaaaaaa";

#[tokio::test]
async fn the_client_gets_opaque_tab_ids_never_the_webview_ones() {
    let e = Env::new(SHORT);
    let file = e.write(&e.root, "a.md", "text");
    let path_id = format!("{}::a.md", e.root.display());
    let (f, pid) = (file.clone(), path_id.clone());
    e.serve(move |kind| match kind {
        "tabs" => json!({"panes": [
            {"index": 0, "active": true, "tabs": [
                {"id": pid, "title": "a.md", "filePath": f.to_string_lossy(), "active": true, "dirty": false},
                {"id": "other", "title": "b", "filePath": null, "active": false, "dirty": false}]},
            // The same tab id in a second pane (the same file open twice).
            {"index": 1, "active": false, "tabs": [
                {"id": pid, "title": "a.md", "filePath": f.to_string_lossy(), "active": true, "dirty": false}]}]}),
        "active_document" => json!({"document": {"tabId": pid, "title": "a.md", "filePath": f.to_string_lossy(), "dirty": false, "language": "md", "text": "text"}}),
        _ => json!({"selection": {"source": "editor", "tabId": pid, "documentText": "text", "start": 0, "end": 4}}),
    });
    let tabs = e.call("list_open_tabs").await.unwrap();
    let doc = e.call("get_active_document").await.unwrap();
    let sel = e.call("get_selection").await.unwrap();
    for value in [&tabs, &doc, &sel] {
        let text = value.to_string();
        assert!(!text.contains(&path_id), "{text}");
        assert!(!text.contains(&e.root.display().to_string()), "{text}");
    }
    let first = tabs["panes"][0]["tabs"][0]["id"].as_str().unwrap();
    assert_eq!(first.len(), 64);
    assert!(first.bytes().all(|b| b.is_ascii_hexdigit()));
    // Identity: one webview id is one opaque id (in both panes, in every tool,
    // across calls); a different webview id is a different one.
    assert_eq!(tabs["panes"][1]["tabs"][0]["id"], first);
    assert_eq!(doc["document"]["tabId"], first);
    assert_eq!(sel["selection"]["tabId"], first);
    assert_ne!(tabs["panes"][0]["tabs"][1]["id"], first);
    let again = e.call("list_open_tabs").await.unwrap();
    assert_eq!(again["panes"][0]["tabs"][0]["id"], first);
    // Nothing in the answer lets the client rebuild the webview's id.
    assert_ne!(first, path_id);
    assert_eq!(
        doc["document"]["file"],
        json!({"rootId": e.root_id, "path": "a.md"})
    );
}

#[test]
fn the_tab_id_map_is_bounded_and_keeps_stable_ids_below_the_bound() {
    let ids = TabIds::default();
    let first = ids.one("a").unwrap();
    for n in 0..MAX_TAB_IDS / 2 {
        ids.one(&n.to_string()).unwrap();
    }
    assert_eq!(ids.one("a").unwrap(), first);
    for n in 0..MAX_TAB_IDS * 2 {
        ids.one(&format!("x{n}")).unwrap();
        assert!(ids.0.lock().unwrap().len() <= MAX_TAB_IDS);
    }
}

// ---- F2: a selection is masked in the context of its document -----------------

async fn selected(e: &Env, document: &str, start: usize, end: usize) -> Value {
    let file = e.write(&e.root, "s.md", "");
    let data = selection_of(document, start, end);
    e.serve(move |kind| match kind {
        "selection" => data.clone(),
        _ => tabs_data(vec![tab("t1", Some(&file))]),
    });
    e.call("get_selection").await.unwrap()
}
fn span(document: &str, part: &str) -> (usize, usize) {
    let at = document.find(part).unwrap();
    let start = document[..at].encode_utf16().count();
    (start, start + part.encode_utf16().count())
}

#[tokio::test]
async fn a_value_selected_alone_is_hidden_by_the_document_around_it() {
    let e = Env::new(SHORT);
    let pem_body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC";
    let document = format!(
        "intro\npassword = hunter2hunter2abc\nnote {SECRET_KEY} end\n-----BEGIN PRIVATE KEY-----\n{pem_body}\nSECONDLINEOFTHEBODY\n-----END PRIVATE KEY-----\nTrailing text\n"
    );
    for (part, forbidden) in [
        ("hunter2hunter2abc", "hunter2"),
        ("aaaaaaaaaaaaaaaaaaaa", "aaaaa"),
        (&SECRET_KEY[3..9], "aaaaaa"),
        (pem_body, "MIIE"),
        ("SECONDLINEOFTHEBODY", "SECONDLINE"),
    ] {
        let (start, end) = span(&document, part);
        let value = selected(&e, &document, start, end).await;
        let text = value["selection"]["text"].as_str().unwrap();
        assert!(!text.contains(forbidden), "{part}: {text:?}");
        assert_eq!(text, "[secret]", "{part}");
        // Control: the same bytes selected with masking off are the raw ones.
        e.registry
            .policy
            .set_with(
                Settings {
                    mask_secrets: false,
                },
                |_| Ok(()),
            )
            .unwrap();
        let raw = selected(&e, &document, start, end).await;
        assert_eq!(raw["selection"]["text"], part);
        e.registry
            .policy
            .set_with(Settings { mask_secrets: true }, |_| Ok(()))
            .unwrap();
    }
    // A range over plain text and the start of a secret keeps the plain text.
    let (start, end) = span(&document, "intro\npassword = hunter2");
    let value = selected(&e, &document, start, end).await;
    assert_eq!(value["selection"]["text"], "intro\n[secret]");
    // Plain text with nothing around it that hides it stays readable.
    let (start, end) = span(&document, "Trailing text");
    let value = selected(&e, &document, start, end).await;
    assert_eq!(value["selection"]["text"], "Trailing text");
    // A range through the whole PEM block: the lines keep their endings.
    let (start, end) = span(&document, "-----END PRIVATE KEY-----\nTrailing");
    let value = selected(&e, &document, start, end).await;
    assert!(!value.to_string().contains("MIIE"), "{value}");
}

#[tokio::test]
async fn selection_offsets_are_utf16_and_hostile_ones_are_rejected_whole() {
    let e = Env::new(SHORT);
    // `é` is one UTF-16 unit and two bytes; the emoji is two units and four bytes.
    let document = "é😀 sk-aaaaaaaaaaaaaaaaaaaa x";
    let value = selected(&e, document, 0, 1).await;
    assert_eq!(value["selection"]["text"], "é");
    let value = selected(&e, document, 1, 3).await;
    assert_eq!(value["selection"]["text"], "😀");
    let value = selected(&e, document, 0, 4).await;
    assert_eq!(value["selection"]["text"], "é😀 ");
    let units = document.encode_utf16().count();
    let value = selected(&e, document, units - 1, units).await;
    assert_eq!(value["selection"]["text"], "x");
    // Empty range: no selection, nothing asked for text.
    assert_eq!(
        selected(&e, document, 3, 3).await,
        json!({"selection": null})
    );
    // Inside the emoji, past the end, backwards, negative, fractional, huge:
    // the whole answer is refused with the fixed text.
    for (start, end) in [
        (2, 3),
        (1, 2),
        (0, units + 1),
        (units + 1, units + 2),
        (3, 1),
    ] {
        let file = e.write(&e.root, "s.md", "");
        let data = selection_of(document, start, end);
        e.serve(move |kind| match kind {
            "selection" => data.clone(),
            _ => tabs_data(vec![tab("t1", Some(&file))]),
        });
        assert_eq!(
            e.call("get_selection").await,
            Err("invalid response"),
            "{start}..{end}"
        );
    }
    for bad in [
        json!(-1),
        json!(1.5),
        json!(4294967296u64),
        json!("1"),
        json!(null),
    ] {
        let file = e.write(&e.root, "s.md", "");
        let mut data = selection_of(document, 0, 1);
        data["selection"]["end"] = bad.clone();
        e.serve(move |kind| match kind {
            "selection" => data.clone(),
            _ => tabs_data(vec![tab("t1", Some(&file))]),
        });
        assert_eq!(
            e.call("get_selection").await,
            Err("invalid response"),
            "{bad}"
        );
    }
}

#[tokio::test]
async fn selections_at_and_above_their_limit_in_big_documents() {
    let e = Env::new(Duration::from_secs(20));
    // A selection of exactly the limit is whole; one more byte is cut.
    for (extra, truncated) in [(0, false), (1, true)] {
        let document = "s".repeat(SELECTION_LIMIT + extra);
        let value = selected(&e, &document, 0, SELECTION_LIMIT + extra).await;
        assert_eq!(value["selection"]["truncated"], truncated);
        assert_eq!(
            value["selection"]["text"].as_str().unwrap().len(),
            SELECTION_LIMIT
        );
    }
    // A secret that the limit cuts through is hidden up to the edge, by the
    // document, even though the rest of it is not in the answer.
    let secret = format!("sk-{}", "b".repeat(40));
    let document = format!("{}{secret} tail", " ".repeat(SELECTION_LIMIT - 10));
    let value = selected(&e, &document, 0, document.len()).await;
    let text = value["selection"]["text"].as_str().unwrap();
    assert_eq!(value["selection"]["truncated"], true);
    assert!(
        !text.contains("sk-") && !text.contains("bbbb"),
        "{:?}",
        &text[text.len() - 20..]
    );
    assert!(text.ends_with("[secret]"));
    // A document above the document limit is not read out at all (no window
    // masking): the selection is unavailable, whatever it covers.
    let mut document = format!("token = {}\n", "q".repeat(30));
    document.push_str(&"filler line\n".repeat(DOCUMENT_LIMIT / 12 + 100));
    assert!(document.len() > DOCUMENT_LIMIT);
    let file = e.write(&e.root, "s.md", "");
    for (start, end) in [
        span(&document, &"q".repeat(30)),
        (document.len() - 12, document.len() - 1),
    ] {
        let (f, data) = (file.clone(), selection_of(&document, start, end));
        e.serve(move |kind| match kind {
            "selection" => data.clone(),
            _ => tabs_data(vec![tab("t1", Some(&f))]),
        });
        assert_eq!(e.call("get_selection").await, Err(UNAVAILABLE));
    }
}

#[tokio::test]
async fn a_preview_selection_is_masked_by_where_the_source_hides_it() {
    let e = Env::new(SHORT);
    let file = e.write(&e.root, "s.md", "");
    let document = format!("token = {}\nplain words here\n", "r".repeat(30));
    let run = |text: &'static str| {
        let (f, d) = (file.clone(), document.clone());
        let data = preview_of(&d, text);
        e.serve(move |kind| match kind {
            "selection" => data.clone(),
            _ => tabs_data(vec![tab("t1", Some(&f))]),
        });
    };
    run("plain words");
    assert_eq!(
        e.call("get_selection").await.unwrap()["selection"]["text"],
        "plain words"
    );
    run("rrrrrrrrrrrrrrrrrrrrrrrrrrrrrr");
    assert_eq!(
        e.call("get_selection").await.unwrap()["selection"]["text"],
        "[secret]"
    );
    // Text that is not in the source (the rendering differs): refused, never
    // returned unmasked.
    run("not in the source");
    assert_eq!(e.call("get_selection").await, Err(UNAVAILABLE));
}

#[tokio::test]
async fn a_preview_text_found_more_than_once_is_unavailable_overlapping_included() {
    let e = Env::new(SHORT);
    let file = e.write(&e.root, "s.md", "");
    let secret = "r".repeat(30);
    // The same rendered text twice, hidden in one place and visible in the other.
    let two_places = format!("{secret}\nplain\ntoken = {secret}\n");
    // Two occurrences that overlap (31 characters hold 30 twice): a search
    // for non-overlapping matches finds one.
    let overlapping = format!("token = {}\n", "r".repeat(31));
    let single = format!("token = {secret}\nplain words here\n");
    for (document, text, expected) in [
        (&two_places, secret.as_str(), Err(UNAVAILABLE)),
        (&overlapping, secret.as_str(), Err(UNAVAILABLE)),
        // Control: one occurrence goes on as before (masked where hidden).
        (&single, secret.as_str(), Ok("[secret]")),
        (&single, "plain words", Ok("plain words")),
    ] {
        let (f, data) = (file.clone(), preview_of(document, text));
        e.serve(move |kind| match kind {
            "selection" => data.clone(),
            _ => tabs_data(vec![tab("t1", Some(&f))]),
        });
        let result = e.call("get_selection").await;
        match expected {
            Err(error) => assert_eq!(result, Err(error), "{text}"),
            Ok(text) => assert_eq!(result.unwrap()["selection"]["text"], text),
        }
    }
}

#[test]
fn the_masking_of_a_preview_text_refuses_any_second_occurrence() {
    // Overlapping occurrences: "aa" sits at 0 and at 1 of "aaa"; only the
    // first is found by a non-overlapping scan.
    let pick = Pick::Text("aa".into());
    assert_eq!(masked_selection(true, "aaa", &pick), Err(UNAVAILABLE));
    assert_eq!(masked_selection(true, "aaaa", &pick), Err(UNAVAILABLE));
    // Multi-byte first character: the second search starts on a boundary.
    let pick = Pick::Text("éé".into());
    assert_eq!(masked_selection(true, "ééé", &pick), Err(UNAVAILABLE));
    // Control: once.
    assert_eq!(
        masked_selection(true, "aab", &Pick::Text("ab".into())),
        Ok(Some(("ab".into(), false)))
    );
}

// ---- round 6, F1: the payload is moved, never copied, and checked first ---------

fn address(value: &Value) -> usize {
    value.as_str().unwrap().as_ptr() as usize
}

#[test]
fn the_envelope_hands_over_the_payload_it_was_given() {
    let big = "x".repeat(8 * 1024 * 1024);
    let response = json!({"id": "i", "ok": true, "data": {"document": {"text": big}}});
    let before = address(&response["data"]["document"]["text"]);
    let data = envelope(response).unwrap();
    // The same heap block: a clone would have allocated a new one.
    assert_eq!(address(&data["document"]["text"]), before);
    // Control: the invalid shapes are still refused whole.
    for bad in [
        json!({"id": "i", "ok": true, "data": 1}),
        json!({"id": "i", "ok": true}),
        json!({"id": "i", "ok": true, "data": {}, "error": null}),
        json!({"id": "i", "ok": false, "error": "x"}),
    ] {
        assert_eq!(envelope(bad), Err(INVALID_RESPONSE));
    }
}

#[test]
fn the_parsers_move_the_texts_and_check_their_size_first() {
    let document = "d".repeat(512 * 1024);
    let data = preview_of(&document, "dd");
    let (doc_at, text_at) = (
        address(&data["selection"]["documentText"]),
        address(&data["selection"]["text"]),
    );
    let parsed = parse_selection(data).unwrap().unwrap();
    assert_eq!(parsed.document.as_ptr() as usize, doc_at);
    let Pick::Text(text) = &parsed.pick else {
        panic!("preview pick")
    };
    assert_eq!(text.as_ptr() as usize, text_at);
    let data = document_data(&document);
    let at = address(&data["document"]["text"]);
    let parsed = parse_document(data).unwrap().unwrap();
    assert_eq!(parsed.text.as_ptr() as usize, at);
    // Over the limit: the document is dropped, and a preview's text with it.
    let big = "d".repeat(DOCUMENT_LIMIT + 1);
    let parsed = parse_selection(preview_of(&big, "dd")).unwrap().unwrap();
    assert!(parsed.oversized && parsed.document.is_empty());
    assert!(matches!(&parsed.pick, Pick::Text(text) if text.is_empty()));
    // [boundary] The picked text of a preview cannot outgrow the largest document.
    let at_limit = "t".repeat(MAX_SELECTION_DOCUMENT);
    assert!(parse_selection(preview_of("d", &at_limit)).is_ok());
    let over = "t".repeat(MAX_SELECTION_DOCUMENT + 1);
    assert_eq!(
        parse_selection(preview_of("d", &over)).err(),
        Some(INVALID_RESPONSE)
    );
}

fn document_data(text: &str) -> Value {
    json!({"document": {"tabId": "t1", "title": "a.md", "filePath": null, "dirty": true, "language": "md", "text": text}})
}

#[test]
fn a_big_answer_reaches_the_waiter_by_the_same_allocation() {
    // Through `Bridge::respond` itself: it consumes the answer.
    let bridge = Bridge::with_timeout(Duration::from_secs(5));
    let (sender, mut receiver) = tokio::sync::oneshot::channel();
    bridge.lock().insert(
        "id1".into(),
        Waiting {
            sender,
            deadline: bridge.deadline(),
        },
    );
    let response = valid(document_data(&"y".repeat(8 * 1024 * 1024)), "id1");
    let before = address(&response["data"]["document"]["text"]);
    bridge.respond(true, response).unwrap();
    let data = receiver.try_recv().unwrap().unwrap();
    assert_eq!(address(&data["document"]["text"]), before);
}

// ---- F5: the deadline decides ----------------------------------------------

fn poll_once<F: std::future::Future>(
    future: &mut std::pin::Pin<Box<F>>,
) -> std::task::Poll<F::Output> {
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    future.as_mut().poll(&mut cx)
}

#[tokio::test]
async fn an_answer_after_the_deadline_is_refused_before_the_waiter_runs() {
    let e = Env::new(SHORT);
    let ids = capture_id(&e);
    let registry = e.registry.clone();
    let mut call = Box::pin(async move { registry.state("list_open_tabs", Value::Null).await });
    assert!(poll_once(&mut call).is_pending());
    let id = ids.lock().unwrap()[0].clone();
    // The waiter is not polled while the deadline passes, so it has not
    // removed the id: only the answer's own check can refuse it.
    std::thread::sleep(SHORT + Duration::from_millis(60));
    assert_eq!(e.pending(), 1);
    let late = e
        .registry
        .bridge
        .respond(true, valid(tabs_data(vec![tab("late", None)]), &id));
    assert_eq!(late, Err(REFUSED));
    assert_eq!(call.await, Err(TIMED_OUT));
    assert_eq!(e.pending(), 0);
}

#[tokio::test]
async fn data_that_arrives_in_time_but_is_collected_late_is_not_returned() {
    let e = Env::new(SHORT);
    let ids = capture_id(&e);
    let registry = e.registry.clone();
    let mut call = Box::pin(async move { registry.state("list_open_tabs", Value::Null).await });
    assert!(poll_once(&mut call).is_pending());
    let id = ids.lock().unwrap()[0].clone();
    let on_time = e
        .registry
        .bridge
        .respond(true, valid(tabs_data(vec![tab("t", None)]), &id));
    assert!(on_time.is_ok());
    std::thread::sleep(SHORT + Duration::from_millis(60));
    assert_eq!(call.await, Err(TIMED_OUT));
}

#[tokio::test]
async fn the_bridge_itself_refuses_data_collected_after_its_deadline() {
    // Without the tool's outer deadline around it: `request` alone decides.
    let e = Env::new(SHORT);
    let ids = capture_id(&e);
    let deadline = e.registry.bridge.deadline();
    let registry = e.registry.clone();
    let mut call = Box::pin(async move {
        registry
            .bridge
            .request(&registry.window, Kind::Tabs, deadline)
            .await
    });
    assert!(poll_once(&mut call).is_pending());
    let id = ids.lock().unwrap()[0].clone();
    assert!(e
        .registry
        .bridge
        .respond(true, valid(tabs_data(vec![]), &id))
        .is_ok());
    std::thread::sleep(SHORT + Duration::from_millis(60));
    assert_eq!(call.await, Err(TIMED_OUT));
}

#[tokio::test]
async fn the_work_after_the_answer_is_inside_the_deadline_and_a_consumed_id_errors() {
    let e = Env::new(SHORT);
    // The webview answers at once, but another thread holds the roots lock
    // (the work after the answer cannot finish): the request still ends at
    // the deadline.
    e.serve(|_| tabs_data(vec![]));
    let (locked, wait) = std::sync::mpsc::channel();
    let registry = e.registry.clone();
    let holder = std::thread::spawn(move || {
        let _held = registry.roots.write().unwrap();
        locked.send(()).unwrap();
        std::thread::sleep(SHORT * 5);
    });
    wait.recv().unwrap();
    let started = Instant::now();
    let registry = e.registry.clone();
    let call = tokio::spawn(async move { registry.state("list_open_tabs", Value::Null).await });
    assert_eq!(call.await.unwrap(), Err(TIMED_OUT));
    assert!(started.elapsed() < SHORT * 4, "{:?}", started.elapsed());
    holder.join().unwrap();
    // An id that was already consumed errors.
    let ids = capture_id(&e);
    let registry = e.registry.clone();
    let call = tokio::spawn(async move { registry.state("list_open_tabs", Value::Null).await });
    while ids.lock().unwrap().is_empty() {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    let id = ids.lock().unwrap()[0].clone();
    assert!(e
        .registry
        .bridge
        .respond(true, valid(tabs_data(vec![]), &id))
        .is_ok());
    assert_eq!(
        e.registry
            .bridge
            .respond(true, valid(tabs_data(vec![]), &id)),
        Err(REFUSED)
    );
    assert!(call.await.unwrap().is_ok());
}

// ---- F7: objects only, with the exact keys ---------------------------------

#[tokio::test]
async fn positional_sequences_and_null_for_forbidden_keys_are_refused() {
    let tab_row = json!(["a", "t", null, true, false]);
    let cases: Vec<(&str, &str, Value)> = vec![
        ("list_open_tabs", "panes as a sequence", json!([[]])),
        (
            "list_open_tabs",
            "a pane as a sequence",
            json!({"panes": [[0, true, []]]}),
        ),
        (
            "list_open_tabs",
            "a tab as a sequence",
            json!({"panes": [{"index": 0, "active": true, "tabs": [tab_row]}]}),
        ),
        (
            "get_active_document",
            "wrapper as a sequence",
            json!([null]),
        ),
        (
            "get_active_document",
            "document as a sequence",
            json!({"document": ["a", "t", null, false, "md", "x"]}),
        ),
        ("get_selection", "wrapper as a sequence", json!([null])),
        (
            "get_selection",
            "selection as a sequence",
            json!({"selection": ["editor", "a", "x", 0, 1]}),
        ),
        (
            "get_selection",
            "a preview selection with offsets",
            json!({"selection": {"source": "preview", "tabId": "a", "documentText": "x", "text": "x", "start": null}}),
        ),
        (
            "get_selection",
            "an editor selection with the preview key",
            json!({"selection": {"source": "editor", "tabId": "a", "documentText": "x", "start": 0, "end": 1, "text": null}}),
        ),
        (
            "get_selection",
            "an editor selection missing end",
            json!({"selection": {"source": "editor", "tabId": "a", "documentText": "x", "start": 0}}),
        ),
    ];
    for (tool, why, data) in cases {
        let e = Env::new(SHORT);
        e.serve(move |_| data.clone());
        assert_eq!(e.call(tool).await, Err("invalid response"), "{why}");
    }
    // The envelope: a forbidden key is refused even as `null`.
    for (envelope, why) in [
        (
            json!({"ok": true, "data": {"panes": []}, "error": null}),
            "ok with error null",
        ),
        (
            json!({"ok": false, "error": "unavailable", "data": null}),
            "error with data null",
        ),
        (json!({"ok": true, "data": null}), "ok with data null"),
        (json!({"ok": true, "data": [] }), "data is a sequence"),
    ] {
        let e = Env::new(SHORT);
        let envelope2 = envelope.clone();
        e.fake.on_emit(move |registry, event, payload| {
            if event == "mcp-state-request" {
                let mut response = envelope2.clone();
                response["id"] = payload["id"].clone();
                assert!(registry.bridge.respond(true, response).is_ok());
            }
        });
        assert_eq!(
            e.call("list_open_tabs").await,
            Err("invalid response"),
            "{why}"
        );
    }
    // A sequence for the whole envelope has no id to look up: refused outright.
    let e = Env::new(SHORT);
    assert_eq!(
        e.registry
            .bridge
            .respond(true, json!(["id", true, {"panes": []}])),
        Err(REFUSED)
    );
    // Control: the same data as exact objects is accepted.
    e.serve(|_| tabs_data(vec![tab("a", None)]));
    assert!(e.call("list_open_tabs").await.is_ok());
}

// ---- F8: network namespaces are classified before the filesystem is asked --

#[test]
fn a_network_namespace_path_is_outside_before_any_canonicalize() {
    let e = Env::new(SHORT);
    let inside = e.write(&e.root, "n.md", "n");
    let roots = e.registry.roots_snapshot().unwrap();
    assert!(matches!(
        roots.locate(&inside.to_string_lossy()),
        Location::Inside { .. }
    ));
    // On this host a leading double slash resolves (canonicalize alone would
    // say "inside"); the textual guard must say "outside" first, and nothing
    // but the name comes out.
    for prefixed in [
        format!("/{}", inside.display()),
        format!("//{}", inside.display()),
    ] {
        match roots.locate(&prefixed) {
            Location::Outside { name } => assert_eq!(name, "n.md", "{prefixed}"),
            Location::Inside { .. } => panic!("{prefixed} was classified by the filesystem"),
        }
    }
    for hostile in [
        "//server/share/x.md",
        r"\\server\share\x.md",
        r"\\?\UNC\server\share\x.md",
        r"\\.\pipe\x",
        "//?/UNC/server/share/x.md",
    ] {
        assert!(
            matches!(roots.locate(hostile), Location::Outside { .. }),
            "{hostile}"
        );
    }
    // A root registered in a network namespace is dropped before it is resolved.
    let roots = Roots::from_pairs(vec![
        (
            "net".into(),
            PathBuf::from(format!("//{}", e.root.display())),
        ),
        ("ok".into(), e.root.clone()),
    ]);
    assert_eq!(roots.0.len(), 1);
    assert_eq!(roots.0[0].0, "ok");
}

// ---- round 4, F2 / round 5, F1: a document is masked whole, up to the limit ------------------------------

/// `-----BEGIN PRIVATE KEY-----`, body lines, `-----END ...-----`, then plain
/// filler up to exactly `total` bytes.
fn pem_document(body_bytes: usize, total: usize) -> (String, usize) {
    let head = "-----BEGIN PRIVATE KEY-----\n";
    let tail = "-----END PRIVATE KEY-----\n";
    let mut doc = String::with_capacity(total);
    doc.push_str(head);
    doc.push_str(&format!("{}\n", "A".repeat(63)).repeat(body_bytes / 64));
    doc.push_str(tail);
    let filler = total - doc.len();
    doc.push_str(&"f".repeat(filler - 1));
    doc.push('\n');
    assert_eq!(doc.len(), total);
    (doc, head.len())
}

#[tokio::test]
async fn a_secret_that_starts_before_the_old_window_still_hides_the_selection() {
    let e = Env::new(Duration::from_secs(30));
    // The key starts at byte 0; the selection is ~600 KiB into its body, past
    // the 512 KiB a window would have reached back. A document up to the limit
    // is masked whole, so the key hides it.
    let (doc, head) = pem_document(700 * 1024, DOCUMENT_LIMIT);
    assert_eq!(doc.len(), DOCUMENT_LIMIT);
    let from = head + 64 * 9600;
    assert!(from > 512 * 1024);
    let value = selected(&e, &doc, from, from + 63).await;
    assert_eq!(value["selection"]["text"], "[secret]");
    // Control: text after the key's END is not hidden by it.
    let end = doc.len() - 1;
    let value = selected(&e, &doc, end - 20, end).await;
    assert_eq!(value["selection"]["text"], "f".repeat(20));
}

#[tokio::test]
async fn a_document_one_byte_over_the_limit_has_no_selection_and_is_not_copied() {
    let e = Env::new(Duration::from_secs(30));
    let file = e.write(&e.root, "s.md", "");
    // [boundary] Exactly at the limit: read out. One byte over: unavailable,
    // for an editor and for a preview selection, with the same bytes selected.
    let (doc, head) = pem_document(700 * 1024, DOCUMENT_LIMIT + 1);
    assert_eq!(doc.len(), DOCUMENT_LIMIT + 1);
    let from = head + 64 * 9600;
    for data in [
        selection_of(&doc, from, from + 63),
        preview_of(&doc, &doc[from..from + 63]),
    ] {
        let (f, d) = (file.clone(), data);
        e.serve(move |kind| match kind {
            "selection" => d.clone(),
            _ => tabs_data(vec![tab("t1", Some(&f))]),
        });
        assert_eq!(e.call("get_selection").await, Err(UNAVAILABLE));
    }
    // The parser keeps no copy of such a document, only the fact that it was big.
    let parsed = parse_selection(selection_of(&doc, from, from + 63))
        .unwrap()
        .unwrap();
    assert!(parsed.oversized && parsed.document.is_empty());
    let parsed = parse_selection(selection_of(&doc[..DOCUMENT_LIMIT], 0, 1))
        .unwrap()
        .unwrap();
    assert!(!parsed.oversized && parsed.document.len() == DOCUMENT_LIMIT);
    // A file outside the open workspaces is still named, not "unavailable".
    std::fs::create_dir_all(e.elsewhere()).unwrap();
    let outside = e.write(&e.elsewhere(), "outside-big.md", "");
    let data = selection_of(&doc, from, from + 63);
    e.serve(move |kind| match kind {
        "selection" => data.clone(),
        _ => tabs_data(vec![tab("t1", Some(&outside))]),
    });
    let value = e.call("get_selection").await.unwrap();
    assert_eq!(value["selection"]["file"]["outsideRoots"], true);
    assert!(value["selection"].get("text").is_none());
}

#[test]
fn the_masking_itself_refuses_a_document_over_the_limit() {
    // Defence in depth under `selection_json`: each pick refuses on its own.
    let doc = "a".repeat(DOCUMENT_LIMIT + 1);
    let editor = Pick::Offsets { start: 0, end: 4 };
    let preview = Pick::Text("aaaa".into());
    assert_eq!(masked_selection(true, &doc, &editor), Err(UNAVAILABLE));
    assert_eq!(masked_selection(true, &doc, &preview), Err(UNAVAILABLE));
    // Control: the same picks at the limit are read out (the preview text
    // appears once, so the source is unambiguous).
    let doc = format!("{}b", "a".repeat(DOCUMENT_LIMIT - 1));
    assert_eq!(
        masked_selection(true, &doc, &editor),
        Ok(Some(("aaaa".into(), false)))
    );
    let once = Pick::Text("ab".into());
    assert_eq!(
        masked_selection(true, &doc, &once),
        Ok(Some(("ab".into(), false)))
    );
}

#[tokio::test]
async fn a_sixteen_mib_payload_is_accepted_but_not_read_out_and_one_more_byte_is_invalid() {
    let e = Env::new(Duration::from_secs(120));
    let (doc, head) = pem_document(15 * 1024 * 1024, MAX_SELECTION_DOCUMENT);
    let from = head + 64 * 235_000;
    let file = e.write(&e.root, "s.md", "");
    let (f, data) = (file.clone(), selection_of(&doc, from, from + 63));
    e.serve(move |kind| match kind {
        "selection" => data.clone(),
        _ => tabs_data(vec![tab("t1", Some(&f))]),
    });
    // Valid payload, not read out: no masking pass over 16 MiB, no text.
    assert_eq!(e.call("get_selection").await, Err(UNAVAILABLE));
    // One byte more is refused whole, before anything else.
    let too_big = format!("{doc}x");
    let data = selection_of(&too_big, 0, 1);
    e.serve(move |kind| match kind {
        "selection" => data.clone(),
        _ => tabs_data(vec![tab("t1", Some(&file))]),
    });
    assert_eq!(e.call("get_selection").await, Err(INVALID_RESPONSE));
}

// ---- round 4, F3: blocking work counts until it ends ---------------------------

#[tokio::test]
async fn timed_out_work_still_counts_until_it_has_finished() {
    let e = Env::new(SHORT);
    e.serve(|_| tabs_data(vec![]));
    // Every worker waits on the roots lock, which another thread holds: none of
    // them can finish, and every request ends at its deadline.
    let (locked, wait) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel::<()>();
    let registry = e.registry.clone();
    let holder = std::thread::spawn(move || {
        let _held = registry.roots.write().unwrap();
        locked.send(()).unwrap();
        released.recv().unwrap();
    });
    wait.recv().unwrap();
    let calls: Vec<_> = (0..MAX_PENDING)
        .map(|_| {
            let registry = e.registry.clone();
            tokio::spawn(async move { registry.state("list_open_tabs", Value::Null).await })
        })
        .collect();
    for call in calls {
        assert_eq!(call.await.unwrap(), Err(TIMED_OUT));
    }
    // Nobody is waiting for the webview any more, but sixteen workers still run:
    // the next request is refused instead of starting a seventeenth.
    assert_eq!(e.pending(), 0);
    assert_eq!(e.registry.work.busy(), MAX_PENDING);
    assert_eq!(e.call("list_open_tabs").await, Err(BUSY));
    // Control: when the workers finish the slots come back.
    release.send(()).unwrap();
    holder.join().unwrap();
    for _ in 0..500 {
        if e.registry.work.busy() == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(e.registry.work.busy(), 0);
    assert!(e.call("list_open_tabs").await.is_ok());
}

#[tokio::test]
async fn work_that_starts_after_the_deadline_does_nothing() {
    let work = Work::default();
    let slot = work.admit().unwrap();
    let ran = Arc::new(AtomicBool::new(false));
    let flag = ran.clone();
    let late = blocking(&slot, Instant::now() - Duration::from_secs(1), move || {
        flag.store(true, Ordering::SeqCst);
        Ok(())
    })
    .await;
    assert_eq!(late, Err(TIMED_OUT));
    assert!(!ran.load(Ordering::SeqCst));
    // Control: inside the deadline it runs.
    let flag = ran.clone();
    let on_time = blocking(&slot, Instant::now() + Duration::from_secs(5), move || {
        flag.store(true, Ordering::SeqCst);
        Ok(())
    })
    .await;
    assert_eq!(on_time, Ok(()));
    assert!(ran.load(Ordering::SeqCst));
    // The slot of the request is freed only when its last share is.
    drop(slot);
    assert_eq!(work.busy(), 0);
}

#[test]
fn resolving_many_tabs_stops_between_tabs_past_the_deadline() {
    let e = Env::new(SHORT);
    let roots = e.registry.roots_snapshot().unwrap();
    let file = e.write(&e.root, "a.md", "");
    let data = parse_tabs(&tabs_data(vec![
        tab("a", Some(&file)),
        tab("b", Some(&file)),
    ]))
    .unwrap();
    let ids = TabIds::default();
    let past = Instant::now() - Duration::from_secs(1);
    assert_eq!(
        tabs_json(true, &roots, &ids, &data, past).err(),
        Some(TIMED_OUT)
    );
    assert!(tabs_json(
        true,
        &roots,
        &ids,
        &data,
        Instant::now() + Duration::from_secs(5)
    )
    .is_ok());
}

#[test]
fn registering_roots_asks_the_filesystem_nothing() {
    // Building the roots runs while the registry's read lock is held: a root
    // that is not on disk is kept as registered (nothing is canonicalized),
    // and a path under it fails later, at the handle walk.
    let e = Env::new(SHORT);
    let missing = e.root.join("not-there");
    let roots = Roots::from_pairs(vec![("m".into(), missing.clone())]);
    assert_eq!(roots.0.len(), 1);
    assert!(matches!(
        roots.locate(&missing.join("a.md").to_string_lossy()),
        Location::Outside { .. }
    ));
}

// ---- round 4, F4: spelling first, then handles ---------------------------------

#[cfg(unix)]
#[test]
fn a_path_outside_the_roots_is_never_resolved_into_one() {
    let e = Env::new(SHORT);
    let inside = e.write(&e.root, "real.md", "x");
    // A link outside every root that points into one: canonicalizing it first
    // would say "inside"; its spelling says "outside", and that is the answer.
    let link = e.elsewhere().join("into.md");
    std::os::unix::fs::symlink(&inside, &link).unwrap();
    let roots = e.registry.roots_snapshot().unwrap();
    match roots.locate(&link.to_string_lossy()) {
        Location::Outside { name } => assert_eq!(name, "into.md"),
        Location::Inside { .. } => panic!("resolved before the spelling was checked"),
    }
    // Control: the target itself, spelled inside.
    assert!(matches!(
        roots.locate(&inside.to_string_lossy()),
        Location::Inside { .. }
    ));
}

#[cfg(unix)]
#[test]
fn a_root_opened_through_a_symlink_is_not_walked_through_it() {
    let e = Env::new(SHORT);
    let file = e.write(&e.root, "a.md", "x");
    let alias = e.parent.path().canonicalize().unwrap().join("alias");
    std::os::unix::fs::symlink(&e.root, &alias).unwrap();
    // Same disk tools rule: a root whose own path has a symlink in it does
    // not open, so nothing under it counts as inside.
    let roots = Roots::from_pairs(vec![("a".into(), alias.clone())]);
    assert!(matches!(
        roots.locate(&alias.join("a.md").to_string_lossy()),
        Location::Outside { .. }
    ));
    // Control: the real path of the same root.
    let roots = Roots::from_pairs(vec![("r".into(), e.root.clone())]);
    assert!(matches!(
        roots.locate(&file.to_string_lossy()),
        Location::Inside { .. }
    ));
}

#[cfg(unix)]
#[test]
fn a_new_file_needs_a_folder_that_resolves_by_handles() {
    let e = Env::new(SHORT);
    std::fs::create_dir(e.root.join("sub")).unwrap();
    std::os::unix::fs::symlink(e.elsewhere(), e.root.join("out")).unwrap();
    let roots = e.registry.roots_snapshot().unwrap();
    let new = |relative: &str| roots.locate(&e.root.join(relative).to_string_lossy());
    // Not saved yet, in a real folder: inside (as before).
    assert!(matches!(new("sub/draft.md"), Location::Inside { .. }));
    assert!(matches!(new("draft.md"), Location::Inside { .. }));
    // Not saved yet, in a folder that is a link out, or that does not exist.
    assert!(matches!(new("out/draft.md"), Location::Outside { .. }));
    assert!(matches!(new("nope/draft.md"), Location::Outside { .. }));
    // A dangling link is not "a file that is not there yet".
    std::os::unix::fs::symlink(e.root.join("gone"), e.root.join("dangling.md")).unwrap();
    assert!(matches!(new("dangling.md"), Location::Outside { .. }));
    // The root itself is not a file.
    assert!(matches!(
        roots.locate(&e.root.to_string_lossy()),
        Location::Outside { .. }
    ));
}
