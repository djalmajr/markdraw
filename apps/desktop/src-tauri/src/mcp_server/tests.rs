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

#[cfg(unix)]
fn fixture() -> tempfile::TempDir {
    // Explicit destination: no test endpoint ever lands under /tmp.
    tempfile::tempdir_in(std::env::var_os("TMPDIR").expect("run with TMPDIR=$HOME/.cache/md-tmp"))
        .unwrap()
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
    assert_eq!(tools.len(), 1);
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
