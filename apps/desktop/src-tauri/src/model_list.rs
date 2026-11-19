//! Sources of provider model lists that the webview cannot reach on its own.
//!
//! Three Tauri commands, all deliberately narrow — none of them accepts a
//! command, a file path or a free-form scheme from the webview:
//!
//! * [`ai_http_get_json`] — a bounded `GET` for any `http(s)` base URL (the
//!   `tauri-plugin-http` allowlist does not cover xAI, Gemini, LM Studio or
//!   custom providers).
//! * [`cli_list_models`] — runs `<cli> models` for exactly two known provider
//!   ids and returns the (size-bounded) stdout.
//! * [`codex_models_cache`] — reads `~/.codex/models_cache.json` only and
//!   returns just the model fields.
//!
//! This module transports raw or minimal data; parsing each list format is the
//! frontend's job.
//!
//! Secret hygiene: every error is a [`ModelListError`] whose `code` and
//! `message` are fixed strings. Nothing derived from a header value, a URL,
//! a response body, a stderr stream or an upstream error `Display` is ever put
//! in an error (reqwest errors embed the full URL, which may carry `?key=`).
//! The CLI's stderr is never captured at all.

use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::Semaphore;

use crate::cli_agent::{binary_for_provider, cli_path_env_for, resolve_cli_path};

/// Largest response body [`ai_http_get_json`] will buffer.
const HTTP_MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
const HTTP_DEFAULT_TIMEOUT_MS: u64 = 15_000;
const HTTP_MAX_TIMEOUT_MS: u64 = 60_000;
const HTTP_MAX_REDIRECTS: usize = 3;
const HTTP_MAX_HEADERS: usize = 32;
const HTTP_MAX_HEADER_BYTES: usize = 8 * 1024;
const HTTP_MAX_URL_BYTES: usize = 8 * 1024;

const CLI_MAX_STDOUT_BYTES: usize = 256 * 1024;
const CLI_TIMEOUT: Duration = Duration::from_secs(25);

/// Global concurrency budget per command. A full budget refuses the call at
/// once with the fixed `busy` error instead of queueing it, so a webview that
/// floods the IPC cannot pile up sockets, processes or blocking threads.
const HTTP_MAX_CONCURRENT: usize = 4;
const CLI_MAX_CONCURRENT: usize = 2;
const CACHE_MAX_CONCURRENT: usize = 1;
static HTTP_SLOTS: Semaphore = Semaphore::const_new(HTTP_MAX_CONCURRENT);
static CLI_SLOTS: Semaphore = Semaphore::const_new(CLI_MAX_CONCURRENT);
static CACHE_SLOTS: Semaphore = Semaphore::const_new(CACHE_MAX_CONCURRENT);

/// Budget of the blocking system DNS lookups. A lookup runs on a blocking
/// thread that nobody can cancel, so it outlives the request that started it
/// (the request timeout, a dropped future); its permit therefore travels INTO
/// that thread and only comes back when `getaddrinfo` returns. Separate from
/// [`HTTP_SLOTS`] because the HTTP permit goes back with the request.
const DNS_MAX_CONCURRENT: usize = HTTP_MAX_CONCURRENT;
static DNS_SLOTS: Semaphore = Semaphore::const_new(DNS_MAX_CONCURRENT);

const CODEX_MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const CODEX_MAX_MODELS: usize = 2_000;
const CODEX_MAX_FIELD_CHARS: usize = 256;

/// Typed, secret-free failure. Both fields are fixed strings by construction
/// (`&'static str`), so no runtime value can leak through them.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct ModelListError {
    pub code: &'static str,
    pub message: &'static str,
}

const fn err(code: &'static str, message: &'static str) -> ModelListError {
    ModelListError { code, message }
}

fn busy() -> ModelListError {
    err("busy", "Too many model list requests are running.")
}

fn invalid_request() -> ModelListError {
    err("invalid_request", "The request is not valid.")
}

/// Run `work` only if `slots` has a free permit, holding it until `work` ends
/// (also when the future is dropped). `try_acquire` is the atomic
/// check-and-take: there is no window between "is there room" and "take it".
async fn limited<T>(
    slots: &Semaphore,
    work: impl Future<Output = Result<T, ModelListError>>,
) -> Result<T, ModelListError> {
    let _permit = slots.try_acquire().map_err(|_| busy())?;
    work.await
}

// ── HTTP GET JSON ───────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetJsonRequest {
    pub url: String,
    #[serde(default)]
    pub headers: Option<std::collections::HashMap<String, String>>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Serialize, Debug)]
pub struct GetJsonResponse {
    pub status: u16,
    pub body: String,
}

/// Request headers the webview may not set: they would let a caller redirect
/// the request to another virtual host or break message framing.
fn header_is_forbidden(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "host" | "content-length" | "transfer-encoding" | "connection" | "upgrade" | "te"
    )
}

/// Link-local (`169.254.0.0/16`, `fe80::/10`) and unspecified addresses — the
/// cloud metadata range. IPv6 forms that embed an IPv4 address (`::ffff:a.b.c.d`
/// and the deprecated `::a.b.c.d`) are judged by the IPv4 they carry, so a
/// mapped metadata address cannot slip past the IPv6 branch. Loopback and
/// private ranges stay allowed: LM Studio and Ollama live there.
fn ip_is_link_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_link_local() || v4.is_unspecified(),
        IpAddr::V6(v6) => match v6.to_ipv4() {
            Some(v4) => ip_is_link_local(IpAddr::V4(v4)),
            None => v6.is_unspecified() || (v6.segments()[0] & 0xffc0) == 0xfe80,
        },
    }
}

/// Marker error the resolver hands to the connector when no allowed address is
/// left; [`map_reqwest_error`] finds it in the source chain by type, never by
/// text.
#[derive(Debug)]
struct BlockedAddress;

impl std::fmt::Display for BlockedAddress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("blocked address")
    }
}

impl std::error::Error for BlockedAddress {}

type LookupFuture = Pin<Box<dyn Future<Output = std::io::Result<Vec<SocketAddr>>> + Send>>;
type Lookup = Arc<dyn Fn(String) -> LookupFuture + Send + Sync>;
/// The blocking name → addresses call (`getaddrinfo`); a plain `fn` so a test
/// can stand in a slow one.
type BlockingResolve = fn(&str) -> std::io::Result<Vec<SocketAddr>>;

/// Marker the lookup returns (inside an `io::Error`) when [`DNS_SLOTS`] is full;
/// the resolver turns it into the fixed `busy` error, never into a queued
/// lookup.
#[derive(Debug)]
struct LookupBusy;

impl std::fmt::Display for LookupBusy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("lookup budget is full")
    }
}

impl std::error::Error for LookupBusy {}

fn system_resolve(host: &str) -> std::io::Result<Vec<SocketAddr>> {
    use std::net::ToSocketAddrs;
    Ok((host, 0u16).to_socket_addrs()?.collect())
}

/// Runs `resolve` on a blocking thread that carries a permit of `slots` until
/// `resolve` returns — also when the awaiting future is dropped meanwhile. The
/// permit is taken with `try_acquire` before any thread is spawned: a full
/// budget answers [`LookupBusy`] at once and queues nothing.
fn budgeted_lookup(slots: &'static Semaphore, resolve: BlockingResolve) -> Lookup {
    Arc::new(move |host| {
        Box::pin(async move {
            let permit = slots
                .try_acquire()
                .map_err(|_| std::io::Error::other(LookupBusy))?;
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                resolve(&host)
            })
            .await
            .map_err(|_| std::io::Error::other("the lookup task failed"))?
        })
    })
}

fn system_lookup() -> Lookup {
    budgeted_lookup(&DNS_SLOTS, system_resolve)
}

/// DNS resolver of the GET client: the addresses the connector may dial are the
/// resolved ones minus link-local/unspecified (see [`ip_is_link_local`]). The
/// connector can only use what this returns, so the policy holds for the real
/// connection, including every reconnect and redirect hop. Nothing left → the
/// request is refused.
struct FilteringResolver {
    lookup: Lookup,
}

impl FilteringResolver {
    fn system() -> Arc<Self> {
        Arc::new(Self {
            lookup: system_lookup(),
        })
    }
}

impl reqwest::dns::Resolve for FilteringResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let lookup = self.lookup.clone();
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let resolved = lookup(host).await.map_err(|e| {
                // Hand the marker over bare: an `io::Error` hides what it wraps
                // from `source()`, so the mapping would never find it.
                if e.get_ref().is_some_and(|inner| inner.is::<LookupBusy>()) {
                    Box::new(LookupBusy) as Box<dyn std::error::Error + Send + Sync>
                } else {
                    Box::new(e) as Box<dyn std::error::Error + Send + Sync>
                }
            })?;
            let allowed: Vec<SocketAddr> = resolved
                .into_iter()
                .filter(|a| !ip_is_link_local(a.ip()))
                .collect();
            if allowed.is_empty() {
                return Err(Box::new(BlockedAddress) as Box<dyn std::error::Error + Send + Sync>);
            }
            Ok(Box::new(allowed.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// Validate the URL the webview asked for. `http`/`https` only, no embedded
/// credentials, and no link-local/unspecified IP *literal* (the cloud metadata
/// address), IPv4-mapped IPv6 forms included. Loopback and private ranges stay
/// allowed: LM Studio and Ollama live on `localhost`. A hostname is judged at
/// connect time by [`FilteringResolver`].
fn validate_url(raw: &str) -> Result<reqwest::Url, ModelListError> {
    if raw.len() > HTTP_MAX_URL_BYTES {
        return Err(err("invalid_url", "The URL is too long."));
    }
    let url = reqwest::Url::parse(raw).map_err(|_| err("invalid_url", "The URL is not valid."))?;
    match url.scheme() {
        "http" | "https" => {}
        _ => {
            return Err(err(
                "unsupported_scheme",
                "Only http and https URLs are allowed.",
            ))
        }
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(err(
            "invalid_url",
            "URLs with embedded credentials are not allowed.",
        ));
    }
    let Some(host) = url.host_str() else {
        return Err(err("invalid_url", "The URL has no host."));
    };
    // `host_str` keeps the brackets of an IPv6 literal.
    let literal = host.trim_start_matches('[').trim_end_matches(']');
    if literal.parse::<IpAddr>().is_ok_and(ip_is_link_local) {
        return Err(err("blocked_host", "This host is not allowed."));
    }
    Ok(url)
}

fn build_headers(
    headers: Option<&std::collections::HashMap<String, String>>,
) -> Result<reqwest::header::HeaderMap, ModelListError> {
    let mut map = reqwest::header::HeaderMap::new();
    let Some(headers) = headers else {
        return Ok(map);
    };
    if headers.len() > HTTP_MAX_HEADERS {
        return Err(err("invalid_header", "Too many request headers."));
    }
    let mut total = 0usize;
    for (name, value) in headers {
        total += name.len() + value.len();
        if total > HTTP_MAX_HEADER_BYTES {
            return Err(err("invalid_header", "The request headers are too large."));
        }
        if header_is_forbidden(name) {
            return Err(err("invalid_header", "A request header is not allowed."));
        }
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| err("invalid_header", "A request header name is not valid."))?;
        let mut value = reqwest::header::HeaderValue::from_str(value)
            .map_err(|_| err("invalid_header", "A request header value is not valid."))?;
        value.set_sensitive(true);
        map.insert(name, value);
    }
    Ok(map)
}

/// Same origin as the original request (scheme, host, port) — the only
/// redirect we follow, so credentials never travel to another host.
fn same_origin(a: &reqwest::Url, b: &reqwest::Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

fn caused_by<T: std::error::Error + 'static>(e: &reqwest::Error) -> bool {
    use std::error::Error as _;
    let mut cur = e.source();
    while let Some(inner) = cur {
        if inner.is::<T>() {
            return true;
        }
        cur = inner.source();
    }
    false
}

fn map_reqwest_error(e: &reqwest::Error) -> ModelListError {
    // Never `e.to_string()`: reqwest embeds the URL (and so any `?key=`).
    if caused_by::<BlockedAddress>(e) {
        err("blocked_host", "This host is not allowed.")
    } else if caused_by::<LookupBusy>(e) {
        busy()
    } else if e.is_timeout() {
        err("timeout", "The request timed out.")
    } else if e.is_connect() {
        err("connect_failed", "Could not connect to the server.")
    } else if e.is_redirect() {
        err("redirect_blocked", "The server redirected the request.")
    } else {
        err("request_failed", "The request failed.")
    }
}

/// Core of [`ai_http_get_json`], with the limits as parameters so the tests can
/// shrink them.
async fn get_json(
    request: GetJsonRequest,
    max_body: usize,
    default_timeout_ms: u64,
    resolver: Arc<FilteringResolver>,
    slots: &Semaphore,
) -> Result<GetJsonResponse, ModelListError> {
    limited(
        slots,
        get_json_unlimited(request, max_body, default_timeout_ms, resolver),
    )
    .await
}

async fn get_json_unlimited(
    request: GetJsonRequest,
    max_body: usize,
    default_timeout_ms: u64,
    resolver: Arc<FilteringResolver>,
) -> Result<GetJsonResponse, ModelListError> {
    let url = validate_url(&request.url)?;
    let mut headers = build_headers(request.headers.as_ref())?;
    headers
        .entry(reqwest::header::ACCEPT)
        .or_insert(reqwest::header::HeaderValue::from_static(
            "application/json",
        ));
    let timeout_ms = request
        .timeout_ms
        .unwrap_or(default_timeout_ms)
        .clamp(1, HTTP_MAX_TIMEOUT_MS);

    let origin = url.clone();
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= HTTP_MAX_REDIRECTS || !same_origin(attempt.url(), &origin) {
            // `stop` hands back the 3xx response, which we map to an error.
            attempt.stop()
        } else {
            attempt.follow()
        }
    });
    // `no_proxy()`: a proxy (HTTP(S)_PROXY / system settings) would dial the
    // destination itself and bypass `resolver`, so the address policy would not
    // describe the real connection.
    let client = reqwest::Client::builder()
        .no_proxy()
        .dns_resolver(resolver)
        .redirect(policy)
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .map_err(|_| err("request_failed", "The request failed."))?;

    let response = client
        .get(url)
        .headers(headers)
        .send()
        .await
        .map_err(|e| map_reqwest_error(&e))?;

    let status = response.status();
    if status.is_redirection() {
        return Err(err(
            "redirect_blocked",
            "The server redirected the request.",
        ));
    }
    if response
        .content_length()
        .is_some_and(|len| len > max_body as u64)
    {
        return Err(err("too_large", "The response is too large."));
    }

    let mut stream = response.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| map_reqwest_error(&e))?;
        if buf.len() + bytes.len() > max_body {
            return Err(err("too_large", "The response is too large."));
        }
        buf.extend_from_slice(&bytes);
    }
    Ok(GetJsonResponse {
        status: status.as_u16(),
        body: String::from_utf8_lossy(&buf).into_owned(),
    })
}

/// Bounded `GET` of a JSON document at `request.url` (models list endpoints).
/// Redirects to another origin, non-http(s) schemes, oversized or slow
/// responses are refused with a typed error; headers and bodies are never
/// logged.
///
/// `request` arrives as a generic value and is decoded here: a typed argument
/// would be decoded by Tauri first, and its rejection carries serde's message
/// (which can quote the payload) instead of a fixed error.
///
/// Known, accepted gap: a *binary* IPC body is rejected by Tauri before this
/// handler runs, with the framework's own text. That text names the command and
/// the argument, never a byte of the payload, and the TypeScript wrapper turns
/// any rejection that is not a typed `{code, message}` into its fixed message,
/// so nothing from the payload reaches the UI.
#[tauri::command]
pub async fn ai_http_get_json(
    request: Option<serde_json::Value>,
) -> Result<GetJsonResponse, ModelListError> {
    let request: GetJsonRequest = request
        .and_then(|v| serde_json::from_value(v).ok())
        .ok_or_else(invalid_request)?;
    get_json(
        request,
        HTTP_MAX_BODY_BYTES,
        HTTP_DEFAULT_TIMEOUT_MS,
        FilteringResolver::system(),
        &HTTP_SLOTS,
    )
    .await
}

// ── CLI `models` ────────────────────────────────────────────────────────────

/// Map the Markdraw provider id the webview sends to the CLI provider kind that
/// `cli_agent` resolves binaries by. Anything else is refused — the webview
/// cannot name a binary or an argument.
fn cli_kind_for_provider_id(provider: &str) -> Result<&'static str, ModelListError> {
    match provider {
        "grok-sub" => Ok("grok-cli"),
        "antigravity-sub" => Ok("antigravity-cli"),
        _ => Err(err("unknown_provider", "Unknown CLI provider.")),
    }
}

/// The whole process tree of one CLI run, so that "the CLI is stopped" means
/// the CLI AND whatever it started, not just the direct child.
///
/// * Unix: the CLI is spawned as leader of its own process group
///   (`process_group(0)`); [`ProcessTree::kill`] SIGKILLs the group.
/// * Windows: a Job Object with `KILL_ON_JOB_CLOSE`. The CLI is created
///   suspended, assigned to the job and only then resumed, so it cannot create a
///   descendant before the job owns it; [`ProcessTree::kill`] terminates the job
///   and closing the handle (drop) does too.
///
/// Dropping the guard kills the tree, so a cancelled future cleans up as well.
/// `kill` is idempotent.
///
/// Reach of the guarantee: the *process group* (Unix) or the *job* (Windows). A
/// CLI that deliberately detaches a helper into another session (`setsid`) or
/// another group is outside it; the CLIs this module runs are the two known
/// subscription CLIs and are assumed not to do that.
///
/// Group-id identity (Unix): a process-group id is only guaranteed not to be
/// reused while some member of the group — the leader, alive or zombie, included
/// — still exists. So `killpg` is sent only while the leader has NOT been
/// collected. Every path honours that:
///
/// * timeout, oversized stdout, read error, cancellation: the leader is
///   uncollected (alive or zombie) and the group is signalled;
/// * the CLI exits by itself (success or error status): [`leader_exited`]
///   observes the exit WITHOUT collecting it (`waitid(WNOWAIT)`), the group is
///   signalled while the zombie leader still reserves the id, and only then does
///   `Child::wait` (the single collector) reap it, so a helper the CLI left
///   behind does not outlive the call;
/// * once the leader is collected, or when its state cannot be observed,
///   [`ProcessTree::leader_collected`] drops the id and nothing is signalled any
///   more: the group may be empty and its number recycled by an unrelated
///   process.
struct ProcessTree {
    #[cfg(unix)]
    pgid: Option<libc::pid_t>,
    /// The group-kill syscall; a field only so tests can record the calls.
    #[cfg(unix)]
    killpg: fn(libc::pid_t),
    #[cfg(windows)]
    job: job::Job,
    killed: bool,
}

#[cfg(unix)]
fn real_killpg(pgid: libc::pid_t) {
    // SAFETY: plain syscall; callers pass the group this tree created and only
    // while its leader is still uncollected (see [`ProcessTree`]).
    unsafe {
        libc::killpg(pgid, libc::SIGKILL);
    }
}

impl ProcessTree {
    fn new() -> std::io::Result<Self> {
        Ok(Self {
            #[cfg(unix)]
            pgid: None,
            #[cfg(unix)]
            killpg: real_killpg,
            #[cfg(windows)]
            job: job::Job::new()?,
            killed: false,
        })
    }

    /// A tree whose group kills go through `killpg` (tests only).
    #[cfg(all(unix, test))]
    fn with_killpg(killpg: fn(libc::pid_t)) -> Self {
        let mut tree = Self::new().expect("a Unix tree has nothing to create");
        tree.killpg = killpg;
        tree
    }

    /// Configure `cmd` so the spawned process leads (Unix) or is held for (Windows)
    /// this tree.
    fn configure(cmd: &mut Command) {
        #[cfg(unix)]
        cmd.process_group(0);
        #[cfg(windows)]
        cmd.creation_flags(job::CREATE_NO_WINDOW | job::CREATE_SUSPENDED);
        #[cfg(not(any(unix, windows)))]
        let _ = cmd;
    }

    /// Take ownership of the freshly spawned `child`. Fails closed: on error the
    /// caller must kill the child.
    fn attach(&mut self, child: &tokio::process::Child) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            self.pgid = child.id().map(|id| id as libc::pid_t);
            Ok(())
        }
        #[cfg(windows)]
        {
            let handle = child
                .raw_handle()
                .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotFound))?;
            self.job.adopt_and_resume(handle)
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = child;
            Ok(())
        }
    }

    /// The direct child (the group leader) has been collected, or its state could
    /// not be observed: its group id no longer proves anything, so the group is
    /// never signalled again. A Windows
    /// job is a handle, not a number, and stays killable.
    fn leader_collected(&mut self) {
        #[cfg(unix)]
        {
            self.pgid = None;
        }
    }

    fn kill(&mut self) {
        if std::mem::replace(&mut self.killed, true) {
            return;
        }
        #[cfg(unix)]
        if let Some(pgid) = self.pgid {
            (self.killpg)(pgid);
        }
        #[cfg(windows)]
        self.job.terminate();
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Block until the process `pid` — a child of this process — has exited, WITHOUT
/// collecting it: the zombie stays, so its pid (and the group id it leads) stays
/// reserved. `true` once the exit is observed; `false` when it cannot be (the
/// child was already collected, `ECHILD`), in which case the group id proves
/// nothing and the caller must not signal it. Only `waitid` with `WEXITED |
/// WNOWAIT`, available in `libc` on Linux and macOS.
#[cfg(unix)]
fn leader_exited_blocking(pid: libc::pid_t) -> bool {
    loop {
        // SAFETY: an all-zero `siginfo_t` is a valid value and `waitid` only
        // writes into it.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        // SAFETY: plain syscall on a live out-pointer; `WNOWAIT` leaves the
        // child collectable.
        let rc = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOWAIT,
            )
        };
        if rc == 0 {
            return true;
        }
        if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return false;
        }
    }
}

/// [`leader_exited_blocking`] on the blocking pool. Dropping the future (a
/// cancelled call) leaves that thread waiting until the leader dies, which the
/// group kill of the dropped [`ProcessTree`] guarantees.
#[cfg(unix)]
async fn leader_exited(pid: libc::pid_t) -> bool {
    tokio::task::spawn_blocking(move || leader_exited_blocking(pid))
        .await
        .unwrap_or(false)
}

/// Windows Job Object plumbing, declared against kernel32/ntdll directly: the
/// crate's `windows-sys` features do not include `Win32_System_JobObjects`.
/// Struct layouts are checked against `windows-sys` in the module's tests.
#[cfg(windows)]
mod job {
    use std::ffi::c_void;

    pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    pub const CREATE_SUSPENDED: u32 = 0x0000_0004;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;

    type Handle = *mut c_void;

    #[repr(C)]
    struct BasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    struct IoCounters {
        counters: [u64; 6],
    }

    #[repr(C)]
    struct ExtendedLimitInformation {
        basic: BasicLimitInformation,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            class: i32,
            info: *const c_void,
            length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn TerminateJobObject(job: Handle, exit_code: u32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtResumeProcess(process: Handle) -> i32;
    }

    pub struct Job(Handle);

    // SAFETY: a job handle is a process-wide kernel handle usable from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new() -> std::io::Result<Self> {
            // SAFETY: null attributes/name are documented as valid.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let job = Job(handle);
            let mut info: ExtendedLimitInformation = unsafe { std::mem::zeroed() };
            info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // SAFETY: `info` is a live, correctly laid out structure of the
            // stated length.
            let ok = unsafe {
                SetInformationJobObject(
                    job.0,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                    (&raw const info).cast(),
                    std::mem::size_of::<ExtendedLimitInformation>() as u32,
                )
            };
            if ok == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(job)
        }

        /// Put the suspended process in the job, then let it run.
        pub fn adopt_and_resume(&self, process: Handle) -> std::io::Result<()> {
            // SAFETY: both handles are live; `process` is owned by the caller's
            // `Child`.
            if unsafe { AssignProcessToJobObject(self.0, process) } == 0 {
                return Err(std::io::Error::last_os_error());
            }
            // SAFETY: as above. NtResumeProcess resumes every suspended thread of
            // the process (the one `CREATE_SUSPENDED` left behind).
            if unsafe { NtResumeProcess(process) } < 0 {
                return Err(std::io::Error::from(std::io::ErrorKind::Other));
            }
            Ok(())
        }

        pub fn terminate(&self) {
            // SAFETY: live job handle.
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // KILL_ON_JOB_CLOSE terminates whatever is still in the job.
            // SAFETY: the handle is owned by this value and closed once.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// Run `<binary> models` (fixed argv, stdin closed, stderr discarded) and
/// return its stdout, bounded in time and size. On timeout, oversized stdout
/// and cancellation the CLI's process tree is killed while the direct child is
/// still uncollected, and the direct child is then awaited. When the CLI exits
/// by itself (success or not) its exit is observed without collecting it, the
/// tree is killed, and only then is the direct child collected, see
/// [`ProcessTree`].
///
/// Shell exception (documented, not a gap): `binary` comes from
/// `cli_agent::resolve_cli_path`, the same discovery the CLI chat uses. On Unix
/// that may probe PATH once through the user's login shell (`shell -lc`, bounded
/// and group-killed by `cli_agent`) before this deadline starts; on Windows a
/// shim found through `PATHEXT` can be a `.cmd`/`.bat`, which the OS runs via
/// `cmd.exe`. The webview chooses neither the script, the binary nor argv.
async fn run_models_command(
    binary: &str,
    max_stdout: usize,
    timeout: Duration,
) -> Result<String, ModelListError> {
    let tree =
        ProcessTree::new().map_err(|_| err("cli_spawn_failed", "Could not start the CLI."))?;
    run_models_command_in(binary, max_stdout, timeout, tree).await
}

async fn run_models_command_in(
    binary: &str,
    max_stdout: usize,
    timeout: Duration,
    mut tree: ProcessTree,
) -> Result<String, ModelListError> {
    let spawn_failed = || err("cli_spawn_failed", "Could not start the CLI.");
    let mut cmd = Command::new(binary);
    cmd.arg("models")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        // stderr can carry tokens; never capture it.
        .stderr(Stdio::null())
        .env("PATH", cli_path_env_for(binary))
        .kill_on_drop(true);
    ProcessTree::configure(&mut cmd);

    let mut child = cmd.spawn().map_err(|_| spawn_failed())?;
    if tree.attach(&child).is_err() {
        let _ = child.start_kill();
        return Err(spawn_failed());
    }
    // Moved AFTER `child` on purpose: locals drop in reverse order (and the
    // parameter `tree` would drop after every local), so when this future is
    // cancelled `group` kills the process group first, while the leader is still
    // uncollected, and only then does `child`'s drop (which reaps a leader that
    // already exited) run.
    let mut group = tree;
    let Some(stdout) = child.stdout.take() else {
        group.kill();
        let _ = child.wait().await;
        return Err(spawn_failed());
    };

    // `(outcome, leader_collected)`. `child.wait()` collects the leader in the
    // same poll that returns, so the flag is exact: true only after `wait`
    // returned (whatever it returned: after an error the leader's state is
    // unknown and signalling its group is the unsafe guess).
    let work = async {
        let mut buf: Vec<u8> = Vec::new();
        // +1 so "exactly at the limit" and "over it" are distinguishable.
        let mut limited = stdout.take(max_stdout as u64 + 1);
        if limited.read_to_end(&mut buf).await.is_err() {
            return (Err(err("cli_failed", "The CLI failed.")), false);
        }
        if buf.len() > max_stdout {
            return (Err(err("too_large", "The CLI output is too large.")), false);
        }
        // Unix: the CLI exited by itself. Observe that without collecting the
        // leader, signal the group while the zombie still reserves its id, and
        // only then let `wait` (the single collector) reap it. If the exit cannot
        // be observed the id is not trusted and nothing is signalled.
        #[cfg(unix)]
        {
            let exited = match child.id() {
                Some(pid) => leader_exited(pid as libc::pid_t).await,
                None => false,
            };
            if exited {
                group.kill();
            } else {
                group.leader_collected();
            }
        }
        let outcome = match child.wait().await {
            Ok(status) if status.success() => Ok(String::from_utf8_lossy(&buf).into_owned()),
            Ok(_) => Err(err("cli_failed", "The CLI exited with an error.")),
            Err(_) => Err(err("cli_failed", "The CLI failed.")),
        };
        (outcome, true)
    };
    let (outcome, collected) = match tokio::time::timeout(timeout, work).await {
        Ok(done) => done,
        Err(_) => (Err(err("timeout", "The CLI timed out.")), false),
    };
    if collected {
        group.leader_collected();
    }
    // Uncollected leader (timeout, oversized stdout, read error): the group id is
    // still reserved by the leader, alive or zombie, so killing the group is
    // safe. Then await the leader (instant after the kill; bounded in case it
    // is not).
    group.kill();
    if !collected {
        let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    }
    outcome
}

/// List the models a subscription CLI reports (`grok models` / `agy models`).
/// `provider` must be the string `grok-sub` or `antigravity-sub`; it arrives as
/// a generic value and is checked here (see [`ai_http_get_json`]).
#[tauri::command]
pub async fn cli_list_models(
    provider: Option<serde_json::Value>,
) -> Result<String, ModelListError> {
    let provider = provider
        .as_ref()
        .and_then(|v| v.as_str())
        .ok_or_else(invalid_request)?;
    let kind = cli_kind_for_provider_id(provider)?;
    debug_assert!(binary_for_provider(kind).is_ok());
    limited(&CLI_SLOTS, async {
        // See the shell exception documented on `run_models_command`.
        let binary = resolve_cli_path(kind, None)
            .map_err(|_| err("cli_not_found", "The CLI was not found on PATH."))?;
        run_models_command(&binary, CLI_MAX_STDOUT_BYTES, CLI_TIMEOUT).await
    })
    .await
}

// ── Codex models cache ──────────────────────────────────────────────────────

/// The model fields of one `models_cache.json` entry — nothing else is
/// forwarded.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexModel {
    pub slug: String,
    pub display_name: Option<String>,
    pub context_window: Option<u64>,
    pub visibility: Option<String>,
    pub default_reasoning_level: Option<String>,
    pub reasoning_efforts: Vec<String>,
}

fn malformed() -> ModelListError {
    err("malformed", "The Codex model cache is not valid.")
}

fn short_string(v: &serde_json::Value) -> Result<String, ModelListError> {
    let s = v.as_str().ok_or_else(malformed)?;
    if s.chars().count() > CODEX_MAX_FIELD_CHARS {
        return Err(malformed());
    }
    Ok(s.to_string())
}

fn optional_string(
    obj: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<Option<String>, ModelListError> {
    match obj.get(key) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(v) => short_string(v).map(Some),
    }
}

/// Extract the model fields from the cache file's text. The whole document is
/// rejected on any structural problem (no partial results).
fn parse_codex_models(text: &str) -> Result<Vec<CodexModel>, ModelListError> {
    let root: serde_json::Value = serde_json::from_str(text).map_err(|_| malformed())?;
    let models = root
        .get("models")
        .and_then(|m| m.as_array())
        .ok_or_else(malformed)?;
    if models.len() > CODEX_MAX_MODELS {
        return Err(malformed());
    }
    let mut out = Vec::with_capacity(models.len());
    for entry in models {
        let obj = entry.as_object().ok_or_else(malformed)?;
        let slug = short_string(obj.get("slug").ok_or_else(malformed)?)?;
        if slug.is_empty() {
            return Err(malformed());
        }
        let context_window = match obj.get("context_window") {
            None | Some(serde_json::Value::Null) => None,
            Some(v) => Some(v.as_u64().ok_or_else(malformed)?),
        };
        let reasoning_efforts = match obj.get("supported_reasoning_levels") {
            None | Some(serde_json::Value::Null) => Vec::new(),
            Some(v) => {
                let levels = v.as_array().ok_or_else(malformed)?;
                if levels.len() > 32 {
                    return Err(malformed());
                }
                let mut efforts = Vec::with_capacity(levels.len());
                for level in levels {
                    let effort = level.get("effort").ok_or_else(malformed)?;
                    efforts.push(short_string(effort)?);
                }
                efforts
            }
        };
        out.push(CodexModel {
            slug,
            display_name: optional_string(obj, "display_name")?,
            context_window,
            visibility: optional_string(obj, "visibility")?,
            default_reasoning_level: optional_string(obj, "default_reasoning_level")?,
            reasoning_efforts,
        });
    }
    Ok(out)
}

/// Read at most `limit` bytes of UTF-8 text from `reader`; one byte more is
/// `too_large`. Pure over `Read` so an endless or growing source is testable.
fn read_text_bounded<R: std::io::Read>(reader: R, limit: u64) -> Result<String, ModelListError> {
    use std::io::Read;
    let mut text = String::new();
    reader
        .take(limit + 1)
        .read_to_string(&mut text)
        .map_err(|_| err("read_failed", "Could not read the Codex model cache."))?;
    if text.len() as u64 > limit {
        return Err(err("too_large", "The Codex model cache is too large."));
    }
    Ok(text)
}

fn read_failed() -> ModelListError {
    err("read_failed", "Could not read the Codex model cache.")
}

fn not_found() -> ModelListError {
    err("not_found", "The Codex model cache does not exist.")
}

/// Opening `<home>/.codex/models_cache.json` without ever following a link.
///
/// `home` itself is opened normally (a user's home may legitimately sit behind
/// a link, e.g. `/home -> /var/home`); `.codex` and `models_cache.json` are each
/// opened RELATIVE to the directory handle of the level above, refusing a link
/// at either level, so neither component can be swapped for a link between a
/// check and the open. The returned handle is what gets validated and read.
#[cfg(unix)]
mod confined_open {
    use std::ffi::CString;
    use std::fs::File;
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    fn at(parent: &File, name: &str, flags: libc::c_int) -> io::Result<File> {
        let name = CString::new(name)?;
        // SAFETY: `parent` is a live descriptor and `name` a NUL-terminated
        // string; the returned descriptor is owned by the `File` built below.
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | flags,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `fd` is a fresh descriptor nobody else owns.
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    pub fn open_cache(home: &Path) -> io::Result<File> {
        let path = CString::new(home.as_os_str().as_bytes())?;
        // SAFETY: NUL-terminated path; the descriptor is wrapped right away.
        let fd = unsafe {
            libc::open(
                path.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `fd` is a fresh descriptor nobody else owns.
        let home = unsafe { File::from_raw_fd(fd) };
        let codex = at(&home, ".codex", libc::O_DIRECTORY)?;
        // NONBLOCK: opening a FIFO or device must not wait for a peer before the
        // caller's regular-file check on the handle rejects it.
        at(&codex, "models_cache.json", libc::O_NONBLOCK)
    }
}

#[cfg(windows)]
mod confined_open {
    use std::ffi::c_void;
    use std::fs::File;
    use std::io;
    use std::os::windows::{
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle},
    };
    use std::path::Path;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_BACKUP_SEMANTICS,
    };

    #[repr(C)]
    struct Unicode {
        length: u16,
        maximum: u16,
        buffer: *mut u16,
    }
    #[repr(C)]
    struct Attributes {
        length: u32,
        root: *mut c_void,
        name: *mut Unicode,
        flags: u32,
        security: *mut c_void,
        qos: *mut c_void,
    }
    #[repr(C)]
    struct Status {
        status: usize,
        information: usize,
    }
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtCreateFile(
            handle: *mut *mut c_void,
            access: u32,
            attrs: *mut Attributes,
            status: *mut Status,
            size: *mut i64,
            file_attrs: u32,
            share: u32,
            disposition: u32,
            options: u32,
            ea: *mut c_void,
            ea_len: u32,
        ) -> i32;
    }

    /// Refuse a reparse point (symlink, junction, mount point, ...) and anything
    /// that is neither a file nor a directory.
    fn checked(file: File) -> io::Result<File> {
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: live handle and a properly sized out structure.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let kind = file.metadata()?.file_type();
        if !kind.is_dir() && !kind.is_file() {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        Ok(file)
    }

    /// Open `name` relative to the directory handle `parent`, as the link itself
    /// (FILE_OPEN_REPARSE_POINT), then reject it if it is one.
    fn child(parent: &File, name: &str) -> io::Result<File> {
        let mut wide: Vec<u16> = name.encode_utf16().collect();
        let length = u16::try_from(wide.len() * 2).map_err(|_| io::ErrorKind::InvalidInput)?;
        let mut unicode = Unicode {
            length,
            maximum: length,
            buffer: wide.as_mut_ptr(),
        };
        let mut attrs = Attributes {
            length: std::mem::size_of::<Attributes>() as u32,
            root: parent.as_raw_handle(),
            name: &mut unicode,
            flags: 0x40, // OBJ_CASE_INSENSITIVE
            security: std::ptr::null_mut(),
            qos: std::ptr::null_mut(),
        };
        let mut status = Status {
            status: 0,
            information: 0,
        };
        let mut handle = std::ptr::null_mut();
        // FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT; access is
        // SYNCHRONIZE | FILE_READ_ATTRIBUTES | FILE_READ_DATA.
        // SAFETY: every pointer refers to a live local; `wide` outlives the call.
        let code = unsafe {
            NtCreateFile(
                &mut handle,
                0x0010_0081,
                &mut attrs,
                &mut status,
                std::ptr::null_mut(),
                0,
                7,
                1,
                0x0020_0020,
                std::ptr::null_mut(),
                0,
            )
        };
        if code < 0 {
            // STATUS_OBJECT_NAME_NOT_FOUND / STATUS_OBJECT_PATH_NOT_FOUND / NO_SUCH_FILE
            return Err(match code as u32 {
                0xC000_000F | 0xC000_0034 | 0xC000_003A => io::ErrorKind::NotFound,
                _ => io::ErrorKind::PermissionDenied,
            }
            .into());
        }
        // SAFETY: NtCreateFile returned a fresh handle that nobody else owns.
        checked(unsafe { File::from_raw_handle(handle) })
    }

    pub fn open_cache(home: &Path) -> io::Result<File> {
        // The home directory itself may sit behind a link; open it as a directory.
        let home = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(home)?;
        let codex = child(&home, ".codex")?;
        if !codex.metadata()?.is_dir() {
            return Err(io::ErrorKind::NotADirectory.into());
        }
        child(&codex, "models_cache.json")
    }
}

#[cfg(not(any(unix, windows)))]
mod confined_open {
    use std::fs::File;
    use std::io;
    use std::path::Path;

    pub fn open_cache(_home: &Path) -> io::Result<File> {
        Err(io::ErrorKind::Unsupported.into())
    }
}

/// Read `<home>/.codex/models_cache.json` — that exact path, nothing else under
/// `~/.codex` — and return the model fields. Links in either component and
/// non-regular files are refused (`read_failed`); the size, type and byte limit
/// are applied to the handle that is read.
fn read_codex_models(home: &Path) -> Result<Vec<CodexModel>, ModelListError> {
    let file = confined_open::open_cache(home).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            not_found()
        } else {
            read_failed()
        }
    })?;
    let meta = file.metadata().map_err(|_| read_failed())?;
    if !meta.is_file() {
        return Err(read_failed());
    }
    if meta.len() > CODEX_MAX_FILE_BYTES {
        return Err(err("too_large", "The Codex model cache is too large."));
    }
    // The bound also holds if the file grows after the size check above.
    let text = read_text_bounded(file, CODEX_MAX_FILE_BYTES)?;
    parse_codex_models(&text)
}

/// [`read_codex_models`] on a blocking thread under `slots`. The permit moves
/// into the blocking closure, so it is held until the read really ends, even if
/// the caller stops waiting.
async fn read_codex_models_limited(
    home: std::path::PathBuf,
    slots: &'static Semaphore,
) -> Result<Vec<CodexModel>, ModelListError> {
    let permit = slots.try_acquire().map_err(|_| busy())?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        read_codex_models(&home)
    })
    .await
    .map_err(|_| read_failed())?
}

/// The Codex CLI's own model list (`~/.codex/models_cache.json`), reduced to
/// the model fields. Never reads `auth.json` or any other file.
#[tauri::command]
pub async fn codex_models_cache<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<CodexModel>, ModelListError> {
    let home = app
        .path()
        .home_dir()
        .map_err(|_| err("no_home", "Could not resolve the home directory."))?;
    read_codex_models_limited(home, &CACHE_SLOTS).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::Read;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const MARKER: &str = "SECRET-MARKER-9f3a1c";

    /// A one-connection-at-a-time raw HTTP server. `handler` gets the raw
    /// request text and returns the full raw response bytes; the returned
    /// counter is how many requests it served.
    async fn serve<F>(handler: F) -> (u16, Arc<AtomicUsize>)
    where
        F: Fn(String) -> Vec<u8> + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        let handler = Arc::new(handler);
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let handler = handler.clone();
                let counter = counter.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    counter.fetch_add(1, Ordering::SeqCst);
                    let req = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let resp = handler(req);
                    let _ = sock.write_all(&resp).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        (port, hits)
    }

    fn ok_json(body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .into_bytes()
    }

    fn req(url: &str) -> GetJsonRequest {
        GetJsonRequest {
            url: url.to_string(),
            headers: None,
            timeout_ms: None,
        }
    }

    async fn get_with(
        r: GetJsonRequest,
        max_body: usize,
        timeout_ms: u64,
    ) -> Result<GetJsonResponse, ModelListError> {
        get_json(
            r,
            max_body,
            timeout_ms,
            FilteringResolver::system(),
            &Semaphore::new(HTTP_MAX_CONCURRENT),
        )
        .await
    }

    async fn get(r: GetJsonRequest) -> Result<GetJsonResponse, ModelListError> {
        get_with(r, HTTP_MAX_BODY_BYTES, 5_000).await
    }

    /// A resolver whose "DNS" is the given table; unknown names fail the lookup.
    fn fake_dns(table: &[(&str, &[&str])]) -> Arc<FilteringResolver> {
        let table: HashMap<String, Vec<SocketAddr>> = table
            .iter()
            .map(|(name, ips)| {
                (
                    name.to_string(),
                    ips.iter()
                        .map(|ip| SocketAddr::new(ip.parse().unwrap(), 0))
                        .collect(),
                )
            })
            .collect();
        Arc::new(FilteringResolver {
            lookup: Arc::new(move |host| {
                let found = table.get(&host).cloned();
                Box::pin(async move {
                    found.ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotFound))
                })
            }),
        })
    }

    async fn get_via(
        resolver: Arc<FilteringResolver>,
        r: GetJsonRequest,
    ) -> Result<GetJsonResponse, ModelListError> {
        get_json(
            r,
            HTTP_MAX_BODY_BYTES,
            5_000,
            resolver,
            &Semaphore::new(HTTP_MAX_CONCURRENT),
        )
        .await
    }

    // ── HTTP ──

    #[tokio::test]
    async fn get_json_returns_status_and_body_and_sends_headers() {
        let (port, _) = serve(|raw| {
            let lower = raw.to_ascii_lowercase();
            assert!(lower.starts_with("get /v1/models "));
            assert!(lower.contains("x-api-key: k-123"));
            assert!(lower.contains("accept: application/json"));
            ok_json(r#"{"data":[{"id":"m1"}]}"#)
        })
        .await;
        let mut r = req(&format!("http://127.0.0.1:{port}/v1/models"));
        r.headers = Some(HashMap::from([("x-api-key".into(), "k-123".into())]));
        let resp = get(r).await.unwrap();
        assert_eq!(resp.status, 200);
        assert_eq!(resp.body, r#"{"data":[{"id":"m1"}]}"#);
    }

    #[tokio::test]
    async fn get_json_passes_non_2xx_status_through() {
        let (port, _) = serve(|_| {
            b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
                .to_vec()
        })
        .await;
        let resp = get(req(&format!("http://127.0.0.1:{port}/m")))
            .await
            .unwrap();
        assert_eq!(resp.status, 401);
    }

    #[tokio::test]
    async fn get_json_rejects_non_http_schemes_without_connecting() {
        for url in [
            "file:///etc/passwd",
            "ftp://127.0.0.1/models",
            "javascript:alert(1)",
            "data:application/json,{}",
            "ws://127.0.0.1:1/x",
        ] {
            let e = get(req(url)).await.unwrap_err();
            assert!(
                e.code == "unsupported_scheme" || e.code == "invalid_url",
                "{url} -> {e:?}"
            );
        }
        assert_eq!(
            get(req("file:///etc/passwd")).await.unwrap_err().code,
            "unsupported_scheme"
        );
    }

    #[tokio::test]
    async fn get_json_rejects_malformed_urls_credentials_and_metadata_ip() {
        assert_eq!(get(req("not a url")).await.unwrap_err().code, "invalid_url");
        assert_eq!(get(req("")).await.unwrap_err().code, "invalid_url");
        assert_eq!(
            get(req("http://user:pw@127.0.0.1:1/x"))
                .await
                .unwrap_err()
                .code,
            "invalid_url"
        );
        assert_eq!(
            get(req("http://169.254.169.254/latest/meta-data"))
                .await
                .unwrap_err()
                .code,
            "blocked_host"
        );
        assert_eq!(
            get(req("http://[fe80::1]/x")).await.unwrap_err().code,
            "blocked_host"
        );
        let long = format!("http://127.0.0.1:1/{}", "a".repeat(HTTP_MAX_URL_BYTES));
        assert_eq!(get(req(&long)).await.unwrap_err().code, "invalid_url");
    }

    #[tokio::test]
    async fn get_json_allows_loopback_for_local_servers() {
        // LM Studio / Ollama live on localhost, so loopback must stay reachable.
        let (port, _) = serve(|_| ok_json("{}")).await;
        assert!(get(req(&format!("http://127.0.0.1:{port}/m")))
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn get_json_refuses_redirect_to_another_host_and_never_contacts_it() {
        let (target_port, target_hits) = serve(|_| ok_json("{}")).await;
        // Same server, different host name: 127.0.0.1 redirects to `localhost`.
        let location = format!("http://localhost:{target_port}/steal");
        let (port, _) = serve(move |_| {
            format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .into_bytes()
        })
        .await;
        let mut r = req(&format!("http://127.0.0.1:{port}/m"));
        r.headers = Some(HashMap::from([(
            "authorization".into(),
            format!("Bearer {MARKER}"),
        )]));
        let e = get(r).await.unwrap_err();
        assert_eq!(e.code, "redirect_blocked");
        assert_eq!(
            target_hits.load(Ordering::SeqCst),
            0,
            "other host was contacted"
        );
        assert!(!format!("{e:?}").contains(MARKER));
    }

    #[tokio::test]
    async fn get_json_refuses_redirect_to_another_port_and_scheme_change() {
        let (other_port, other_hits) = serve(|_| ok_json("{}")).await;
        let location = format!("http://127.0.0.1:{other_port}/x");
        let (port, _) = serve(move |_| {
            format!("HTTP/1.1 301 Moved\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .into_bytes()
        })
        .await;
        let e = get(req(&format!("http://127.0.0.1:{port}/m")))
            .await
            .unwrap_err();
        assert_eq!(e.code, "redirect_blocked");
        assert_eq!(other_hits.load(Ordering::SeqCst), 0);
        // https downgrade/upgrade on the same host is a different origin too.
        let (port2, _) = serve(move |_| {
            b"HTTP/1.1 301 Moved\r\nLocation: https://127.0.0.1:1/x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
        })
        .await;
        let e = get(req(&format!("http://127.0.0.1:{port2}/m")))
            .await
            .unwrap_err();
        assert_eq!(e.code, "redirect_blocked");
    }

    #[tokio::test]
    async fn get_json_follows_same_origin_redirect() {
        let (port, hits) = serve(|raw| {
            if raw.starts_with("GET /old ") {
                b"HTTP/1.1 302 Found\r\nLocation: /new\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
            } else {
                ok_json(r#"{"ok":true}"#)
            }
        })
        .await;
        let resp = get(req(&format!("http://127.0.0.1:{port}/old")))
            .await
            .unwrap();
        assert_eq!(resp.body, r#"{"ok":true}"#);
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn get_json_stops_redirect_loops() {
        let (port, _) = serve(|_| {
            b"HTTP/1.1 302 Found\r\nLocation: /again\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
        })
        .await;
        let e = get(req(&format!("http://127.0.0.1:{port}/m")))
            .await
            .unwrap_err();
        assert_eq!(e.code, "redirect_blocked");
    }

    #[tokio::test]
    async fn get_json_rejects_oversized_response_by_content_length() {
        let (port, _) = serve(|_| ok_json(&"x".repeat(2_000))).await;
        let e = get_with(req(&format!("http://127.0.0.1:{port}/m")), 1_000, 5_000)
            .await
            .unwrap_err();
        assert_eq!(e.code, "too_large");
    }

    #[tokio::test]
    async fn get_json_rejects_oversized_streamed_body_without_content_length() {
        // No Content-Length (close-delimited): only the running count can stop it.
        let (port, _) = serve(|_| {
            let mut r = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
            r.extend(std::iter::repeat_n(b'x', 5_000));
            r
        })
        .await;
        let e = get_with(req(&format!("http://127.0.0.1:{port}/m")), 1_000, 5_000)
            .await
            .unwrap_err();
        assert_eq!(e.code, "too_large");
    }

    #[tokio::test]
    async fn get_json_rejects_declared_oversize_before_reading_the_body() {
        // Declares 2000 bytes (limit 1000) but never sends them: only the
        // Content-Length check can refuse before the timeout fires.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let _holder = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).await;
            let _ = sock
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2000\r\n\r\n{")
                .await;
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        let e = get_with(req(&format!("http://127.0.0.1:{port}/m")), 1_000, 5_000)
            .await
            .unwrap_err();
        assert_eq!(e.code, "too_large");
    }

    #[tokio::test]
    async fn get_json_accepts_body_exactly_at_the_limit() {
        let (port, _) = serve(|_| ok_json(&"x".repeat(1_000))).await;
        let resp = get_with(req(&format!("http://127.0.0.1:{port}/m")), 1_000, 5_000)
            .await
            .unwrap();
        assert_eq!(resp.body.len(), 1_000);
    }

    #[tokio::test]
    async fn get_json_times_out_on_a_stalled_server() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        // Accept and never answer.
        let _holder = tokio::spawn(async move {
            let (_sock, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        let mut r = req(&format!("http://127.0.0.1:{port}/m"));
        r.timeout_ms = Some(300);
        let started = std::time::Instant::now();
        let e = get(r).await.unwrap_err();
        assert_eq!(e.code, "timeout");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn get_json_times_out_on_a_body_that_stalls_midway() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let _holder = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).await;
            let _ = sock
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{")
                .await;
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        let mut r = req(&format!("http://127.0.0.1:{port}/m"));
        r.timeout_ms = Some(300);
        assert_eq!(get(r).await.unwrap_err().code, "timeout");
    }

    #[tokio::test]
    async fn get_json_connection_refused_error_never_contains_header_or_url_secret() {
        // Bind then drop to get a port nothing listens on.
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };
        let mut r = req(&format!("http://127.0.0.1:{port}/models?key={MARKER}"));
        r.headers = Some(HashMap::from([(
            "Authorization".into(),
            format!("Bearer {MARKER}"),
        )]));
        let e = get(r).await.unwrap_err();
        assert_eq!(e.code, "connect_failed");
        let shown = format!("{e:?} {} {}", e.code, e.message);
        let json = serde_json::to_string(&e).unwrap();
        assert!(!shown.contains(MARKER), "marker leaked in Debug: {shown}");
        assert!(!json.contains(MARKER), "marker leaked in JSON: {json}");
    }

    #[tokio::test]
    async fn get_json_invalid_header_error_never_contains_the_value() {
        let mut r = req("http://127.0.0.1:1/m");
        r.headers = Some(HashMap::from([(
            "Authorization".into(),
            format!("Bearer {MARKER}\r\nX-Injected: 1"),
        )]));
        let e = get(r).await.unwrap_err();
        assert_eq!(e.code, "invalid_header");
        assert!(!serde_json::to_string(&e).unwrap().contains(MARKER));

        let mut r = req("http://127.0.0.1:1/m");
        r.headers = Some(HashMap::from([(format!("bad name {MARKER}"), "v".into())]));
        let e = get(r).await.unwrap_err();
        assert_eq!(e.code, "invalid_header");
        assert!(!serde_json::to_string(&e).unwrap().contains(MARKER));
    }

    #[tokio::test]
    async fn get_json_rejects_forbidden_and_excessive_headers() {
        for name in ["Host", "content-length", "Transfer-Encoding", "Connection"] {
            let mut r = req("http://127.0.0.1:1/m");
            r.headers = Some(HashMap::from([(name.into(), "x".into())]));
            assert_eq!(get(r).await.unwrap_err().code, "invalid_header", "{name}");
        }
        let mut r = req("http://127.0.0.1:1/m");
        r.headers = Some(
            (0..=HTTP_MAX_HEADERS)
                .map(|i| (format!("x-h{i}"), "v".to_string()))
                .collect(),
        );
        assert_eq!(get(r).await.unwrap_err().code, "invalid_header");
        let mut r = req("http://127.0.0.1:1/m");
        r.headers = Some(HashMap::from([(
            "x-big".into(),
            "v".repeat(HTTP_MAX_HEADER_BYTES),
        )]));
        assert_eq!(get(r).await.unwrap_err().code, "invalid_header");
    }

    // ── CLI ──

    #[test]
    fn cli_kind_accepts_only_the_two_provider_ids() {
        assert_eq!(cli_kind_for_provider_id("grok-sub").unwrap(), "grok-cli");
        assert_eq!(
            cli_kind_for_provider_id("antigravity-sub").unwrap(),
            "antigravity-cli"
        );
        for bad in [
            "",
            "grok",
            "grok-cli",
            "claude-sub",
            "codex-sub",
            "bash",
            "/bin/sh",
            "../../bin/sh",
            "grok-sub; rm -rf /",
            "grok-sub models",
            "GROK-SUB",
        ] {
            assert_eq!(
                cli_kind_for_provider_id(bad).unwrap_err().code,
                "unknown_provider",
                "{bad:?}"
            );
        }
    }

    #[tokio::test]
    async fn cli_list_models_command_rejects_unknown_provider_before_resolving() {
        let e = cli_list_models(Some(serde_json::json!("/bin/sh")))
            .await
            .unwrap_err();
        assert_eq!(e.code, "unknown_provider");
    }

    #[cfg(unix)]
    mod cli {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        /// Write an executable fake CLI into `dir`; `body` is the shell script.
        fn fake_cli(dir: &Path, name: &str, body: &str) -> String {
            let path = dir.join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path.to_string_lossy().into_owned()
        }

        async fn run(bin: &str, max: usize, secs: u64) -> Result<String, ModelListError> {
            // A freshly written script can hit ETXTBSY when a sibling test forks
            // concurrently; that is a harness race, not behavior under test.
            for _ in 0..20 {
                match run_models_command(bin, max, Duration::from_secs(secs)).await {
                    Err(e) if e.code == "cli_spawn_failed" => {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                    other => return other,
                }
            }
            run_models_command(bin, max, Duration::from_secs(secs)).await
        }

        #[tokio::test]
        async fn returns_stdout_and_passes_only_the_models_argument() {
            let dir = tempfile::tempdir().unwrap();
            let bin = fake_cli(
                dir.path(),
                "fakecli",
                r#"[ "$#" -eq 1 ] && [ "$1" = "models" ] || exit 7
printf 'Default model: m1\n  * m1 (default)\n  - m2\n'"#,
            );
            let out = run(&bin, 1024, 10).await.unwrap();
            assert_eq!(out, "Default model: m1\n  * m1 (default)\n  - m2\n");
        }

        #[tokio::test]
        async fn missing_binary_is_a_typed_error_not_a_panic() {
            let dir = tempfile::tempdir().unwrap();
            let missing = dir.path().join("nope").to_string_lossy().into_owned();
            let e = run_models_command(&missing, 1024, Duration::from_secs(5))
                .await
                .unwrap_err();
            assert_eq!(e.code, "cli_spawn_failed");
        }

        #[tokio::test]
        async fn hung_cli_times_out_and_is_killed() {
            let dir = tempfile::tempdir().unwrap();
            let marker = dir.path().join("still-alive");
            let bin = fake_cli(
                dir.path(),
                "hang",
                &format!("sleep 3\ntouch '{}'", marker.display()),
            );
            let started = std::time::Instant::now();
            let e = run_models_command(&bin, 1024, Duration::from_millis(400))
                .await
                .unwrap_err();
            assert_eq!(e.code, "timeout");
            assert!(started.elapsed() < Duration::from_secs(3));
            // The shell was killed on drop, so it never reaches `touch`.
            tokio::time::sleep(Duration::from_millis(3_500)).await;
            assert!(!marker.exists(), "hung CLI outlived the timeout");
        }

        #[tokio::test]
        async fn oversized_stdout_is_rejected() {
            let dir = tempfile::tempdir().unwrap();
            let bin = fake_cli(dir.path(), "big", "yes x | head -c 100000");
            let e = run(&bin, 1_000, 10).await.unwrap_err();
            assert_eq!(e.code, "too_large");
        }

        #[tokio::test]
        async fn endless_stdout_is_cut_at_the_limit_not_buffered() {
            let dir = tempfile::tempdir().unwrap();
            let bin = fake_cli(dir.path(), "endless", "yes x");
            let started = std::time::Instant::now();
            let e = run(&bin, 4_096, 10).await.unwrap_err();
            assert_eq!(e.code, "too_large");
            assert!(started.elapsed() < Duration::from_secs(5));
        }

        #[tokio::test]
        async fn stdout_exactly_at_the_limit_is_accepted() {
            let dir = tempfile::tempdir().unwrap();
            let bin = fake_cli(dir.path(), "exact", "head -c 1000 /dev/zero | tr '\\0' a");
            let out = run(&bin, 1_000, 10).await.unwrap();
            assert_eq!(out.len(), 1_000);
        }

        #[tokio::test]
        async fn failing_cli_never_leaks_stderr_or_stdout_into_the_error() {
            let dir = tempfile::tempdir().unwrap();
            let bin = fake_cli(
                dir.path(),
                "fail",
                &format!("echo 'token={MARKER}' >&2\necho 'out={MARKER}'\nexit 3"),
            );
            let e = run(&bin, 1024, 10).await.unwrap_err();
            assert_eq!(e.code, "cli_failed");
            assert!(!serde_json::to_string(&e).unwrap().contains(MARKER));
        }

        #[tokio::test]
        async fn successful_cli_does_not_forward_stderr() {
            let dir = tempfile::tempdir().unwrap();
            let bin = fake_cli(
                dir.path(),
                "noisy",
                &format!("echo 'token={MARKER}' >&2\necho models"),
            );
            let out = run(&bin, 1024, 10).await.unwrap();
            assert_eq!(out, "models\n");
            assert!(!out.contains(MARKER));
        }
    }

    // ── Codex cache ──

    fn home_with_cache(contents: &str) -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".codex")).unwrap();
        std::fs::write(home.path().join(".codex/models_cache.json"), contents).unwrap();
        home
    }

    #[test]
    fn codex_cache_returns_only_the_model_fields() {
        let home = home_with_cache(&format!(
            r#"{{"client_version":"1","etag":"{MARKER}","identity":"{MARKER}","models":[
              {{"slug":"gpt-x","display_name":"GPT X","context_window":272000,"visibility":"list",
                "default_reasoning_level":"medium",
                "supported_reasoning_levels":[{{"effort":"low","description":"d"}},{{"effort":"high","description":"d"}}],
                "model_messages":"{MARKER}","description":"{MARKER}"}},
              {{"slug":"gpt-y"}}]}}"#
        ));
        let models = read_codex_models(home.path()).unwrap();
        assert_eq!(
            models,
            vec![
                CodexModel {
                    slug: "gpt-x".into(),
                    display_name: Some("GPT X".into()),
                    context_window: Some(272000),
                    visibility: Some("list".into()),
                    default_reasoning_level: Some("medium".into()),
                    reasoning_efforts: vec!["low".into(), "high".into()],
                },
                CodexModel {
                    slug: "gpt-y".into(),
                    display_name: None,
                    context_window: None,
                    visibility: None,
                    default_reasoning_level: None,
                    reasoning_efforts: vec![],
                },
            ]
        );
        let json = serde_json::to_string(&models).unwrap();
        assert!(!json.contains(MARKER), "non-model field forwarded: {json}");
        assert!(json.contains("\"displayName\"") && json.contains("\"reasoningEfforts\""));
    }

    #[test]
    fn codex_cache_missing_file_is_not_found() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            read_codex_models(home.path()).unwrap_err().code,
            "not_found"
        );
        std::fs::create_dir_all(home.path().join(".codex")).unwrap();
        assert_eq!(
            read_codex_models(home.path()).unwrap_err().code,
            "not_found"
        );
    }

    #[test]
    fn codex_cache_rejects_malformed_documents_whole() {
        for bad in [
            "",
            "not json",
            "[]",
            r#"{"models":"x"}"#,
            r#"{"nomodels":[]}"#,
            r#"{"models":[1]}"#,
            r#"{"models":[{"display_name":"no slug"}]}"#,
            r#"{"models":[{"slug":""}]}"#,
            r#"{"models":[{"slug":7}]}"#,
            r#"{"models":[{"slug":"ok"},{"slug":"b","context_window":"big"}]}"#,
            r#"{"models":[{"slug":"ok"},{"slug":"b","context_window":-1}]}"#,
            r#"{"models":[{"slug":"a","supported_reasoning_levels":"x"}]}"#,
            r#"{"models":[{"slug":"a","supported_reasoning_levels":[{"nope":1}]}]}"#,
        ] {
            assert_eq!(
                read_codex_models(home_with_cache(bad).path())
                    .unwrap_err()
                    .code,
                "malformed",
                "{bad}"
            );
        }
        let long = "a".repeat(CODEX_MAX_FIELD_CHARS + 1);
        let doc = format!(r#"{{"models":[{{"slug":"{long}"}}]}}"#);
        assert_eq!(
            read_codex_models(home_with_cache(&doc).path())
                .unwrap_err()
                .code,
            "malformed"
        );
        let many = (0..=CODEX_MAX_MODELS)
            .map(|i| format!(r#"{{"slug":"m{i}"}}"#))
            .collect::<Vec<_>>()
            .join(",");
        let doc = format!(r#"{{"models":[{many}]}}"#);
        assert_eq!(
            read_codex_models(home_with_cache(&doc).path())
                .unwrap_err()
                .code,
            "malformed"
        );
    }

    #[test]
    fn codex_cache_malformed_error_never_contains_file_content() {
        let home = home_with_cache(&format!(r#"{{"models":[{{"slug":7,"x":"{MARKER}"}}]}}"#));
        let e = read_codex_models(home.path()).unwrap_err();
        assert!(!serde_json::to_string(&e).unwrap().contains(MARKER));
    }

    #[test]
    fn codex_cache_rejects_a_giant_file_before_parsing_it() {
        let pad = "x".repeat(CODEX_MAX_FILE_BYTES as usize + 16);
        let home = home_with_cache(&format!(r#"{{"models":[{{"slug":"a"}}],"pad":"{pad}"}}"#));
        assert_eq!(
            read_codex_models(home.path()).unwrap_err().code,
            "too_large"
        );
    }

    #[test]
    fn read_text_bounded_stops_an_endless_source_and_accepts_the_exact_limit() {
        // `repeat` never ends: only the take() bound stops the read.
        let e = read_text_bounded(std::io::repeat(b'a'), 1_000).unwrap_err();
        assert_eq!(e.code, "too_large");
        let ok = read_text_bounded(std::io::repeat(b'a').take(1_000), 1_000).unwrap();
        assert_eq!(ok.len(), 1_000);
        let over = read_text_bounded(std::io::repeat(b'a').take(1_001), 1_000).unwrap_err();
        assert_eq!(over.code, "too_large");
    }

    #[test]
    fn codex_cache_rejects_a_directory_in_place_of_the_file() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".codex/models_cache.json")).unwrap();
        assert_eq!(
            read_codex_models(home.path()).unwrap_err().code,
            "read_failed"
        );
    }

    #[test]
    fn codex_cache_never_reads_auth_json() {
        // Only models_cache.json exists as a readable credential-free file; an
        // auth.json holding a marker must never surface.
        let home = home_with_cache(r#"{"models":[{"slug":"a"}]}"#);
        std::fs::write(
            home.path().join(".codex/auth.json"),
            format!(r#"{{"OPENAI_API_KEY":"{MARKER}"}}"#),
        )
        .unwrap();
        let json = serde_json::to_string(&read_codex_models(home.path()).unwrap()).unwrap();
        assert!(!json.contains(MARKER));
    }

    // ── Review round 2: F1 (name resolution / mapped IPv4 / proxy) ──

    #[test]
    fn link_local_classification_covers_mapped_and_compatible_forms() {
        for blocked in [
            "169.254.169.254",
            "169.254.0.1",
            "0.0.0.0",
            "fe80::1",
            "febf::1",
            "::",
            "::ffff:169.254.169.254",
            "::ffff:a9fe:a9fe",
            "::ffff:0.0.0.0",
            "::169.254.169.254",
        ] {
            assert!(ip_is_link_local(blocked.parse().unwrap()), "{blocked}");
        }
        // Control: loopback, private ranges and public addresses stay allowed
        // (LM Studio / Ollama), mapped or not.
        for allowed in [
            "127.0.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "10.0.0.5",
            "192.168.1.9",
            "172.16.0.1",
            "fc00::1",
            "fec0::1",
            "::ffff:10.0.0.5",
            "8.8.8.8",
            "2001:4860:4860::8888",
        ] {
            assert!(!ip_is_link_local(allowed.parse().unwrap()), "{allowed}");
        }
    }

    #[tokio::test]
    async fn get_json_rejects_mapped_and_obfuscated_link_local_literals() {
        for url in [
            "http://[::ffff:169.254.169.254]/latest/meta-data",
            "http://[::ffff:a9fe:a9fe]/x",
            "http://[::ffff:0.0.0.0]/x",
            "http://[::169.254.169.254]/x",
            "http://[::]/x",
            "http://0xa9fea9fe/x",
            "http://2852039166/x",
            "http://169.254.169.254.:80/x",
        ] {
            let e = get(req(url)).await.unwrap_err();
            assert_eq!(e.code, "blocked_host", "{url} -> {e:?}");
        }
    }

    #[tokio::test]
    async fn a_name_that_resolves_only_to_link_local_is_refused_and_never_dialed() {
        let (port, hits) = serve(|_| ok_json("{}")).await;
        let dns = fake_dns(&[
            ("metadata.test", &["169.254.169.254"]),
            ("mapped.test", &["::ffff:169.254.169.254"]),
            ("v6.test", &["fe80::1"]),
            ("zero.test", &["0.0.0.0"]),
        ]);
        for host in ["metadata.test", "mapped.test", "v6.test", "zero.test"] {
            let mut r = req(&format!("http://{host}:{port}/m"));
            r.headers = Some(HashMap::from([(
                "authorization".into(),
                format!("Bearer {MARKER}"),
            )]));
            let e = get_via(dns.clone(), r).await.unwrap_err();
            assert_eq!(e.code, "blocked_host", "{host}: {e:?}");
            assert!(!serde_json::to_string(&e).unwrap().contains(MARKER));
        }
        assert_eq!(hits.load(Ordering::SeqCst), 0, "a blocked name was dialed");
    }

    #[tokio::test]
    async fn a_name_with_mixed_addresses_connects_only_to_the_allowed_one() {
        // The server listens on 127.0.0.1 only. The name also resolves to the
        // metadata address, which must be dropped (not tried, not fatal).
        let (port, hits) = serve(|_| ok_json(r#"{"ok":1}"#)).await;
        let dns = fake_dns(&[(
            "mixed.test",
            &["169.254.169.254", "::ffff:169.254.169.254", "127.0.0.1"],
        )]);
        let resp = get_via(dns, req(&format!("http://mixed.test:{port}/m")))
            .await
            .unwrap();
        assert_eq!(resp.body, r#"{"ok":1}"#);
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    /// Tests that touch the real [`DNS_SLOTS`] take turns.
    static REAL_DNS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[tokio::test]
    async fn the_real_resolver_still_reaches_localhost() {
        let _turn = REAL_DNS.lock().await;
        let (port, _) = serve(|_| ok_json("{}")).await;
        let resp = get(req(&format!("http://localhost:{port}/m")))
            .await
            .unwrap();
        assert_eq!(resp.status, 200);
    }

    #[tokio::test]
    async fn a_failed_lookup_is_a_fixed_error_without_the_name() {
        let e = get_via(
            fake_dns(&[]),
            req(&format!("http://secret-{MARKER}.test:1/m")),
        )
        .await
        .unwrap_err();
        assert!(
            e.code == "connect_failed" || e.code == "request_failed",
            "{e:?}"
        );
        assert!(!serde_json::to_string(&e).unwrap().contains(MARKER));
    }

    /// The proxy test runs its request in a child process that gets the proxy
    /// variables at launch: `std::env::set_var` in this test process would race
    /// with the system resolver other tests run on their own threads.
    const PROXY_CHILD: &str = "model_list::tests::the_environment_proxy_child";

    #[tokio::test]
    async fn the_environment_proxy_is_never_used() {
        // A proxy would dial the destination itself, outside the resolver policy.
        let (proxy_port, proxy_hits) = serve(|_| ok_json(r#"{"via":"proxy"}"#)).await;
        let (port, hits) = serve(|_| ok_json(r#"{"via":"direct"}"#)).await;
        let proxy = format!("http://127.0.0.1:{proxy_port}");
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap());
        child
            .args(["--exact", PROXY_CHILD, "--ignored", "--test-threads=1"])
            .env("MD_PROXY_TEST_TARGET_PORT", port.to_string())
            .env_remove("NO_PROXY")
            .env_remove("no_proxy")
            .kill_on_drop(true);
        for name in ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] {
            child.env(name, &proxy);
        }
        let out = child.output().await.unwrap();
        let log = String::from_utf8_lossy(&out.stdout).into_owned();
        let err = String::from_utf8_lossy(&out.stderr).into_owned();
        // `--exact` naming nothing would run 0 tests and still exit 0.
        assert!(
            log.contains("running 1 test"),
            "the child test did not run: {log}\n{err}"
        );
        assert!(
            out.status.success() && log.contains("1 passed"),
            "the child test failed: {log}\n{err}"
        );
        assert_eq!(
            proxy_hits.load(Ordering::SeqCst),
            0,
            "request went to the proxy"
        );
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    /// Body of the proxy test, run by [`the_environment_proxy_is_never_used`] in
    /// a child that has the proxy variables set; a bare `--ignored` run has no
    /// target and passes without doing anything.
    #[tokio::test]
    #[ignore = "runs as a child of the_environment_proxy_is_never_used"]
    async fn the_environment_proxy_child() {
        let Ok(port) = std::env::var("MD_PROXY_TEST_TARGET_PORT") else {
            return;
        };
        assert!(
            std::env::var_os("HTTP_PROXY").is_some(),
            "the child must start with the proxy set"
        );
        let resp = get(req(&format!("http://127.0.0.1:{port}/m")))
            .await
            .unwrap();
        assert_eq!(resp.body, r#"{"via":"direct"}"#);
    }

    // ── F2 (round 3): the blocking lookup outlives the request, so does its permit ──

    #[tokio::test]
    async fn a_slow_lookup_keeps_its_permit_after_the_timeout_and_a_full_budget_is_busy() {
        use std::sync::{Condvar, Mutex};

        static SLOTS: Semaphore = Semaphore::const_new(2);
        static CALLS: AtomicUsize = AtomicUsize::new(0);
        static GATE: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());

        /// A "getaddrinfo" stuck until the gate opens (bounded, never forever).
        fn slow(_host: &str) -> std::io::Result<Vec<SocketAddr>> {
            CALLS.fetch_add(1, Ordering::SeqCst);
            let (open, cv) = &GATE;
            let guard = open.lock().unwrap();
            let (_guard, wait) = cv
                .wait_timeout_while(guard, Duration::from_secs(20), |open| !*open)
                .unwrap();
            assert!(!wait.timed_out(), "the test never opened the gate");
            Ok(vec!["127.0.0.1:0".parse().unwrap()])
        }

        /// Opens the gate also when an assertion fails, so no thread stays stuck.
        struct OpenGate;
        impl Drop for OpenGate {
            fn drop(&mut self) {
                *GATE.0.lock().unwrap() = true;
                GATE.1.notify_all();
            }
        }

        async fn call(
            resolver: &Arc<FilteringResolver>,
            http: &Semaphore,
            port: u16,
            timeout_ms: u64,
        ) -> Result<GetJsonResponse, ModelListError> {
            let mut r = req(&format!("http://slow.test:{port}/m"));
            r.timeout_ms = Some(timeout_ms);
            get_json(r, HTTP_MAX_BODY_BYTES, 5_000, resolver.clone(), http).await
        }

        let _gate = OpenGate;
        let (port, hits) = serve(|_| ok_json(r#"{"ok":1}"#)).await;
        let resolver = Arc::new(FilteringResolver {
            lookup: budgeted_lookup(&SLOTS, slow),
        });
        let http = Semaphore::new(HTTP_MAX_CONCURRENT);

        // Two short-deadline calls: each times out, each leaves its lookup running.
        for n in 1..=2usize {
            let started = std::time::Instant::now();
            let e = call(&resolver, &http, port, 150).await.unwrap_err();
            assert_eq!(e.code, "timeout", "{e:?}");
            assert!(started.elapsed() < Duration::from_secs(2));
            assert_eq!(CALLS.load(Ordering::SeqCst), n);
            assert_eq!(
                SLOTS.available_permits(),
                2 - n,
                "the lookup permit came back before the lookup finished"
            );
            assert_eq!(
                http.available_permits(),
                HTTP_MAX_CONCURRENT,
                "the request permit is the request's own"
            );
        }

        // Full lookup budget: many calls with a name all get the fixed `busy`,
        // at once, and none of them starts another lookup.
        let started = std::time::Instant::now();
        let refused =
            futures_util::future::join_all((0..12).map(|_| call(&resolver, &http, port, 5_000)))
                .await;
        assert!(started.elapsed() < Duration::from_millis(500));
        for r in refused {
            assert_eq!(r.unwrap_err(), busy());
        }
        assert_eq!(CALLS.load(Ordering::SeqCst), 2, "a lookup was queued");
        assert_eq!(hits.load(Ordering::SeqCst), 0, "a refused call connected");

        // The stuck lookups finish: permits return and a name resolves again.
        drop(_gate);
        for _ in 0..250 {
            if SLOTS.available_permits() == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(SLOTS.available_permits(), 2, "permits never came back");
        let ok = call(&resolver, &http, port, 5_000).await.unwrap();
        assert_eq!(ok.body, r#"{"ok":1}"#);
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn the_system_resolver_runs_on_the_dns_budget() {
        let _turn = REAL_DNS.lock().await;
        assert_eq!(DNS_MAX_CONCURRENT, 4);
        let (port, hits) = serve(|_| ok_json("{}")).await;
        let held: Vec<_> = (0..DNS_MAX_CONCURRENT)
            .map(|_| DNS_SLOTS.try_acquire().unwrap())
            .collect();
        let e = get(req(&format!("http://localhost:{port}/m")))
            .await
            .unwrap_err();
        drop(held);
        assert_eq!(e, busy());
        assert_eq!(hits.load(Ordering::SeqCst), 0);
        // Control: with the budget free the same name resolves and connects.
        let ok = get(req(&format!("http://localhost:{port}/m")))
            .await
            .unwrap();
        assert_eq!(ok.status, 200);
    }

    // ── F6: IPC payload decoding ──

    #[test]
    fn a_wrongly_typed_payload_would_echo_through_serde_which_is_why_it_is_decoded_here() {
        // Control: this payload really does come back out of a typed decode.
        let wrong = serde_json::json!({"url": "http://127.0.0.1:1/", "timeoutMs": MARKER});
        let typed = serde_json::from_value::<GetJsonRequest>(wrong)
            .err()
            .expect("wrongly typed payload must not decode");
        assert!(typed.to_string().contains(MARKER), "{typed}");
    }

    #[tokio::test]
    async fn wrongly_typed_get_payloads_get_the_fixed_error_without_the_marker() {
        for payload in [
            serde_json::json!({"url": "http://127.0.0.1:1/", "timeoutMs": MARKER}),
            serde_json::json!({"url": 7, "headers": {"a": MARKER}}),
            serde_json::json!({"url": "http://127.0.0.1:1/", "headers": {"a": 5, "b": MARKER}}),
            serde_json::json!({"url": "http://127.0.0.1:1/", "headers": MARKER}),
            serde_json::json!({"headers": {"a": MARKER}}),
            serde_json::json!(MARKER),
            serde_json::Value::Null,
        ] {
            let e = ai_http_get_json(Some(payload.clone())).await.unwrap_err();
            assert_eq!(e, invalid_request(), "{payload}");
            let shown = format!("{e:?} {}", serde_json::to_string(&e).unwrap());
            assert!(!shown.contains(MARKER), "payload echoed: {shown}");
        }
        assert_eq!(ai_http_get_json(None).await.unwrap_err(), invalid_request());
    }

    #[tokio::test]
    async fn wrongly_typed_provider_gets_the_fixed_error_without_the_marker() {
        for payload in [
            serde_json::json!(7),
            serde_json::json!({"p": MARKER}),
            serde_json::json!([MARKER]),
            serde_json::Value::Null,
        ] {
            let e = cli_list_models(Some(payload.clone())).await.unwrap_err();
            assert_eq!(e, invalid_request(), "{payload}");
            assert!(!serde_json::to_string(&e).unwrap().contains(MARKER));
        }
        assert_eq!(cli_list_models(None).await.unwrap_err(), invalid_request());
    }

    /// The real IPC boundary (Tauri's own argument decoding and error envelope),
    /// with a wrongly typed payload that carries a marker.
    #[test]
    fn ipc_envelope_for_a_wrongly_typed_payload_is_fixed_and_has_no_marker() {
        let app = tauri::test::mock_builder()
            .invoke_handler(tauri::generate_handler![ai_http_get_json, cli_list_models])
            .build(crate::tauri_context())
            .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let origin: tauri::Url = if cfg!(windows) {
            "http://tauri.localhost".parse().unwrap()
        } else {
            "tauri://localhost".parse().unwrap()
        };
        let call = |cmd: &str, body: serde_json::Value| {
            tauri::test::get_ipc_response(
                &webview,
                tauri::webview::InvokeRequest {
                    cmd: cmd.into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: origin.clone(),
                    body: tauri::ipc::InvokeBody::Json(body),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.to_string(),
                },
            )
        };
        for (cmd, body) in [
            (
                "ai_http_get_json",
                serde_json::json!({"request": {"url": "http://127.0.0.1:1/", "timeoutMs": MARKER}}),
            ),
            (
                "ai_http_get_json",
                serde_json::json!({"request": {"url": 7, "headers": {"k": MARKER}}}),
            ),
            (
                "cli_list_models",
                serde_json::json!({"provider": {"x": MARKER}}),
            ),
            ("cli_list_models", serde_json::json!({"provider": 7})),
        ] {
            let e = call(cmd, body.clone()).expect_err("must be rejected");
            let shown = e.to_string();
            assert!(!shown.contains(MARKER), "{cmd} {body}: echoed {shown}");
            assert_eq!(
                e,
                serde_json::json!({"code": "invalid_request", "message": "The request is not valid."}),
                "{cmd} {body}"
            );
        }
    }

    // ── F4: global concurrency limit ──

    #[test]
    fn the_budgets_are_the_documented_ones() {
        assert_eq!(HTTP_SLOTS.available_permits(), 4);
        assert_eq!(CLI_SLOTS.available_permits(), 2);
        assert_eq!(CACHE_SLOTS.available_permits(), 1);
        assert_eq!(DNS_MAX_CONCURRENT, 4);
    }

    #[tokio::test]
    async fn a_full_http_budget_refuses_at_once_with_busy_and_never_connects() {
        let (port, hits) = serve(|_| ok_json("{}")).await;
        let slots = Semaphore::new(2);
        let held = (slots.try_acquire().unwrap(), slots.try_acquire().unwrap());
        let started = std::time::Instant::now();
        let e = get_json(
            req(&format!("http://127.0.0.1:{port}/m")),
            HTTP_MAX_BODY_BYTES,
            5_000,
            FilteringResolver::system(),
            &slots,
        )
        .await
        .unwrap_err();
        assert_eq!(e, busy());
        assert!(started.elapsed() < Duration::from_millis(500));
        assert_eq!(hits.load(Ordering::SeqCst), 0, "a refused call connected");
        // Control: one free permit and the same call goes through.
        drop(held.0);
        let ok = get_json(
            req(&format!("http://127.0.0.1:{port}/m")),
            HTTP_MAX_BODY_BYTES,
            5_000,
            FilteringResolver::system(),
            &slots,
        )
        .await;
        assert!(ok.is_ok(), "{ok:?}");
        assert_eq!(slots.available_permits(), 1, "permit not returned");
    }

    #[tokio::test]
    async fn simultaneous_stalled_gets_fill_the_budget_and_release_it_afterwards() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let accepted = Arc::new(AtomicUsize::new(0));
        let seen = accepted.clone();
        let _server = tokio::spawn(async move {
            let mut socks = Vec::new();
            while let Ok((sock, _)) = listener.accept().await {
                seen.fetch_add(1, Ordering::SeqCst);
                socks.push(sock); // accept and never answer
            }
        });
        let slots = Arc::new(Semaphore::new(2));
        let mut inflight = Vec::new();
        for _ in 0..2 {
            let slots = slots.clone();
            inflight.push(tokio::spawn(async move {
                let mut r = req(&format!("http://127.0.0.1:{port}/m"));
                r.timeout_ms = Some(10_000);
                get_json(
                    r,
                    HTTP_MAX_BODY_BYTES,
                    10_000,
                    FilteringResolver::system(),
                    &slots,
                )
                .await
            }));
        }
        for _ in 0..100 {
            if accepted.load(Ordering::SeqCst) == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(accepted.load(Ordering::SeqCst), 2);
        let third = get_json(
            req(&format!("http://127.0.0.1:{port}/m")),
            HTTP_MAX_BODY_BYTES,
            5_000,
            FilteringResolver::system(),
            &slots,
        )
        .await;
        assert_eq!(third.unwrap_err(), busy());
        assert_eq!(accepted.load(Ordering::SeqCst), 2, "refused call connected");
        for h in &inflight {
            h.abort();
        }
        for h in inflight {
            let _ = h.await;
        }
        assert_eq!(slots.available_permits(), 2, "cancelled calls kept permits");
    }

    #[tokio::test]
    async fn the_http_command_uses_the_global_budget() {
        let held: Vec<_> = (0..HTTP_MAX_CONCURRENT)
            .map(|_| HTTP_SLOTS.try_acquire().unwrap())
            .collect();
        let e = ai_http_get_json(Some(serde_json::json!({"url": "http://127.0.0.1:1/"})))
            .await
            .unwrap_err();
        drop(held);
        assert_eq!(e, busy());
    }

    #[tokio::test]
    async fn the_cli_command_uses_the_global_budget() {
        let held: Vec<_> = (0..CLI_MAX_CONCURRENT)
            .map(|_| CLI_SLOTS.try_acquire().unwrap())
            .collect();
        let e = cli_list_models(Some(serde_json::json!("grok-sub")))
            .await
            .unwrap_err();
        drop(held);
        assert_eq!(e, busy());
    }

    #[tokio::test]
    async fn the_cache_command_budget_refuses_when_a_read_is_running() {
        static SLOTS: Semaphore = Semaphore::const_new(1);
        let home = home_with_cache(r#"{"models":[{"slug":"a"}]}"#);
        let held = SLOTS.try_acquire().unwrap();
        let e = read_codex_models_limited(home.path().to_path_buf(), &SLOTS)
            .await
            .unwrap_err();
        assert_eq!(e, busy());
        drop(held);
        let ok = read_codex_models_limited(home.path().to_path_buf(), &SLOTS)
            .await
            .unwrap();
        assert_eq!(ok.len(), 1);
        assert_eq!(SLOTS.available_permits(), 1, "permit not returned");
        // And the real command's static budget is wired to the same helper.
        let held = CACHE_SLOTS.try_acquire().unwrap();
        let e = read_codex_models_limited(home.path().to_path_buf(), &CACHE_SLOTS)
            .await
            .unwrap_err();
        drop(held);
        assert_eq!(e, busy());
    }

    // ── F3: links and special files in the Codex cache ──

    #[cfg(unix)]
    mod cache_links {
        use super::*;
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::symlink;

        const VALID: &str = r#"{"models":[{"slug":"outside-the-fixed-path"}]}"#;

        /// Run the read on a thread so a regression that blocks (a FIFO) fails the
        /// test instead of hanging it.
        fn read_with_deadline(home: &Path) -> Result<Vec<CodexModel>, ModelListError> {
            let (tx, rx) = std::sync::mpsc::channel();
            let home = home.to_path_buf();
            std::thread::spawn(move || {
                let _ = tx.send(read_codex_models(&home));
            });
            rx.recv_timeout(Duration::from_secs(5))
                .expect("read_codex_models blocked")
        }

        #[test]
        fn a_symlinked_cache_file_is_refused_even_when_it_points_at_valid_json() {
            let home = tempfile::tempdir().unwrap();
            let elsewhere = tempfile::tempdir().unwrap();
            std::fs::write(elsewhere.path().join("other.json"), VALID).unwrap();
            std::fs::create_dir(home.path().join(".codex")).unwrap();
            symlink(
                elsewhere.path().join("other.json"),
                home.path().join(".codex/models_cache.json"),
            )
            .unwrap();
            let e = read_with_deadline(home.path()).unwrap_err();
            assert_eq!(e.code, "read_failed");
        }

        #[test]
        fn a_symlinked_codex_directory_is_refused_even_when_the_target_has_a_valid_cache() {
            let home = tempfile::tempdir().unwrap();
            let elsewhere = tempfile::tempdir().unwrap();
            std::fs::write(elsewhere.path().join("models_cache.json"), VALID).unwrap();
            symlink(elsewhere.path(), home.path().join(".codex")).unwrap();
            let e = read_with_deadline(home.path()).unwrap_err();
            assert_eq!(e.code, "read_failed");
        }

        #[test]
        fn dangling_symlinks_at_both_levels_are_refused_not_reported_as_missing() {
            let home = tempfile::tempdir().unwrap();
            std::fs::create_dir(home.path().join(".codex")).unwrap();
            symlink(
                home.path().join("nowhere"),
                home.path().join(".codex/models_cache.json"),
            )
            .unwrap();
            assert_eq!(
                read_with_deadline(home.path()).unwrap_err().code,
                "read_failed"
            );
            let home2 = tempfile::tempdir().unwrap();
            symlink(home2.path().join("nowhere"), home2.path().join(".codex")).unwrap();
            assert_eq!(
                read_with_deadline(home2.path()).unwrap_err().code,
                "read_failed"
            );
        }

        #[test]
        fn a_fifo_in_place_of_the_cache_is_refused_without_blocking() {
            let home = tempfile::tempdir().unwrap();
            std::fs::create_dir(home.path().join(".codex")).unwrap();
            let fifo = home.path().join(".codex/models_cache.json");
            let c = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
            let e = read_with_deadline(home.path()).unwrap_err();
            assert_eq!(e.code, "read_failed");
        }

        #[test]
        fn a_symlink_to_a_fifo_is_refused_without_blocking() {
            let home = tempfile::tempdir().unwrap();
            let elsewhere = tempfile::tempdir().unwrap();
            let fifo = elsewhere.path().join("pipe");
            let c = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
            std::fs::create_dir(home.path().join(".codex")).unwrap();
            symlink(&fifo, home.path().join(".codex/models_cache.json")).unwrap();
            let e = read_with_deadline(home.path()).unwrap_err();
            assert_eq!(e.code, "read_failed");
        }

        #[test]
        fn a_home_reached_through_a_link_still_works() {
            // Control: only `.codex` and the file are confined, not the home path.
            let real = home_with_cache(r#"{"models":[{"slug":"ok"}]}"#);
            let holder = tempfile::tempdir().unwrap();
            let link = holder.path().join("home-link");
            symlink(real.path(), &link).unwrap();
            let models = read_with_deadline(&link).unwrap();
            assert_eq!(models.len(), 1);
            assert_eq!(models[0].slug, "ok");
        }

        #[test]
        fn a_missing_home_is_a_typed_error() {
            let holder = tempfile::tempdir().unwrap();
            let e = read_with_deadline(&holder.path().join("no-such-home")).unwrap_err();
            assert_eq!(e.code, "not_found");
        }
    }

    // ── F2: the CLI's descendants ──

    #[cfg(unix)]
    mod cli_tree {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        fn fake_cli(dir: &Path, name: &str, body: &str) -> String {
            let path = dir.join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path.to_string_lossy().into_owned()
        }

        /// ETXTBSY from a sibling test's concurrent fork is a harness race.
        async fn run(bin: &str, max: usize, timeout: Duration) -> Result<String, ModelListError> {
            for _ in 0..20 {
                match run_models_command(bin, max, timeout).await {
                    Err(e) if e.code == "cli_spawn_failed" => {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                    other => return other,
                }
            }
            run_models_command(bin, max, timeout).await
        }

        /// [`run`] with the group kill replaced by `killpg`.
        async fn run_with(
            bin: &str,
            max: usize,
            timeout: Duration,
            killpg: fn(libc::pid_t),
        ) -> Result<String, ModelListError> {
            for _ in 0..20 {
                match run_models_command_in(bin, max, timeout, ProcessTree::with_killpg(killpg))
                    .await
                {
                    Err(e) if e.code == "cli_spawn_failed" => {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                    other => return other,
                }
            }
            run_models_command_in(bin, max, timeout, ProcessTree::with_killpg(killpg)).await
        }

        /// What a recorded group kill saw: the group id, whether its leader was
        /// still uncollected at that moment (`kill(pgid, 0)`: a zombie still
        /// answers, a collected child is ESRCH) and whether it had already exited
        /// (a zombie: `waitid(WNOHANG | WNOWAIT)` reports it without collecting).
        type Signals = std::sync::Mutex<Vec<(libc::pid_t, bool, bool)>>;

        /// The child `pid` has exited and not been collected yet.
        fn is_zombie(pid: libc::pid_t) -> bool {
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let rc = unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            rc == 0 && unsafe { info.si_pid() } == pid
        }

        /// The child `pid` is no longer ours to wait for: it was collected.
        fn is_collected(pid: libc::pid_t) -> bool {
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let rc = unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            rc == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD)
        }

        fn record(log: &'static Signals, pgid: libc::pid_t, forward: bool) {
            let uncollected = (unsafe { libc::kill(pgid, 0) }) == 0;
            let zombie = is_zombie(pgid);
            log.lock().unwrap().push((pgid, uncollected, zombie));
            if forward {
                real_killpg(pgid);
            }
        }

        /// Exactly one group kill, sent while the leader was still uncollected;
        /// `exited` is whether the leader had already exited by then.
        fn assert_one_early_signal(log: &'static Signals, what: &str, exited: bool) {
            let seen = log.lock().unwrap().clone();
            assert_eq!(seen.len(), 1, "{what}: group signals: {seen:?}");
            assert!(seen[0].1, "{what}: the leader was already collected");
            assert_eq!(
                seen[0].2, exited,
                "{what}: leader exited at signal time: {seen:?}"
            );
        }

        async fn read_pid(file: &Path) -> i32 {
            for _ in 0..200 {
                if let Ok(text) = std::fs::read_to_string(file) {
                    if let Ok(pid) = text.trim().parse() {
                        return pid;
                    }
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            panic!("{} never written", file.display());
        }

        /// Alive = exists and is not a zombie (a killed orphan can stay a zombie
        /// until init reaps it).
        fn alive(pid: i32) -> bool {
            match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
                Ok(stat) => stat
                    .rsplit(')')
                    .next()
                    .and_then(|rest| rest.trim_start().chars().next())
                    .is_some_and(|state| state != 'Z'),
                Err(_) => (unsafe { libc::kill(pid, 0) }) == 0,
            }
        }

        async fn assert_dies(pid: i32, what: &str) {
            for _ in 0..80 {
                if !alive(pid) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            // No signal by number here: the process may be gone and its pid
            // reused. The fixture grandchildren are bounded `sleep`s instead.
            panic!("{what}: grandchild {pid} survived");
        }

        /// A CLI that leaves a long-lived grandchild and records its pid.
        fn script_with_grandchild(pidfile: &Path, tail: &str) -> String {
            format!("sleep 30 &\necho $! > '{}'\n{tail}", pidfile.display())
        }

        #[tokio::test]
        async fn timeout_kills_the_grandchild_and_reaps_the_direct_child() {
            let dir = tempfile::tempdir().unwrap();
            let pidfile = dir.path().join("grandchild.pid");
            let mainfile = dir.path().join("main.pid");
            let bin = fake_cli(
                dir.path(),
                "tree",
                &format!(
                    "echo $$ > '{}'\n{}",
                    mainfile.display(),
                    script_with_grandchild(&pidfile, "sleep 30")
                ),
            );
            let started = std::time::Instant::now();
            let e = run(&bin, 1024, Duration::from_millis(600))
                .await
                .unwrap_err();
            assert_eq!(e.code, "timeout");
            // The tree is killed right away, not after the 2 s bounded wait of the
            // direct child: a late kill shows up as latency here.
            assert!(
                started.elapsed() < Duration::from_millis(1_500),
                "kill came late: {:?}",
                started.elapsed()
            );
            let grandchild = read_pid(&pidfile).await;
            let main = read_pid(&mainfile).await;
            assert_dies(grandchild, "timeout").await;
            // The direct child was awaited: not even a zombie is left.
            if Path::new("/proc/self").exists() {
                assert!(
                    !Path::new(&format!("/proc/{main}")).exists(),
                    "child not reaped"
                );
            }
        }

        #[tokio::test]
        async fn oversized_stdout_kills_the_grandchild() {
            let dir = tempfile::tempdir().unwrap();
            let pidfile = dir.path().join("grandchild.pid");
            let bin = fake_cli(
                dir.path(),
                "big",
                &script_with_grandchild(&pidfile, "yes x"),
            );
            let e = run(&bin, 2_000, Duration::from_secs(10)).await.unwrap_err();
            assert_eq!(e.code, "too_large");
            assert_dies(read_pid(&pidfile).await, "oversized stdout").await;
        }

        #[tokio::test]
        async fn dropping_the_call_kills_the_grandchild() {
            let dir = tempfile::tempdir().unwrap();
            let pidfile = dir.path().join("grandchild.pid");
            let bin = fake_cli(
                dir.path(),
                "tree",
                &script_with_grandchild(&pidfile, "sleep 30"),
            );
            let task = tokio::spawn(async move { run(&bin, 1024, Duration::from_secs(60)).await });
            let grandchild = read_pid(&pidfile).await;
            assert!(alive(grandchild));
            task.abort();
            let _ = task.await;
            assert_dies(grandchild, "drop").await;
        }

        // ── F1 (round 3): the group is only signalled while its leader is uncollected ──

        #[tokio::test]
        async fn timeout_signals_the_group_once_while_the_leader_is_uncollected() {
            static LOG: Signals = std::sync::Mutex::new(Vec::new());
            fn rec(pgid: libc::pid_t) {
                record(&LOG, pgid, true)
            }
            let dir = tempfile::tempdir().unwrap();
            let pidfile = dir.path().join("grandchild.pid");
            let bin = fake_cli(
                dir.path(),
                "tree",
                &script_with_grandchild(&pidfile, "sleep 30"),
            );
            let e = run_with(&bin, 1024, Duration::from_millis(500), rec)
                .await
                .unwrap_err();
            assert_eq!(e.code, "timeout");
            assert_dies(read_pid(&pidfile).await, "timeout").await;
            assert_one_early_signal(&LOG, "timeout", false);
        }

        #[tokio::test]
        async fn oversized_stdout_signals_the_group_once_while_the_leader_is_uncollected() {
            static LOG: Signals = std::sync::Mutex::new(Vec::new());
            fn rec(pgid: libc::pid_t) {
                record(&LOG, pgid, true)
            }
            let dir = tempfile::tempdir().unwrap();
            let pidfile = dir.path().join("grandchild.pid");
            let bin = fake_cli(
                dir.path(),
                "big",
                &script_with_grandchild(&pidfile, "yes x"),
            );
            let e = run_with(&bin, 2_000, Duration::from_secs(10), rec)
                .await
                .unwrap_err();
            assert_eq!(e.code, "too_large");
            assert_dies(read_pid(&pidfile).await, "oversized stdout").await;
            assert_one_early_signal(&LOG, "oversized stdout", false);
        }

        #[tokio::test]
        async fn cancelling_signals_the_group_once_while_the_leader_is_uncollected() {
            static LOG: Signals = std::sync::Mutex::new(Vec::new());
            fn rec(pgid: libc::pid_t) {
                record(&LOG, pgid, true)
            }
            let dir = tempfile::tempdir().unwrap();
            let pidfile = dir.path().join("grandchild.pid");
            let bin = fake_cli(
                dir.path(),
                "tree",
                &script_with_grandchild(&pidfile, "sleep 30"),
            );
            let task =
                tokio::spawn(
                    async move { run_with(&bin, 1024, Duration::from_secs(60), rec).await },
                );
            let grandchild = read_pid(&pidfile).await;
            task.abort();
            let _ = task.await;
            assert_dies(grandchild, "cancel").await;
            assert_one_early_signal(&LOG, "cancel", false);
        }

        /// The leader has exited and is a zombie (nobody has waited for it: the
        /// grandchild keeps stdout open, so the call is still reading) when the
        /// call is cancelled. Dropping the `Child` first would reap that zombie
        /// and the group kill would then use a collected leader's id.
        #[tokio::test]
        async fn cancelling_right_after_the_leader_exited_still_signals_before_the_leader_is_collected(
        ) {
            static LOG: Signals = std::sync::Mutex::new(Vec::new());
            fn rec(pgid: libc::pid_t) {
                record(&LOG, pgid, true)
            }
            let dir = tempfile::tempdir().unwrap();
            let pidfile = dir.path().join("grandchild.pid");
            let bin = fake_cli(
                dir.path(),
                "exits",
                &script_with_grandchild(&pidfile, "exit 0"),
            );
            let task =
                tokio::spawn(
                    async move { run_with(&bin, 1024, Duration::from_secs(60), rec).await },
                );
            let grandchild = read_pid(&pidfile).await;
            // Let the leader finish and become a zombie.
            tokio::time::sleep(Duration::from_millis(400)).await;
            assert!(alive(grandchild));
            task.abort();
            let _ = task.await;
            assert_dies(grandchild, "cancel after leader exit").await;
            assert_one_early_signal(&LOG, "cancel after leader exit", true);
        }

        // ── F1 (round 4): a CLI that exits by itself is observed, then the group is
        // signalled while the zombie leader reserves the id, then it is collected ──

        /// A CLI that leaves a long-lived helper in its group (stdout detached
        /// from it, so the call sees EOF when the leader exits) and a tail.
        fn script_with_detached_helper(pidfile: &Path, tail: &str) -> String {
            format!(
                "sleep 30 >/dev/null 2>&1 &\necho $! > '{}'\n{tail}",
                pidfile.display()
            )
        }

        /// The leader's own pid, written before the helper starts.
        fn script_with_pids(mainfile: &Path, pidfile: &Path, tail: &str) -> String {
            format!(
                "echo $$ > '{}'\n{}",
                mainfile.display(),
                script_with_detached_helper(pidfile, tail)
            )
        }

        #[tokio::test]
        async fn a_normal_exit_signals_the_group_between_the_leader_exit_and_its_collection() {
            static LOG: Signals = std::sync::Mutex::new(Vec::new());
            fn rec(pgid: libc::pid_t) {
                record(&LOG, pgid, true)
            }
            let dir = tempfile::tempdir().unwrap();
            let pidfile = dir.path().join("helper.pid");
            let mainfile = dir.path().join("main.pid");
            let bin = fake_cli(
                dir.path(),
                "daemonizing",
                &script_with_pids(&mainfile, &pidfile, "echo models-ok"),
            );
            let out = run_with(&bin, 1024, Duration::from_secs(10), rec)
                .await
                .unwrap();
            assert_eq!(out, "models-ok\n");
            // Order: the leader had exited (zombie) and was uncollected when the
            // group was signalled, once...
            assert_one_early_signal(&LOG, "normal exit", true);
            // ...the helper of the same group died before the call returned...
            assert_dies(read_pid(&pidfile).await, "normal exit").await;
            // ...and the leader was collected afterwards, by `wait`.
            assert!(
                is_collected(read_pid(&mainfile).await),
                "leader not collected"
            );
        }

        #[tokio::test]
        async fn a_cli_that_exits_with_an_error_signals_the_group_between_the_exit_and_the_collection(
        ) {
            static LOG: Signals = std::sync::Mutex::new(Vec::new());
            fn rec(pgid: libc::pid_t) {
                record(&LOG, pgid, true)
            }
            let dir = tempfile::tempdir().unwrap();
            let pidfile = dir.path().join("helper.pid");
            let mainfile = dir.path().join("main.pid");
            let bin = fake_cli(
                dir.path(),
                "failing",
                &script_with_pids(&mainfile, &pidfile, "exit 3"),
            );
            let e = run_with(&bin, 1024, Duration::from_secs(10), rec)
                .await
                .unwrap_err();
            assert_eq!(e.code, "cli_failed");
            assert_one_early_signal(&LOG, "error exit", true);
            assert_dies(read_pid(&pidfile).await, "error exit").await;
            assert!(
                is_collected(read_pid(&mainfile).await),
                "leader not collected"
            );
        }

        /// stdout is closed while the leader keeps running: the call is blocked
        /// observing the leader, not reading. Timeout there signals the live
        /// leader's group once, before collection.
        #[tokio::test]
        async fn timeout_while_observing_the_leader_signals_the_group_once() {
            static LOG: Signals = std::sync::Mutex::new(Vec::new());
            fn rec(pgid: libc::pid_t) {
                record(&LOG, pgid, true)
            }
            let dir = tempfile::tempdir().unwrap();
            let pidfile = dir.path().join("helper.pid");
            let bin = fake_cli(
                dir.path(),
                "closed-stdout",
                &script_with_detached_helper(&pidfile, "exec 1>&-\nsleep 30"),
            );
            let started = std::time::Instant::now();
            let e = run_with(&bin, 1024, Duration::from_millis(600), rec)
                .await
                .unwrap_err();
            assert_eq!(e.code, "timeout");
            assert!(
                started.elapsed() < Duration::from_millis(1_500),
                "kill came late: {:?}",
                started.elapsed()
            );
            assert_dies(read_pid(&pidfile).await, "timeout while observing").await;
            assert_one_early_signal(&LOG, "timeout while observing", false);
        }

        /// Same state, cancelled instead: the dropped call signals the group once
        /// while the leader is uncollected (group guard drops before the `Child`).
        #[tokio::test]
        async fn cancelling_while_observing_the_leader_signals_the_group_once() {
            static LOG: Signals = std::sync::Mutex::new(Vec::new());
            fn rec(pgid: libc::pid_t) {
                record(&LOG, pgid, true)
            }
            let dir = tempfile::tempdir().unwrap();
            let pidfile = dir.path().join("helper.pid");
            let bin = fake_cli(
                dir.path(),
                "closed-stdout",
                &script_with_detached_helper(&pidfile, "exec 1>&-\nsleep 30"),
            );
            let task =
                tokio::spawn(
                    async move { run_with(&bin, 1024, Duration::from_secs(60), rec).await },
                );
            let helper = read_pid(&pidfile).await;
            // Let the call reach the blocking wait on the leader.
            tokio::time::sleep(Duration::from_millis(400)).await;
            assert!(alive(helper));
            task.abort();
            let _ = task.await;
            assert_dies(helper, "cancel while observing").await;
            assert_one_early_signal(&LOG, "cancel while observing", false);
        }

        /// `WNOWAIT`: observing the exit leaves the child collectable, and a
        /// process that is not our child cannot be observed (`ECHILD`) — the
        /// caller then trusts no group id.
        #[test]
        fn observing_a_leader_exit_does_not_collect_it_and_a_stranger_is_unobservable() {
            let mut child = std::process::Command::new("true").spawn().unwrap();
            let pid = child.id() as libc::pid_t;
            assert!(leader_exited_blocking(pid));
            assert!(is_zombie(pid), "observing collected the leader");
            assert!(child.wait().unwrap().success(), "child was not collectable");
            assert!(is_collected(pid));
            let parent = unsafe { libc::getppid() };
            assert!(!leader_exited_blocking(parent));
        }

        /// Control for the two tests above: the real kill is still wired in the
        /// production path (no seam) and the leader of a normal run is collected.
        #[tokio::test]
        async fn a_normal_exit_through_the_real_path_leaves_no_zombie() {
            let dir = tempfile::tempdir().unwrap();
            let mainfile = dir.path().join("main.pid");
            let bin = fake_cli(
                dir.path(),
                "plain",
                &format!("echo $$ > '{}'\necho fine", mainfile.display()),
            );
            assert_eq!(
                run(&bin, 1024, Duration::from_secs(10)).await.unwrap(),
                "fine\n"
            );
            let main = read_pid(&mainfile).await;
            if Path::new("/proc/self").exists() {
                assert!(
                    !Path::new(&format!("/proc/{main}")).exists(),
                    "leader not collected"
                );
            }
        }

        #[tokio::test]
        async fn the_cli_budget_refuses_a_second_call_while_one_runs() {
            let dir = tempfile::tempdir().unwrap();
            let pidfile = dir.path().join("grandchild.pid");
            let slow = fake_cli(
                dir.path(),
                "slow",
                &script_with_grandchild(&pidfile, "sleep 30"),
            );
            let quick = fake_cli(dir.path(), "quick", "echo fast");
            let slots = Arc::new(Semaphore::new(1));
            let first = {
                let slots = slots.clone();
                tokio::spawn(async move {
                    limited(&slots, run(&slow, 1024, Duration::from_secs(60))).await
                })
            };
            let grandchild = read_pid(&pidfile).await;
            let started = std::time::Instant::now();
            let second = limited(&slots, run(&quick, 1024, Duration::from_secs(5))).await;
            assert_eq!(second.unwrap_err(), busy());
            assert!(started.elapsed() < Duration::from_millis(500));
            first.abort();
            let _ = first.await;
            assert_dies(grandchild, "budget").await;
            // The permit came back with the cancelled call: the quick CLI runs.
            let third = limited(&slots, run(&quick, 1024, Duration::from_secs(5)))
                .await
                .unwrap();
            assert_eq!(third, "fast\n");
        }
    }
}
