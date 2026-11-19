#![cfg(unix)]
//! Exercise the installed-command entry point with pipes, without Tauri/GTK.
use rmcp::{model::CallToolRequestParams, ServiceExt};
use std::{os::unix::fs::PermissionsExt, process::Stdio, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[tokio::test]
async fn stdio_cli_closed_app_does_not_open_a_window() {
    let directory = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
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
    let fixture = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
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
                        let result = match request["method"].as_str().unwrap() {
                            "list_workspaces" => serde_json::json!({"roots":[{"id":"opaque","name":"notes"}]}),
                            "list_files" => {
                                assert_eq!(request["arguments"],serde_json::json!({"root_id":"opaque"}));
                                serde_json::json!({"entries":[{"name":"a.md","path":"a.md","kind":"file"}]})
                            },
                            "read_file" => {
                                assert_eq!(request["arguments"],serde_json::json!({"root_id":"opaque","path":"a.md","start_line":2,"end_line":3}));
                                serde_json::json!({"content":"hello [secret]","total_lines":3,"start_line":2,"end_line":3,"truncated":false})
                            },
                            "search_workspace" => {
                                assert_eq!(request["arguments"],serde_json::json!({"root_id":"opaque","query":"hello"}));
                                serde_json::json!({"matches":[{"path":"a.md","line":2,"text":"hello [secret]"}]})
                            },
                            other => panic!("unexpected method {other}"),
                        };
                        let response = serde_json::json!({"id":1,"result":result}).to_string()+"\n";
                        stream.write_all(response.as_bytes()).await.unwrap();
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
    for (name, arguments, expected) in [
        (
            "list_files",
            serde_json::json!({"root_id":"opaque"}),
            serde_json::json!({"entries":[{"name":"a.md","path":"a.md","kind":"file"}]}),
        ),
        (
            "read_file",
            serde_json::json!({"root_id":"opaque","path":"a.md","start_line":2,"end_line":3}),
            serde_json::json!({"content":"hello [secret]","total_lines":3,"start_line":2,"end_line":3,"truncated":false}),
        ),
        (
            "search_workspace",
            serde_json::json!({"root_id":"opaque","query":"hello"}),
            serde_json::json!({"matches":[{"path":"a.md","line":2,"text":"hello [secret]"}]}),
        ),
    ] {
        let result = client
            .call_tool(
                CallToolRequestParams::new(name)
                    .with_arguments(arguments.as_object().unwrap().clone()),
            )
            .await
            .unwrap();
        assert_eq!(result.structured_content.unwrap(), expected);
    }
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

struct FakeApp {
    fixture: tempfile::TempDir,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for FakeApp {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl FakeApp {
    fn new() -> Self {
        Self::with_slow_read(false)
    }
    fn with_slow_read(slow_read: bool) -> Self {
        let fixture = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let directory = fixture
            .path()
            .join("markdraw")
            .join(if cfg!(debug_assertions) {
                "app.markdraw-dev"
            } else {
                "app.markdraw"
            });
        std::fs::create_dir_all(&directory).unwrap();
        for path in [fixture.path(), directory.parent().unwrap(), &directory] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
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
        let task = tokio::spawn(async move {
            let mut peers = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    peer = listener.accept() => {
                        let (stream, _) = peer.unwrap();
                        peers.spawn(async move {
                            let mut stream = BufReader::new(stream);
                            let mut line = String::new();
                            if stream.read_line(&mut line).await.unwrap_or(0) == 0 {return;}
                            let auth: serde_json::Value = serde_json::from_str(&line).unwrap();
                            assert_eq!(auth["token"], "a".repeat(64));
                            if stream.write_all(b"{\"id\":0,\"result\":{}}\n").await.is_err() {return;}
                            line.clear();
                            if stream.read_line(&mut line).await.unwrap_or(0) == 0 {return;}
                            let request: serde_json::Value = serde_json::from_str(&line).unwrap();
                            if slow_read && request["method"] == "read_file" {
                                // Deliberate incomplete progress: timeout must discard
                                // these file bytes, never return a partial result.
                                stream.write_all(b"{\"id\":1,\"result\":{\"content\":\"ZQVX").await.unwrap();
                                std::future::pending::<()>().await;
                            }
                            let _ = stream.write_all(b"{\"id\":1,\"result\":{\"roots\":[]}}\n").await;
                        });
                    },
                    _ = peers.join_next(), if !peers.is_empty() => (),
                }
            }
        });
        Self { fixture, task }
    }
    fn spawn(&self) -> tokio::process::Child {
        tokio::process::Command::new(env!("CARGO_BIN_EXE_markdraw"))
            .arg("mcp")
            .env("XDG_RUNTIME_DIR", self.fixture.path())
            .env("HOME", self.fixture.path())
            .env("USERPROFILE", self.fixture.path())
            .env("XDG_CONFIG_HOME", self.fixture.path())
            .env("TMPDIR", self.fixture.path())
            .env("PATH", self.fixture.path())
            .env_remove("DISPLAY")
            .env_remove("WAYLAND_DISPLAY")
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    }
}

fn initialize_frame(size: usize) -> Vec<u8> {
    let frame = br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"bounds","version":"1"}}}"#;
    assert!(size >= frame.len());
    let mut bytes = frame.to_vec();
    bytes.resize(size, b' ');
    bytes.push(b'\n');
    bytes
}

#[tokio::test]
async fn stdio_cli_exact_boundary_passes_and_larger_frames_exit_one() {
    let app = FakeApp::new();
    let mut child = app.spawn();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(&initialize_frame(65536))
        .await
        .unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(3), stdout.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    let response: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert!(
        response.get("result").is_some(),
        "exactly 64KiB is valid: {line}"
    );
    drop(child.stdin.take());
    assert!(tokio::time::timeout(Duration::from_secs(3), child.wait())
        .await
        .unwrap()
        .unwrap()
        .success());
    for newline in [false, true] {
        let mut child = app.spawn();
        let mut frame = initialize_frame(65537);
        if !newline {
            frame.pop();
        }
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(&frame)
            .await
            .unwrap();
        let output = tokio::time::timeout(Duration::from_secs(3), child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        assert_eq!(
            String::from_utf8(output.stderr).unwrap().trim(),
            "markdraw mcp: message too large"
        );
    }
}

#[tokio::test]
async fn stdio_cli_partial_frame_times_out_but_idle_session_survives() {
    let app = FakeApp::new();
    let mut idle = app.spawn();
    let mut partial = app.spawn();
    partial
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"{")
        .await
        .unwrap();
    let _partial_stdin = partial.stdin.take().unwrap();
    let output = tokio::time::timeout(Duration::from_secs(8), partial.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8(output.stderr).unwrap().trim(),
        "markdraw mcp: message timed out"
    );
    assert!(
        idle.try_wait().unwrap().is_none(),
        "idle session must have no frame deadline"
    );
    idle.stdin
        .as_mut()
        .unwrap()
        .write_all(&initialize_frame(200))
        .await
        .unwrap();
    let mut line = String::new();
    tokio::time::timeout(
        Duration::from_secs(3),
        BufReader::new(idle.stdout.take().unwrap()).read_line(&mut line),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(serde_json::from_str::<serde_json::Value>(&line)
        .unwrap()
        .get("result")
        .is_some());
    drop(idle.stdin.take());
    assert!(tokio::time::timeout(Duration::from_secs(3), idle.wait())
        .await
        .unwrap()
        .unwrap()
        .success());
}

#[tokio::test]
async fn amendment_read_timeout_is_fixed_without_content_or_cursor() {
    let app = FakeApp::with_slow_read(true);
    let mut child = app.spawn();
    let transport = (child.stdout.take().unwrap(), child.stdin.take().unwrap());
    let client = ().serve(transport).await.unwrap();
    let started = std::time::Instant::now();
    let result = tokio::time::timeout(
        Duration::from_secs(8),
        client.call_tool(
            CallToolRequestParams::new("read_file").with_arguments(
                serde_json::json!({"root_id":"opaque","path":"a"})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        ),
    )
    .await
    .unwrap();
    match result.unwrap_err() {
        rmcp::ServiceError::McpError(error) => {
            assert_eq!(error.message, "timed out");
            assert!(error.data.is_none());
        }
        other => panic!("unexpected timeout response: {other}"),
    }
    assert!(started.elapsed() >= Duration::from_secs(5));
    client.cancel().await.unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(3), child.wait())
        .await
        .unwrap()
        .unwrap()
        .success());
}
