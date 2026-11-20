use super::*;
use tokio::io::{AsyncWriteExt, BufReader};

#[tokio::test]
async fn framing_rejects_unterminated_and_oversized_lines() {
    let mut valid = &b"{}\n"[..];
    assert_eq!(read_frame(&mut valid).await.unwrap(), b"{}");
    let mut partial = &b"{}"[..];
    assert!(read_frame(&mut partial).await.is_err());
    let bytes = [vec![b'x'; MAX_FRAME + 1], vec![b'\n']].concat();
    assert!(read_frame(&mut bytes.as_slice()).await.is_err());
    let boundary = [vec![b'x'; MAX_FRAME], vec![b'\n']].concat();
    assert_eq!(
        read_frame(&mut boundary.as_slice()).await.unwrap().len(),
        MAX_FRAME
    );
}

#[tokio::test]
async fn timeout_covers_a_line_without_newline() {
    let (mut sender, receiver) = tokio::io::duplex(128);
    sender.write_all(b"{").await.unwrap();
    let result = tokio::time::timeout(
        Duration::from_millis(250),
        timed_frame(&mut BufReader::new(receiver), Duration::from_millis(20)),
    )
    .await
    .expect("frame deadline must fire before outer watchdog");
    assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
}

#[test]
fn identity_never_crosses_builds() {
    assert_ne!(build_identity(true), build_identity(false));
    assert_eq!(build_identity(true), "app.markdraw-dev");
    assert_eq!(build_identity(false), "app.markdraw");
}

#[test]
fn registry_is_atomic_and_ids_are_session_local() {
    let registry = Registry::default();
    let root = RootInput {
        name: "notes".into(),
        path: std::env::current_dir().unwrap(),
    };
    registry.replace(vec![root.clone()]).unwrap();
    let first = registry.list().unwrap();
    registry.replace(vec![root.clone()]).unwrap();
    assert_eq!(registry.list().unwrap(), first);
    let other = Registry::default();
    other.replace(vec![root]).unwrap();
    assert_ne!(other.list().unwrap(), first);
    registry.replace(vec![]).unwrap();
    assert_eq!(registry.list().unwrap(), serde_json::json!({"roots":[]}));
    assert!(!first.to_string().contains(
        &std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string()
    ));
    // Reject the entire replacement rather than partially authorizing it.
    assert!(registry
        .replace(vec![RootInput {
            name: "bad".into(),
            path: "relative".into()
        }])
        .is_err());
    assert_eq!(registry.list().unwrap(), serde_json::json!({"roots":[]}));
}

/// The origin Tauri treats as the app's own for IPC: `tauri://localhost`, or
/// `http://tauri.localhost` where wry serves the custom protocol over HTTP
/// (Windows and Android), as `tauri::manager` pins in its own tests.
fn local_ipc_origin() -> tauri::Url {
    if cfg!(windows) || cfg!(target_os = "android") {
        "http://tauri.localhost".parse().unwrap()
    } else {
        "tauri://localhost".parse().unwrap()
    }
}

#[cfg(unix)]
fn fixture() -> tempfile::TempDir {
    // Honors TMPDIR when set, else the system temp dir (CI).
    use std::os::unix::fs::PermissionsExt;
    let fixture = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
    std::fs::set_permissions(fixture.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    fixture
}

#[cfg(unix)]
#[tokio::test]
async fn permissions_symlinks_live_owner_and_orphan_cleanup() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let fixture = fixture();
    let directory = fixture.path().join("endpoint");
    let registry = Arc::new(Registry::default());
    let endpoint = platform::Endpoint::start(&directory, registry.clone()).unwrap();
    assert_eq!(
        std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::metadata(directory.join("token"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(directory.join("ipc.sock"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let original = std::fs::read(directory.join("token")).unwrap();
    assert!(platform::Endpoint::start(&directory, registry.clone()).is_err());
    assert_eq!(std::fs::read(directory.join("token")).unwrap(), original);
    drop(endpoint);
    assert!(!directory.join("token").exists());
    assert!(!directory.join("ipc.sock").exists());
    // A dead listener with secure artifacts is reclaimed; a live listener is not.
    let old = std::os::unix::net::UnixListener::bind(directory.join("ipc.sock")).unwrap();
    std::fs::set_permissions(
        directory.join("ipc.sock"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    std::fs::write(directory.join("token"), "a".repeat(64)).unwrap();
    std::fs::set_permissions(
        directory.join("token"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert!(platform::Endpoint::start(&directory, registry.clone()).is_err());
    drop(old);
    let next = platform::Endpoint::start(&directory, registry.clone()).unwrap();
    assert_ne!(std::fs::read(directory.join("token")).unwrap(), original);
    std::fs::set_permissions(
        directory.join("token"),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert!(platform::connect(&directory).await.is_err());
    std::fs::set_permissions(
        directory.join("token"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert!(platform::connect(&directory).await.is_ok());
    std::fs::set_permissions(
        directory.join("ipc.sock"),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert!(platform::connect(&directory).await.is_err());
    std::fs::set_permissions(
        directory.join("ipc.sock"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert!(platform::connect(&directory).await.is_ok());
    drop(next);
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(platform::Endpoint::start(&directory, registry.clone()).is_err());
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    let link = fixture.path().join("link");
    symlink(&directory, &link).unwrap();
    assert!(platform::Endpoint::start(&link, registry.clone()).is_err());
    symlink(fixture.path().join("victim"), directory.join("ipc.sock")).unwrap();
    assert!(platform::Endpoint::start(&directory, registry.clone()).is_err());
    std::fs::remove_file(directory.join("ipc.sock")).unwrap();
    symlink(fixture.path().join("victim"), directory.join("token")).unwrap();
    assert!(platform::Endpoint::start(&directory, registry).is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn authentication_invalid_json_repeated_ids_and_limits() {
    let fixture = fixture();
    let directory = fixture.path().join("endpoint");
    let _endpoint = platform::Endpoint::start(&directory, Arc::new(Registry::default())).unwrap();
    for auth in [
        serde_json::json!({"id":0}),
        serde_json::json!({"id":0,"token":"wrong"}),
        serde_json::json!({"id":0,"method":"list_workspaces"}),
    ] {
        let (stream, _) = platform::connect(&directory).await.unwrap();
        let mut stream = BufReader::new(stream);
        send(&mut stream, &auth).await.unwrap();
        assert!(timed_frame(&mut stream, REQUEST_TIMEOUT).await.is_err());
    }
    let (stream, token) = platform::connect(&directory).await.unwrap();
    let mut stream = BufReader::new(stream);
    send(&mut stream, &serde_json::json!({"id":0,"token":token}))
        .await
        .unwrap();
    let _: Response = receive(&mut stream).await.unwrap();
    send(
        &mut stream,
        &serde_json::json!({"id":1,"method":"list_workspaces"}),
    )
    .await
    .unwrap();
    let response: Response = receive(&mut stream).await.unwrap();
    assert_eq!(response.id, 1);
    assert_eq!(response.result.unwrap(), serde_json::json!({"roots":[]}));
    send(
        &mut stream,
        &serde_json::json!({"id":1,"method":"list_workspaces"}),
    )
    .await
    .unwrap();
    assert!(receive::<_, Response>(&mut stream).await.is_err());
    for bytes in [b"invalid\n".to_vec(), vec![b'x'; MAX_FRAME + 2]] {
        let (mut stream, _) = platform::connect(&directory).await.unwrap();
        // The server may close as soon as the size bound is reached.
        let _ = stream.write_all(&bytes).await;
        assert!(timed_frame(&mut BufReader::new(stream), REQUEST_TIMEOUT)
            .await
            .is_err());
    }
}

#[cfg(unix)]
#[tokio::test]
async fn real_rmcp_client_lists_calls_observes_close_and_eof() {
    use rmcp::model::CallToolRequestParams;
    let fixture = fixture();
    let directory = fixture.path().join("endpoint");
    let registry = Arc::new(Registry::default());
    registry
        .replace(vec![RootInput {
            name: "notes".into(),
            path: fixture.path().to_path_buf(),
        }])
        .unwrap();
    let endpoint = platform::Endpoint::start(&directory, registry.clone()).unwrap();
    let (client_transport, server_transport) = tokio::io::duplex(8192);
    let proxy = Proxy::new(directory.clone());
    let server = tokio::spawn(async move {
        let service = proxy.serve(server_transport).await.unwrap();
        service.waiting().await.unwrap()
    });
    let client = ().serve(client_transport).await.unwrap();
    let tools = client.list_all_tools().await.unwrap();
    assert_eq!(tools.len(), 7);
    assert_eq!(tools[0].name, "list_workspaces");
    let result = client
        .call_tool(CallToolRequestParams::new("list_workspaces"))
        .await
        .unwrap();
    let value = result.structured_content.unwrap();
    assert_eq!(value["roots"][0]["name"], "notes");
    assert_eq!(value["roots"][0]["id"].as_str().unwrap().len(), 64);
    assert!(!value
        .to_string()
        .contains(&fixture.path().to_string_lossy().to_string()));
    registry.replace(vec![]).unwrap();
    let result = client
        .call_tool(CallToolRequestParams::new("list_workspaces"))
        .await
        .unwrap();
    assert_eq!(
        result.structured_content.unwrap(),
        serde_json::json!({"roots":[]})
    );
    drop(endpoint);
    let error = client
        .call_tool(CallToolRequestParams::new("list_workspaces"))
        .await
        .unwrap_err();
    assert!(error.to_string().contains(NOT_RUNNING));
    client.cancel().await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .unwrap()
        .unwrap();
}

// rmcp 3.x dropped `CallToolRequestParams::task` (the server used to reject
// task-augmented calls) and added the MRTR retry fields. This server never
// issues an input-required result, so a call carrying them is invalid.
// F5 (declined): rmcp decodes `"requestState": null` / `"inputResponses": null`
// into `None`, the same value as an absent key, so the guard below cannot tell
// them apart. This pins that premise: if the SDK ever keeps the distinction
// (e.g. a tri-state field), this test fails and the guard must be revisited.
#[test]
fn mrtr_null_fields_decode_exactly_like_absent_ones() {
    use rmcp::model::CallToolRequestParams;
    let with_null: CallToolRequestParams = serde_json::from_value(serde_json::json!({
        "name": "list_workspaces",
        "requestState": null,
        "inputResponses": null,
    }))
    .unwrap();
    let absent: CallToolRequestParams =
        serde_json::from_value(serde_json::json!({ "name": "list_workspaces" })).unwrap();
    assert_eq!(with_null, absent);
    assert!(with_null.request_state.is_none() && with_null.input_responses.is_none());
    // Control: a present, non-null value IS visible to the guard.
    let present: CallToolRequestParams = serde_json::from_value(serde_json::json!({
        "name": "list_workspaces",
        "requestState": "opaque",
    }))
    .unwrap();
    assert!(present.request_state.is_some());
}

#[cfg(unix)]
#[tokio::test]
async fn mrtr_retry_fields_are_rejected_as_invalid_params() {
    use rmcp::model::CallToolRequestParams;
    let fixture = fixture();
    let directory = fixture.path().join("endpoint");
    let registry = Arc::new(Registry::default());
    let endpoint = platform::Endpoint::start(&directory, registry).unwrap();
    let (client_transport, server_transport) = tokio::io::duplex(8192);
    let proxy = Proxy::new(directory.clone());
    let server = tokio::spawn(async move {
        let service = proxy.serve(server_transport).await.unwrap();
        service.waiting().await.unwrap()
    });
    let client = ().serve(client_transport).await.unwrap();
    let mut with_state = CallToolRequestParams::new("list_workspaces");
    with_state.request_state = Some("opaque".into());
    let mut with_inputs = CallToolRequestParams::new("list_workspaces");
    with_inputs.input_responses = Some(Default::default());
    for params in [with_state, with_inputs] {
        let error = client.call_tool(params).await.unwrap_err().to_string();
        assert!(
            error.contains("Unknown tool or invalid arguments"),
            "{error}"
        );
    }
    // Control: the same tool without the retry fields still works.
    let ok = client
        .call_tool(CallToolRequestParams::new("list_workspaces"))
        .await
        .unwrap();
    assert_eq!(
        ok.structured_content.unwrap(),
        serde_json::json!({"roots":[]})
    );
    drop(endpoint);
    client.cancel().await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .unwrap()
        .unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn simultaneous_peers_are_bounded_without_blocking_authenticated_reads() {
    let fixture = fixture();
    let directory = fixture.path().join("endpoint");
    let _endpoint = platform::Endpoint::start(&directory, Arc::new(Registry::default())).unwrap();
    let mut peers = Vec::new();
    for _ in 0..MAX_CONNECTIONS {
        let (stream, token) = platform::connect(&directory).await.unwrap();
        let mut stream = BufReader::new(stream);
        send(&mut stream, &Auth { id: 0, token }).await.unwrap();
        let _: Response = receive(&mut stream).await.unwrap();
        peers.push(stream);
    }
    let (stream, _) = platform::connect(&directory).await.unwrap();
    assert!(tokio::time::timeout(
        Duration::from_millis(250),
        receive::<_, Response>(&mut BufReader::new(stream)),
    )
    .await
    .expect("excess peer must be rejected before its authentication deadline")
    .is_err());
    send(
        &mut peers[0],
        &Request {
            id: 1,
            method: "list_workspaces".into(),
            arguments: Value::Null,
        },
    )
    .await
    .unwrap();
    let response: Response = receive(&mut peers[0]).await.unwrap();
    assert_eq!(response.result.unwrap(), serde_json::json!({"roots":[]}));
}

#[test]
fn duplicate_root_labels_keep_distinct_opaque_ids() {
    let registry = Registry::default();
    // Absolute on both Unix and Windows, without accessing real workspaces.
    let base = std::env::current_dir().unwrap();
    let first = RootInput {
        name: "Root".into(),
        path: base.clone(),
    };
    let second = RootInput {
        name: "Root".into(),
        path: base.join("Root"),
    };
    registry.replace(vec![first, second.clone()]).unwrap();
    let listed = registry.list().unwrap();
    let roots = listed["roots"].as_array().unwrap();
    assert_eq!(roots.len(), 2);
    assert_eq!(roots[0]["name"], "Root");
    assert_eq!(roots[1]["name"], "Root");
    assert_ne!(roots[0]["id"], roots[1]["id"]);
    assert_eq!(roots[0]["id"].as_str().unwrap().len(), 64);
    assert_eq!(roots[1]["id"].as_str().unwrap().len(), 64);
    let kept_id = roots[1]["id"].clone();
    registry.replace(vec![second]).unwrap();
    assert_eq!(registry.list().unwrap()["roots"][0]["id"], kept_id);
    for name in ["", "/", "///", "\\", "bad\0name"] {
        assert!(registry
            .replace(vec![RootInput {
                name: name.into(),
                path: base.clone()
            }])
            .is_err());
        assert_eq!(registry.list().unwrap()["roots"][0]["id"], kept_id);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn sec_review_accepted_registry_must_fit_ipc_response() {
    let fixture = fixture();
    let registry = Arc::new(Registry::default());
    let roots = (0..256)
        .map(|n| RootInput {
            name: "n".repeat(200),
            path: fixture.path().join(n.to_string()),
        })
        .collect();
    registry
        .replace(roots)
        .expect("valid root count and filesystem-valid label lengths");
    let listed = registry.list().unwrap();
    println!(
        "accepted_roots={} serialized_result_bytes={} frame_limit={}",
        listed["roots"].as_array().unwrap().len(),
        serde_json::to_vec(&listed).unwrap().len(),
        MAX_FRAME
    );
    let directory = fixture.path().join("endpoint");
    let _endpoint = platform::Endpoint::start(&directory, registry).unwrap();
    let result = Proxy::new(directory).call().await;
    println!(
        "proxy_error_kind={:?}",
        result.as_ref().err().map(|error| error.kind())
    );
    assert!(result.is_ok(), "accepted registry must remain listable");
}

#[cfg(unix)]
#[tokio::test]
async fn sec_review_stale_session_deep_json_and_recovery() {
    let fixture = fixture();
    let directory = fixture.path().join("endpoint");
    let registry = Arc::new(Registry::default());
    let old = platform::Endpoint::start(&directory, registry.clone()).unwrap();
    let (_, stale) = platform::connect(&directory).await.unwrap();
    drop(old);
    let _endpoint = platform::Endpoint::start(&directory, registry).unwrap();
    let (stream, _) = platform::connect(&directory).await.unwrap();
    let mut stream = BufReader::new(stream);
    send(
        &mut stream,
        &Auth {
            id: 0,
            token: stale,
        },
    )
    .await
    .unwrap();
    assert!(receive::<_, Response>(&mut stream).await.is_err());
    let (mut stream, _) = platform::connect(&directory).await.unwrap();
    let deep = format!("{}0{}\n", "[".repeat(300), "]".repeat(300));
    stream.write_all(deep.as_bytes()).await.unwrap();
    assert!(receive::<_, Response>(&mut BufReader::new(stream))
        .await
        .is_err());
    assert_eq!(
        Proxy::new(directory).call().await.unwrap(),
        json!({"roots":[]})
    );
    println!("stale_session=rejected deep_json=rejected subsequent_read=ok");
}

#[cfg(unix)]
#[tokio::test]
async fn sec_review_bounds_and_planted_files() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = fixture();
    let registry = Arc::new(Registry::default());
    for name in ["endpoint", "ipc.sock", "token"] {
        let directory = fixture.path().join(format!("case-{name}"));
        let planted = if name == "endpoint" {
            directory.clone()
        } else {
            std::fs::create_dir(&directory).unwrap();
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
            directory.join(name)
        };
        std::fs::write(&planted, b"do not remove").unwrap();
        assert!(platform::Endpoint::start(&directory, registry.clone()).is_err());
        assert_eq!(std::fs::read(&planted).unwrap(), b"do not remove");
    }
    let base = fixture.path();
    assert!(registry
        .replace(
            (0..257)
                .map(|n| RootInput {
                    name: "n".into(),
                    path: base.join(n.to_string())
                })
                .collect()
        )
        .is_err());
    assert!(registry
        .replace(vec![RootInput {
            name: "n".repeat(513),
            path: base.into()
        }])
        .is_err());
    println!(
        "planted_directory_socket_token=preserved root_count_257=rejected name_bytes_513=rejected"
    );
}

#[test]
fn sec_review_tauri_command_respects_window_capability() {
    let registry = Arc::new(Registry::default());
    let app = tauri::test::mock_builder()
        .manage(registry.clone())
        .invoke_handler(tauri::generate_handler![crate::mcp_server::mcp_set_roots])
        .build(crate::tauri_context())
        .unwrap();
    let webview =
        tauri::WebviewWindowBuilder::new(&app, "sec-review-no-capability", Default::default())
            .build()
            .unwrap();
    let result = tauri::test::get_ipc_response(
        &webview,
        tauri::webview::InvokeRequest {
            cmd: "mcp_set_roots".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: local_ipc_origin(),
            body: tauri::ipc::InvokeBody::Json(
                json!({"roots":[{"name":"probe", "path":std::env::current_dir().unwrap()}]}),
            ),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
    );
    println!(
        "unprivileged_window_command_succeeded={} registry_root_count={}",
        result.is_ok(),
        registry.list().unwrap()["roots"].as_array().unwrap().len()
    );
    assert!(
        result.is_err(),
        "window without capability must not replace authorization roots"
    );
    assert_eq!(registry.list().unwrap(), json!({"roots":[]}));
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let result = tauri::test::get_ipc_response(
        &main,
        tauri::webview::InvokeRequest {
            cmd: "mcp_set_roots".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: local_ipc_origin(),
            body: tauri::ipc::InvokeBody::Json(
                json!({"roots":[{"name":"main", "path":std::env::current_dir().unwrap()}]}),
            ),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
    );
    assert!(
        result.is_ok(),
        "main must retain access to its workspace registry: {result:?}"
    );
    assert_eq!(registry.list().unwrap()["roots"][0]["name"], "main");
    let snapshot = registry.list().unwrap();
    let result = tauri::test::get_ipc_response(
        &webview,
        tauri::webview::InvokeRequest {
            cmd: "mcp_set_roots".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: local_ipc_origin(),
            body: tauri::ipc::InvokeBody::Json(json!({"roots": []})),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
    );
    assert_eq!(
        result.unwrap_err(),
        json!("Could not update MCP workspaces")
    );
    assert_eq!(registry.list().unwrap(), snapshot);
}

#[cfg(unix)]
#[tokio::test]
async fn sec_review_unauthenticated_slow_peers_expire() {
    let fixture = fixture();
    let directory = fixture.path().join("endpoint");
    let _endpoint = platform::Endpoint::start(&directory, Arc::new(Registry::default())).unwrap();
    let mut peers = Vec::new();
    for _ in 0..MAX_CONNECTIONS {
        let (mut stream, _) = platform::connect(&directory).await.unwrap();
        stream.write_all(b"{").await.unwrap();
        peers.push(stream);
    }
    tokio::time::sleep(REQUEST_TIMEOUT + Duration::from_millis(200)).await;
    for stream in peers {
        assert!(receive::<_, Response>(&mut BufReader::new(stream))
            .await
            .is_err());
    }
    assert_eq!(
        Proxy::new(directory).call().await.unwrap(),
        json!({"roots":[]})
    );
    println!("unauthenticated_slow_peers=16 expired_after_deadline=true subsequent_read=ok");
}

#[test]
fn token_format_and_constant_time_result_are_required() {
    let expected = "a".repeat(64);
    assert!(valid_token(&expected, &expected));
    for candidate in [
        "b".repeat(64),
        "a".repeat(63),
        "a".repeat(65),
        "A".repeat(64),
        "g".repeat(64),
        "é".repeat(32),
    ] {
        assert!(!valid_token(&candidate, &expected));
    }
    for malformed in ["a".repeat(63), "g".repeat(64), "A".repeat(64)] {
        assert!(!valid_token(&malformed, &malformed));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn maximum_escaped_roots_remain_listable_and_rejections_preserve_snapshot() {
    let fixture = fixture();
    let registry = Arc::new(Registry::default());
    registry
        .replace(
            (0..256)
                .map(|n| RootInput {
                    name: "\u{1}".repeat(512),
                    path: fixture.path().join(n.to_string()),
                })
                .collect(),
        )
        .unwrap();
    let snapshot = registry.list().unwrap();
    let _endpoint =
        platform::Endpoint::start(&fixture.path().join("endpoint"), registry.clone()).unwrap();
    assert_eq!(
        Proxy::new(fixture.path().join("endpoint"))
            .call()
            .await
            .unwrap(),
        snapshot
    );
    for roots in [
        (0..257)
            .map(|n| RootInput {
                name: "n".into(),
                path: fixture.path().join(n.to_string()),
            })
            .collect(),
        vec![RootInput {
            name: "n".repeat(513),
            path: fixture.path().into(),
        }],
        vec![
            RootInput {
                name: "n".into(),
                path: fixture.path().into()
            };
            2
        ],
    ] {
        assert!(registry.replace(roots).is_err());
        assert_eq!(registry.list().unwrap(), snapshot);
    }
    let worst = Response {
        id: u64::MAX,
        result: Some(snapshot),
    };
    assert!(serde_json::to_vec(&worst).unwrap().len() < MAX_RESPONSE);
}

#[tokio::test]
async fn response_boundary_is_four_mib_and_request_limit_stays_small() {
    for (size, accepted) in [(MAX_RESPONSE, true), (MAX_RESPONSE + 1, false)] {
        let envelope = serde_json::to_vec(&Response {
            id: 1,
            result: Some(json!("")),
        })
        .unwrap()
        .len();
        let response = Response {
            id: 1,
            result: Some(json!("x".repeat(size - envelope))),
        };
        let (mut writer, reader) = tokio::io::duplex(MAX_RESPONSE + 2);
        let write = send_response(&mut writer, &response).await;
        assert_eq!(write.is_ok(), accepted);
        drop(writer);
        assert_eq!(
            receive_response(&mut BufReader::new(reader)).await.is_ok(),
            accepted
        );
    }
    let response = Response {
        id: 1,
        result: Some(json!("x".repeat(MAX_FRAME))),
    };
    assert!(send(&mut tokio::io::sink(), &response).await.is_err());
    let bytes = [vec![b' '; MAX_RESPONSE + 1], vec![b'\n']].concat();
    assert!(receive_response(&mut bytes.as_slice()).await.is_err());
}

#[test]
fn round2_concurrent_replace_preserves_complete_snapshots() {
    let registry = Arc::new(Registry::default());
    let base = std::env::current_dir().unwrap();
    let snapshot = |tag: &str| {
        (0..16)
            .map(|n| RootInput {
                name: tag.to_string(),
                path: base.join(n.to_string()),
            })
            .collect()
    };
    registry.replace(snapshot("A")).unwrap();
    let first_ids: Vec<_> = registry.list().unwrap()["roots"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].clone())
        .collect();
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let mut readers = Vec::new();
    for _ in 0..2 {
        let registry = registry.clone();
        let barrier = barrier.clone();
        let ids = first_ids.clone();
        readers.push(std::thread::spawn(move || {
            barrier.wait();
            for _ in 0..2000 {
                let listed = registry.list().unwrap();
                let roots = listed["roots"].as_array().unwrap();
                assert_eq!(roots.len(), 16);
                let tag = &roots[0]["name"];
                assert!(*tag == json!("A") || *tag == json!("B"));
                for (index, root) in roots.iter().enumerate() {
                    assert_eq!(&root["name"], tag);
                    assert_eq!(root["id"], ids[index]);
                }
            }
        }));
    }
    barrier.wait();
    for index in 0..1000 {
        registry
            .replace(snapshot(if index % 2 == 0 { "A" } else { "B" }))
            .unwrap();
        assert!(registry
            .replace(vec![RootInput {
                name: "bad".into(),
                path: "relative".into()
            }])
            .is_err());
    }
    for reader in readers {
        reader.join().unwrap();
    }
    println!("concurrent_snapshots=4000 valid_replacements=1000 invalid_replacements=1000 partial_snapshot=0 stable_ids=true");
}

#[test]
fn round2_manifest_keeps_existing_read_dir_callable() {
    let fixture = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
    let app = tauri::test::mock_builder()
        .invoke_handler(tauri::generate_handler![crate::read_dir])
        .build(crate::tauri_context())
        .unwrap();
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let result = tauri::test::get_ipc_response(
        &main,
        tauri::webview::InvokeRequest {
            cmd: "read_dir".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: local_ipc_origin(),
            body: tauri::ipc::InvokeBody::Json(json!({"path":fixture.path()})),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
    );
    assert!(result.is_ok(), "existing command regressed: {result:?}");
    assert_eq!(result.unwrap().deserialize::<Value>().unwrap(), json!([]));
    println!("existing_read_dir_main=allowed empty_fixture_result=[]");
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn round2_valid_unix_socket_path_survives_private_publication() {
    let fixture = fixture();
    let length = fixture.path().as_os_str().as_encoded_bytes().len();
    assert!(length + 1 < 90);
    let directory = fixture.path().join("d".repeat(90 - length - 1));
    std::fs::create_dir(&directory).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    let socket = directory.join("ipc.sock");
    let direct =
        std::os::unix::net::UnixListener::bind(&socket).expect("final endpoint fits Unix sun_path");
    drop(direct);
    std::fs::remove_file(&socket).unwrap();
    let result = platform::Endpoint::start(&directory, Arc::new(Registry::default()));
    println!(
        "directory_path_bytes={} final_socket_path_bytes={} direct_bind=ok endpoint_start={:?}",
        directory.as_os_str().as_encoded_bytes().len(),
        socket.as_os_str().as_encoded_bytes().len(),
        result.as_ref().map(|_| ()).map_err(|e| e.to_string())
    );
    assert!(
        result.is_ok(),
        "private staging must preserve a valid final socket path"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn disk_tools_are_advertised_before_dispatch() {
    let fixture = fixture();
    let registry = Arc::new(Registry::default());
    registry
        .replace(vec![RootInput {
            name: "notes".into(),
            path: fixture.path().canonicalize().unwrap(),
        }])
        .unwrap();
    let root_id = registry.list().unwrap()["roots"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    std::fs::write(fixture.path().join("a.md"), "hello sk-aaaaaaaaaaaaaaaaaaaa").unwrap();
    let directory = fixture.path().join("endpoint");
    std::fs::create_dir(&directory).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let _endpoint = platform::Endpoint::start(&directory, registry.clone()).unwrap();
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
    for name in ["list_files", "read_file", "search_workspace"] {
        assert!(tools.iter().any(|tool| tool.name == name), "missing {name}");
    }
    for tool in &tools {
        assert_eq!(
            tool.annotations.as_ref().unwrap().read_only_hint,
            Some(true)
        );
    }
    for (name, arguments, field) in [
        ("list_files", json!({"root_id":root_id}), "entries"),
        (
            "read_file",
            json!({"root_id":root_id,"path":"a.md"}),
            "content",
        ),
        (
            "search_workspace",
            json!({"root_id":root_id,"query":"hello"}),
            "matches",
        ),
    ] {
        let result = client
            .call_tool(
                CallToolRequestParams::new(name)
                    .with_arguments(arguments.as_object().unwrap().clone()),
            )
            .await
            .unwrap();
        let value = result.structured_content.unwrap();
        assert!(value.get(field).is_some());
        assert!(!value.to_string().contains("sk-aaaaaaaaaaaaaaaaaaaa"));
        if name == "read_file" {
            assert_eq!(value["content"], "hello [secret]");
        }
        if name == "search_workspace" {
            assert_eq!(value["matches"][0]["text"], "hello [secret]");
        }
    }
    registry.replace(vec![]).unwrap();
    let result = client
        .call_tool(
            CallToolRequestParams::new("read_file").with_arguments(
                json!({"root_id":root_id,"path":"a.md"})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )
        .await
        .unwrap();
    assert_eq!(result.is_error, Some(true));
    assert_eq!(result.content[0].as_text().unwrap().text, "root closed");
    client.cancel().await.unwrap();
    server.await.unwrap();
}

#[test]
fn security_fix_root_command_yields_until_read_releases() {
    use std::{
        future::Future,
        pin::pin,
        task::{Context, Poll, Waker},
        time::Instant,
    };
    use tauri::Manager;
    let registry = Arc::new(Registry::default());
    registry
        .replace(vec![RootInput {
            name: "notes".into(),
            path: std::env::current_dir().unwrap(),
        }])
        .unwrap();
    let app = tauri::test::mock_builder()
        .manage(registry.clone())
        .build(crate::tauri_context())
        .unwrap();
    let _main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let held = registry.clone();
    let reader = std::thread::spawn(move || {
        let guard = held.roots.read().unwrap();
        ready_tx.send(()).unwrap();
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(
            guard.len(),
            1,
            "root must remain authorized until the read ends"
        );
    });
    ready_rx.recv().unwrap();
    let webview: &tauri::Webview<_> = _main.as_ref();
    let mut future = pin!(mcp_set_roots(webview.clone(), vec![], app.state()));
    let started = Instant::now();
    let poll = future
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()));
    let elapsed = started.elapsed();
    reader.join().unwrap();
    assert!(
        elapsed < Duration::from_millis(200),
        "first poll blocked for {elapsed:?}"
    );
    assert!(
        matches!(poll, Poll::Pending),
        "acknowledged before read completed: {poll:?}"
    );
    tauri::async_runtime::block_on(future).unwrap();
    assert_eq!(registry.list().unwrap(), json!({"roots":[]}));
    let error = tauri::async_runtime::block_on(mcp_set_roots(
        webview.clone(),
        vec![RootInput {
            name: "invalid".into(),
            path: PathBuf::from("relative"),
        }],
        app.state(),
    ))
    .unwrap_err();
    assert_eq!(error, "Could not update MCP workspaces");
    assert_eq!(registry.list().unwrap(), json!({"roots":[]}));
}

#[test]
fn security_fix_root_command_during_36_mib_disk_read() {
    use std::{
        future::Future,
        pin::pin,
        task::{Context, Poll, Waker},
        time::Instant,
    };
    use tauri::Manager;
    let dir = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
    std::fs::write(dir.path().join("large.md"), vec![b'x'; 36 * 1024 * 1024]).unwrap();
    let registry = Arc::new(Registry::default());
    registry
        .replace(vec![RootInput {
            name: "notes".into(),
            path: dir.path().canonicalize().unwrap(),
        }])
        .unwrap();
    let id = registry.list().unwrap()["roots"][0]["id"].clone();
    let app = tauri::test::mock_builder()
        .manage(registry.clone())
        .build(crate::tauri_context())
        .unwrap();
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let reading = registry.clone();
    let reader = std::thread::spawn(move || {
        reading.disk("read_file", json!({"root_id":id, "path":"large.md"}))
    });
    let started = Instant::now();
    while registry.roots.try_write().is_ok() {
        assert!(
            !reader.is_finished(),
            "disk read finished before lock contention was observed"
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "disk did not acquire authorization lock"
        );
        std::thread::yield_now();
    }
    let webview: &tauri::Webview<_> = main.as_ref();
    let mut future = pin!(mcp_set_roots(webview.clone(), vec![], app.state()));
    let started = Instant::now();
    let poll = future
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()));
    let elapsed = started.elapsed();
    let read = reader.join().unwrap();
    assert!(
        elapsed < Duration::from_millis(200),
        "first poll blocked for {elapsed:?}; read={read:?}"
    );
    assert!(
        matches!(poll, Poll::Pending),
        "unexpected immediate acknowledgement: {poll:?}"
    );
    match read {
        Ok(value) => assert_eq!(value["total_lines"], 1),
        Err(error) => assert_eq!(error, "timed out"),
    }
    tauri::async_runtime::block_on(future).unwrap();
    assert_eq!(registry.list().unwrap(), json!({"roots":[]}));
}

fn one_root(path: &Path) -> Registry {
    let registry = Registry::default();
    registry
        .replace(vec![RootInput {
            name: "notes".into(),
            path: path.to_path_buf(),
        }])
        .unwrap();
    registry
}

#[test]
fn with_root_resolves_without_the_lock_and_rechecks_after_it() {
    let dir = fixture();
    let root = dir.path().to_path_buf();
    let received = root.to_str().unwrap().to_owned();
    // A `replace` issued from inside the resolution step completes at once
    // (the read lock is not held there) and a root closed in that window
    // never reaches `f`.
    let registry = Arc::new(one_root(&root));
    let (tx, rx) = std::sync::mpsc::channel();
    let worker = registry.clone();
    std::thread::spawn(move || {
        let canonical = std::fs::canonicalize(&root).unwrap();
        let ran = std::cell::Cell::new(false);
        let out = worker.with_root_resolved(
            &received,
            |_| {
                worker.replace(vec![]).unwrap();
                Some(canonical)
            },
            |_| ran.set(true),
        );
        tx.send((out.is_none(), ran.get())).unwrap();
    });
    let (refused, ran) = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("replace blocked: the root lock was held during the resolution");
    assert!(refused, "a root closed during resolution must be refused");
    assert!(!ran, "f must not start after the root was closed");
    // Control: still registered after resolution, `f` runs under the guard.
    let dir = fixture();
    let received = dir.path().to_str().unwrap().to_owned();
    let registry = one_root(dir.path());
    let seen = registry
        .with_root(&received, |canonical| canonical.to_path_buf())
        .unwrap();
    assert_eq!(seen, std::fs::canonicalize(dir.path()).unwrap());
}

#[test]
fn a_root_closed_and_reopened_with_the_same_spelling_during_resolution_is_refused() {
    let dir = fixture();
    let root = dir.path().to_path_buf();
    let received = root.to_str().unwrap().to_owned();
    let registry = Arc::new(one_root(&root));
    let canonical = std::fs::canonicalize(&root).unwrap();
    let ran = std::cell::Cell::new(false);
    // Inside the resolution step (no lock held) the folder is closed and
    // opened again under the very same spelling: a new registration.
    let out = registry.with_root_resolved(
        &received,
        |_| {
            registry.replace(vec![]).unwrap();
            registry
                .replace(vec![RootInput {
                    name: "notes".into(),
                    path: root.clone(),
                }])
                .unwrap();
            Some(canonical.clone())
        },
        |_| ran.set(true),
    );
    assert!(out.is_none(), "the reopened root is not the one resolved");
    assert!(
        !ran.get(),
        "f must not start for a registration that closed"
    );
    // Control: a `replace` that keeps the folder open keeps its id, so the
    // read in progress is still valid.
    let registry = one_root(&root);
    let out = registry.with_root_resolved(
        &received,
        |_| {
            registry
                .replace(vec![RootInput {
                    name: "renamed".into(),
                    path: root.clone(),
                }])
                .unwrap();
            Some(canonical.clone())
        },
        |_| true,
    );
    assert_eq!(out, Some(true));
}

#[test]
fn with_root_matches_the_exact_registration_before_any_filesystem_access() {
    let dir = fixture();
    let registry = one_root(dir.path());
    let exact = dir.path().to_str().unwrap();
    for received in [
        format!("{exact}/"),
        format!("{exact}/."),
        format!(
            "{exact}/../{}",
            dir.path().file_name().unwrap().to_str().unwrap()
        ),
        format!("{exact}x"),
        dir.path().parent().unwrap().to_str().unwrap().to_owned(),
        format!("{exact}/sub"),
        "\\\\server\\share".to_owned(),
        String::new(),
    ] {
        let touched = std::cell::Cell::new(false);
        let out = registry.with_root_resolved(
            &received,
            |_| {
                touched.set(true);
                None
            },
            |_| (),
        );
        assert!(out.is_none(), "{received:?} must not match");
        assert!(!touched.get(), "{received:?} reached the filesystem step");
    }
    // A registered root that vanished from disk is refused.
    let gone = fixture();
    let received = gone.path().to_str().unwrap().to_owned();
    let registry = one_root(gone.path());
    drop(gone);
    assert!(registry.with_root(&received, |_| ()).is_none());
}
