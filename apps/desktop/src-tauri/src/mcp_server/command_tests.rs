//! The Tauri commands, through the real IPC layer of a mock app: only the
//! window labelled `main` may use them.
use super::*;
use crate::mcp_server::testkit::Fake;
use serde_json::json;
use std::sync::Mutex;

fn local_ipc_origin() -> tauri::Url {
    if cfg!(windows) || cfg!(target_os = "android") {
        "http://tauri.localhost".parse().unwrap()
    } else {
        "tauri://localhost".parse().unwrap()
    }
}
fn invoke(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    cmd: &str,
    body: Value,
) -> Result<tauri::ipc::InvokeResponseBody, Value> {
    tauri::test::get_ipc_response(
        window,
        tauri::webview::InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: local_ipc_origin(),
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
    )
}

#[test]
fn the_new_commands_answer_only_to_main() {
    let directory = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
    let registry = Arc::new(Registry::default());
    registry.configure(directory.path());
    let fake = Fake::attach(&registry);
    let confirm = crate::mcp_server::testkit::FakeConfirm::attach(&registry, true);
    let app = tauri::test::mock_builder()
        .manage(registry.clone())
        .invoke_handler(tauri::generate_handler![
            super::state::mcp_state_respond,
            super::approval::mcp_approval_respond,
            super::settings::mcp_server_get_settings,
            super::settings::mcp_server_set_settings,
        ])
        .build(crate::tauri_context())
        .unwrap();
    let other = tauri::WebviewWindowBuilder::new(&app, "other", Default::default())
        .build()
        .unwrap();
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    // Settings: another window can neither read nor change them.
    assert!(invoke(&other, "mcp_server_get_settings", json!({})).is_err());
    let refused = invoke(
        &other,
        "mcp_server_set_settings",
        json!({"settings": {"maskSecrets": false}}),
    );
    assert_eq!(
        refused.unwrap_err(),
        json!("Could not update MCP server settings")
    );
    assert!(registry.policy.mask());
    assert!(!directory.path().join(settings::FILE_NAME).exists());
    assert_eq!(
        confirm.shown(),
        0,
        "another window never reaches the dialog"
    );
    // Main reads the default, changes it, and the file and the state agree.
    let got = invoke(&main, "mcp_server_get_settings", json!({})).unwrap();
    assert_eq!(
        got.deserialize::<Value>().unwrap(),
        json!({"maskSecrets": true})
    );
    invoke(
        &main,
        "mcp_server_set_settings",
        json!({"settings": {"maskSecrets": false}}),
    )
    .unwrap();
    assert_eq!(
        confirm.shown(),
        1,
        "turning masking off asked the user once"
    );
    assert!(!registry.policy.mask());
    assert!(!settings::load(&directory.path().join(settings::FILE_NAME)).mask_secrets);
    let got = invoke(&main, "mcp_server_get_settings", json!({})).unwrap();
    assert_eq!(
        got.deserialize::<Value>().unwrap(),
        json!({"maskSecrets": false})
    );
    // A malformed argument changes nothing.
    for bad in [
        json!({"settings": {"maskSecrets": "no"}}),
        json!({"settings": {}}),
        json!({"settings": {"maskSecrets": true, "x": 1}}),
    ] {
        assert!(invoke(&main, "mcp_server_set_settings", bad).is_err());
    }
    assert!(!registry.policy.mask());
    // State answers: wrong window refused, main accepted for a waiting id.
    let registry2 = registry.clone();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let call = runtime.spawn(async move { registry2.state("list_open_tabs", Value::Null).await });
    let id = loop {
        if let Some(request) = fake.named("mcp-state-request").first() {
            break request["id"].clone();
        }
        std::thread::sleep(Duration::from_millis(1));
    };
    let answer = json!({"response": {"id": id, "ok": true, "data": {"panes": []}}});
    assert!(invoke(&other, "mcp_state_respond", answer.clone()).is_err());
    invoke(&main, "mcp_state_respond", answer.clone()).unwrap();
    assert!(runtime.block_on(call).unwrap().is_ok());
    assert!(
        invoke(&main, "mcp_state_respond", answer).is_err(),
        "repeated"
    );
    // Approvals: same rule.
    let registry3 = registry.clone();
    let approval = runtime.spawn(async move {
        registry3
            .approvals
            .request(&registry3.window, "op", "target", "summary")
            .await
    });
    let id = loop {
        if let Some(request) = fake.named("mcp-approval-request").first() {
            break request["id"].clone();
        }
        std::thread::sleep(Duration::from_millis(1));
    };
    let answer = json!({"response": {"id": id, "approved": true}});
    assert!(invoke(&other, "mcp_approval_respond", answer.clone()).is_err());
    invoke(&main, "mcp_approval_respond", answer.clone()).unwrap();
    assert_eq!(
        runtime.block_on(approval).unwrap(),
        approval::Decision::Approved
    );
    assert!(
        invoke(&main, "mcp_approval_respond", answer).is_err(),
        "repeated"
    );
}

#[test]
fn events_reach_the_main_window_and_no_other() {
    use tauri::Listener;
    let app = tauri::test::mock_builder()
        .build(crate::tauri_context())
        .unwrap();
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let other = tauri::WebviewWindowBuilder::new(&app, "other", Default::default())
        .build()
        .unwrap();
    let seen: Arc<Mutex<Vec<&'static str>>> = Arc::default();
    for (window, name) in [(&main, "main"), (&other, "other")] {
        let seen = seen.clone();
        window.listen("mcp-state-request", move |_| {
            seen.lock().unwrap().push(name)
        });
    }
    let emitter = window::tauri_main(app.handle().clone());
    assert!(emitter.emit("mcp-state-request", json!({"id": "x", "kind": "tabs"})));
    assert_eq!(*seen.lock().unwrap(), ["main"]);
    // Without a `main` window there is nowhere to send it.
    let bare = tauri::test::mock_builder()
        .build(crate::tauri_context())
        .unwrap();
    tauri::WebviewWindowBuilder::new(&bare, "other", Default::default())
        .build()
        .unwrap();
    assert!(!window::tauri_main(bare.handle().clone()).emit("mcp-state-request", json!({})));
}

fn settings_window(registry: &Arc<Registry>) -> tauri::WebviewWindow<tauri::test::MockRuntime> {
    let app = tauri::test::mock_builder()
        .manage(registry.clone())
        .invoke_handler(tauri::generate_handler![
            super::settings::mcp_server_set_settings,
        ])
        .build(crate::tauri_context())
        .unwrap();
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    // The window keeps working only while the app lives.
    std::mem::forget(app);
    main
}

#[test]
fn a_no_in_the_native_dialog_is_a_distinct_result_and_pauses_the_question() {
    let directory = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
    let registry = Arc::new(Registry::default());
    registry.configure(directory.path());
    let confirm = crate::mcp_server::testkit::FakeConfirm::attach(&registry, false);
    let main = settings_window(&registry);
    let off = json!({"settings": {"maskSecrets": false}});
    let on = json!({"settings": {"maskSecrets": true}});
    // The user declines: not the generic error, and nothing changes.
    assert_eq!(
        invoke(&main, "mcp_server_set_settings", off.clone()).unwrap_err(),
        json!(settings::DECLINED)
    );
    assert_ne!(settings::DECLINED, "Could not update MCP server settings");
    assert!(registry.policy.mask());
    assert!(!directory.path().join(settings::FILE_NAME).exists());
    assert_eq!(confirm.shown(), 1);
    // A looping page: every further request answers the same, with no dialog,
    // even if the user would now say yes, and a reload changes nothing.
    confirm
        .answer
        .store(true, std::sync::atomic::Ordering::SeqCst);
    for _ in 0..5 {
        assert_eq!(
            invoke(&main, "mcp_server_set_settings", off.clone()).unwrap_err(),
            json!(settings::DECLINED)
        );
        registry.page_reloading();
    }
    assert_eq!(confirm.shown(), 1);
    assert!(registry.policy.mask());
    // Turning masking on is never blocked.
    invoke(&main, "mcp_server_set_settings", on).unwrap();
}

#[test]
fn the_ipc_command_turns_masking_off_only_when_the_native_dialog_says_yes() {
    let directory = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
    let registry = Arc::new(Registry::default());
    registry.configure(directory.path());
    let confirm = crate::mcp_server::testkit::FakeConfirm::attach(&registry, true);
    let main = settings_window(&registry);
    let off = json!({"settings": {"maskSecrets": false}});
    let on = json!({"settings": {"maskSecrets": true}});
    invoke(&main, "mcp_server_set_settings", off).unwrap();
    assert!(!registry.policy.mask());
    assert_eq!(confirm.shown(), 1);
    // Back on: no dialog.
    invoke(&main, "mcp_server_set_settings", on).unwrap();
    assert!(registry.policy.mask());
    assert_eq!(confirm.shown(), 1);
}
