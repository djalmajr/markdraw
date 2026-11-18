#![cfg(unix)]
//! Exercise the installed-command entry point with pipes, without Tauri/GTK.
use rmcp::{model::CallToolRequestParams, ServiceExt};
use std::{os::unix::fs::PermissionsExt, process::Stdio, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[tokio::test]
async fn stdio_cli_closed_app_does_not_open_a_window() {
    let directory = tempfile::tempdir_in(std::env::var_os("TMPDIR").unwrap()).unwrap();
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new(env!("CARGO_BIN_EXE_markdraw"))
            .arg("mcp")
            .env("XDG_RUNTIME_DIR", directory.path())
            .env_remove("DISPLAY")
            .env_remove("WAYLAND_DISPLAY")
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(
        output.stdout.is_empty(),
        "stdout must contain only MCP protocol"
    );
    assert_eq!(
        String::from_utf8(output.stderr).unwrap().trim(),
        markdraw_lib::mcp_server::NOT_RUNNING
    );
    assert!(
        !directory.path().join("markdraw").exists(),
        "stdio discovery must not write endpoint artifacts"
    );
}

#[tokio::test]
async fn stdio_cli_real_client_fake_app_eof_and_app_shutdown() {
    let fixture = tempfile::tempdir_in(std::env::var_os("TMPDIR").unwrap()).unwrap();
    std::fs::set_permissions(fixture.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let parent = fixture.path().join("markdraw");
    std::fs::create_dir(&parent).unwrap();
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700)).unwrap();
    let directory = parent.join(if cfg!(debug_assertions) {
        "app.markdraw-dev"
    } else {
        "app.markdraw"
    });
    std::fs::create_dir(&directory).unwrap();
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(directory.join("token"), "a".repeat(64)).unwrap();
    std::fs::set_permissions(
        directory.join("token"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let listener = tokio::net::UnixListener::bind(directory.join("ipc.sock")).unwrap();
    std::fs::set_permissions(
        directory.join("ipc.sock"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let (stop, mut stopped) = tokio::sync::oneshot::channel();
    let fake_app = tokio::spawn(async move {
        let mut peers = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                _ = &mut stopped => break,
                accepted = listener.accept() => {
                    let (stream,_) = accepted.unwrap();
                    peers.spawn(async move {
                        let mut stream = BufReader::new(stream);
                        let mut line = String::new();
                        stream.read_line(&mut line).await.unwrap();
                        let auth:serde_json::Value = serde_json::from_str(&line).unwrap();
                        assert_eq!(auth["token"],"a".repeat(64));
                        stream.write_all(b"{\"id\":0,\"result\":{}}\n").await.unwrap();
                        line.clear();
                        stream.read_line(&mut line).await.unwrap();
                        let request:serde_json::Value = serde_json::from_str(&line).unwrap();
                        assert_eq!(request["method"],"list_workspaces");
                        stream.write_all(b"{\"id\":1,\"result\":{\"roots\":[{\"id\":\"opaque\",\"name\":\"notes\"}]}}\n").await.unwrap();
                    });
                },
                _ = peers.join_next(), if !peers.is_empty() => (),
            }
        }
    });
    let spawn = || {
        let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_markdraw"));
        command
            .arg("mcp")
            .env("XDG_RUNTIME_DIR", fixture.path())
            .env_remove("DISPLAY")
            .env_remove("WAYLAND_DISPLAY")
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        command.spawn().unwrap()
    };
    // EOF before initialize is also a normal agent shutdown.
    let mut early_eof = spawn();
    drop(early_eof.stdin.take());
    let status = tokio::time::timeout(Duration::from_secs(3), early_eof.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(
        status.success(),
        "MCP must exit cleanly on EOF before initialize: {status}"
    );
    let mut child = spawn();
    let transport = (child.stdout.take().unwrap(), child.stdin.take().unwrap());
    let client = ().serve(transport).await.unwrap();
    assert_eq!(
        client.list_all_tools().await.unwrap()[0].name,
        "list_workspaces"
    );
    let result = client
        .call_tool(CallToolRequestParams::new("list_workspaces"))
        .await
        .unwrap();
    assert_eq!(
        result.structured_content.unwrap(),
        serde_json::json!({"roots":[{"id":"opaque","name":"notes"}]})
    );
    client.cancel().await.unwrap();
    let status = tokio::time::timeout(Duration::from_secs(3), child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(
        status.success(),
        "MCP must exit cleanly on stdin EOF: {status}"
    );
    // A second client stays connected while the app closes; the command exits
    // on its own, without waiting for another request from the agent.
    let mut child = spawn();
    let transport = (child.stdout.take().unwrap(), child.stdin.take().unwrap());
    let client = ().serve(transport).await.unwrap();
    stop.send(()).unwrap();
    fake_app.await.unwrap();
    tokio::time::timeout(Duration::from_secs(8), client.waiting())
        .await
        .unwrap()
        .unwrap();
    let status = tokio::time::timeout(Duration::from_secs(3), child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(
        status.success(),
        "MCP must exit cleanly when app closes: {status}"
    );
}
