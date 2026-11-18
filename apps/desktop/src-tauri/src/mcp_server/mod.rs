//! Read-only external MCP server. Separate from the embedded MCP client.
//! Only the running app owns authorization; the stdio process never reads
//! workspace contents and never starts Tauri.
use rmcp::{
    model::{
        CallToolRequestParams, CallToolResult, ListToolsResult, PaginatedRequestParams,
        ServerCapabilities, ServerInfo, Tool,
    },
    service::{RequestContext, RoleServer},
    ErrorData, ServerHandler, ServiceExt,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io,
    path::PathBuf,
    sync::{Arc, RwLock},
    time::Duration,
};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

#[cfg(unix)]
#[path = "unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "windows.rs"]
mod platform;

const MAX_FRAME: usize = 64 * 1024;
const MAX_CONNECTIONS: usize = 16;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
pub const NOT_RUNNING: &str = "Markdraw is not running; open it and try again";

fn build_identity(debug: bool) -> &'static str {
    if debug {
        "app.markdraw-dev"
    } else {
        "app.markdraw"
    }
}
fn identity() -> &'static str {
    build_identity(cfg!(debug_assertions))
}

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "Invalid MCP IPC frame")
}
fn random_id() -> io::Result<String> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| io::Error::other("MCP session entropy unavailable"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootInput {
    pub name: String,
    pub path: PathBuf,
}

struct Root {
    id: String,
    name: String,
    path: PathBuf,
}
#[derive(Default)]
pub struct Registry {
    roots: RwLock<Vec<Root>>,
}
impl Registry {
    pub fn replace(&self, inputs: Vec<RootInput>) -> io::Result<()> {
        if inputs.len() > 256
            || inputs.iter().any(|root| {
                !root.path.is_absolute()
                    || root.name.is_empty()
                    || root.name.len() > 512
                    || root.name.contains(['/', '\\', '\0'])
            })
        {
            return Err(invalid());
        }
        let mut roots = self
            .roots
            .write()
            .map_err(|_| io::Error::other("MCP registry unavailable"))?;
        let mut next = Vec::with_capacity(inputs.len());
        for input in inputs {
            if next.iter().any(|root: &Root| root.path == input.path) {
                return Err(invalid());
            }
            let id = match roots.iter().find(|root| root.path == input.path) {
                Some(root) => root.id.clone(),
                None => random_id()?,
            };
            next.push(Root {
                id,
                name: input.name,
                path: input.path,
            });
        }
        // Hold the write lock over both ID reconciliation and replacement;
        // a read after the command returns cannot see a closed root.
        *roots = next;
        Ok(())
    }
    fn list(&self) -> io::Result<Value> {
        let roots = self
            .roots
            .read()
            .map_err(|_| io::Error::other("MCP registry unavailable"))?;
        Ok(
            json!({"roots": roots.iter().map(|root| json!({"id":root.id,"name":root.name})).collect::<Vec<_>>()}),
        )
    }
}

#[tauri::command]
pub fn mcp_set_roots(
    roots: Vec<RootInput>,
    registry: tauri::State<'_, Arc<Registry>>,
) -> Result<(), String> {
    registry
        .replace(roots)
        .map_err(|_| "Could not update MCP workspaces".into())
}

async fn read_frame<R: AsyncBufRead + Unpin>(reader: &mut R) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "MCP IPC closed",
            ));
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let count = newline.unwrap_or(available.len());
        if bytes.len() + count > MAX_FRAME {
            return Err(invalid());
        }
        bytes.extend_from_slice(&available[..count]);
        reader.consume(count + usize::from(newline.is_some()));
        if newline.is_some() {
            return Ok(bytes);
        }
    }
}
async fn timed_frame<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    duration: Duration,
) -> io::Result<Vec<u8>> {
    tokio::time::timeout(duration, read_frame(reader))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "MCP IPC request timed out"))?
}
async fn receive<R: AsyncBufRead + Unpin, T: serde::de::DeserializeOwned>(
    reader: &mut R,
) -> io::Result<T> {
    serde_json::from_slice(&timed_frame(reader, REQUEST_TIMEOUT).await?).map_err(|_| invalid())
}
async fn send<W: AsyncWrite + Unpin, T: Serialize>(writer: &mut W, value: &T) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| invalid())?;
    if bytes.len() > MAX_FRAME {
        return Err(invalid());
    }
    bytes.push(b'\n');
    tokio::time::timeout(REQUEST_TIMEOUT, async {
        writer.write_all(&bytes).await?;
        writer.flush().await
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "MCP IPC request timed out"))?
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Auth {
    id: u64,
    token: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: u64,
    method: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Response {
    id: u64,
    result: Option<Value>,
}

async fn handle_connection<S: AsyncRead + AsyncWrite + Unpin>(
    stream: S,
    registry: Arc<Registry>,
    token: &str,
) -> io::Result<()> {
    let mut stream = BufReader::new(stream);
    let auth: Auth = receive(&mut stream).await?;
    if auth.id != 0 || auth.token != token {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "MCP authentication failed",
        ));
    }
    send(
        &mut stream,
        &Response {
            id: 0,
            result: Some(json!({})),
        },
    )
    .await?;
    let mut last_id = 0;
    loop {
        let request: Request = receive(&mut stream).await?;
        // Strictly increasing IDs bound replay memory for arbitrary sessions.
        if request.id <= last_id || request.method != "list_workspaces" {
            return Err(invalid());
        }
        last_id = request.id;
        let result = registry.list()?;
        send(
            &mut stream,
            &Response {
                id: request.id,
                result: Some(result),
            },
        )
        .await?;
    }
}

#[cfg(unix)]
async fn accept_loop(listener: tokio::net::UnixListener, registry: Arc<Registry>, token: String) {
    let limit = Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS));
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = match accepted { Ok(value) => value, Err(_) => break };
                let permit = match limit.clone().try_acquire_owned() { Ok(permit) => permit, Err(_) => continue };
                let registry = registry.clone();
                let token = token.clone();
                tasks.spawn(async move {
                    let _permit = permit;
                    // Bad/closed peers are deliberately disconnected, without
                    // logging their frames or session credentials.
                    let _ = handle_connection(stream, registry, &token).await;
                });
            },
            _ = tasks.join_next(), if !tasks.is_empty() => (),
        }
    }
}

pub struct AppEndpoint(platform::Endpoint);
impl AppEndpoint {
    pub fn start(registry: Arc<Registry>) -> io::Result<Self> {
        // Tauri calls setup on its main thread, outside a Tokio task.
        let runtime = tauri::async_runtime::handle();
        let _entered = runtime.inner().enter();
        let directory = platform::default_directory()?;
        platform::prepare_parent(&directory)?;
        platform::Endpoint::start(&directory, registry).map(Self)
    }
}
impl AppEndpoint {
    pub fn stop(self) {
        drop(self.0);
    }
}

#[derive(Clone)]
struct Proxy {
    directory: PathBuf,
    limit: Arc<tokio::sync::Semaphore>,
}
impl Proxy {
    fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            limit: Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS)),
        }
    }
    async fn call(&self) -> io::Result<Value> {
        let _permit = self
            .limit
            .try_acquire()
            .map_err(|_| io::Error::new(io::ErrorKind::WouldBlock, "Too many MCP requests"))?;
        tokio::time::timeout(REQUEST_TIMEOUT, async {
            let (stream, token) = platform::connect(&self.directory).await?;
            let mut stream = BufReader::new(stream);
            send(&mut stream, &Auth { id: 0, token }).await?;
            let authenticated: Response = receive(&mut stream).await?;
            if authenticated.id != 0 {
                return Err(invalid());
            }
            send(
                &mut stream,
                &Request {
                    id: 1,
                    method: "list_workspaces".into(),
                },
            )
            .await?;
            let response: Response = receive(&mut stream).await?;
            if response.id != 1 {
                return Err(invalid());
            }
            response.result.ok_or_else(invalid)
        })
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "MCP IPC request timed out"))?
    }
}
impl ServerHandler for Proxy {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions("Read-only access to workspaces open in Markdraw.")
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let mut tool = Tool::new(
            "list_workspaces",
            "List the workspaces currently open in Markdraw",
            json!({"type":"object","properties":{},"additionalProperties":false})
                .as_object()
                .unwrap()
                .clone(),
        );
        tool.annotations = Some(rmcp::model::ToolAnnotations::new().read_only(true));
        Ok(ListToolsResult {
            tools: vec![tool],
            ..Default::default()
        })
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        if request.name != "list_workspaces"
            || request
                .arguments
                .as_ref()
                .is_some_and(|args| !args.is_empty())
            || request.task.is_some()
        {
            return Err(ErrorData::invalid_params(
                "Unknown tool or invalid arguments",
                None,
            ));
        }
        self.call()
            .await
            .map(CallToolResult::structured)
            .map_err(|error| {
                let message = match error.kind() {
                    io::ErrorKind::TimedOut => "Markdraw request timed out; try again",
                    io::ErrorKind::WouldBlock => "Too many Markdraw requests; try again",
                    _ => NOT_RUNNING,
                };
                ErrorData::internal_error(message, None)
            })
    }
}

/// Called exclusively by the CLI branch before Tauri/GTK initialization.
pub fn run_stdio() -> Result<(), &'static str> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|_| "Could not start Markdraw MCP")?;
    // Tokio's stdin thread can remain blocked after app shutdown; shutdown_timeout
    // keeps the command finite, without touching the app or another process.
    let result = runtime.block_on(async {
        let directory = platform::default_directory().map_err(|_| NOT_RUNNING)?;
        let proxy = Proxy::new(directory);
        proxy.call().await.map_err(|_| NOT_RUNNING)?;
        // Monitoring has its own permit pool so agent concurrency cannot
        // masquerade as app shutdown, including during MCP initialization.
        let monitor = Proxy::new(proxy.directory.clone());
        let closed = async {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                if monitor.call().await.is_err() { break; }
            }
        };
        tokio::pin!(closed);
        let service = tokio::select! {
            result = proxy.serve(rmcp::transport::stdio()) => match result {
                Ok(service) => service,
                Err(rmcp::service::ServerInitializeError::ConnectionClosed(_)) => return Ok(()),
                Err(_) => return Err("Markdraw MCP initialization failed"),
            },
            _ = &mut closed => return Ok(()),
        };
        let cancellation = service.cancellation_token();
        tokio::select! {
            result = service.waiting() => { result.map_err(|_| "Markdraw MCP stopped unexpectedly")?; },
            _ = &mut closed => { cancellation.cancel(); },
        }
        Ok(())
    });
    runtime.shutdown_timeout(Duration::from_millis(100));
    result
}

#[cfg(test)]
mod tests;
