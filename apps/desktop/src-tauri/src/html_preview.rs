//! `asciimark-preview://` — a custom URI scheme that serves a single HTML
//! file's DIRECTORY as an isolated web origin, so multi-file pages and SPAs
//! preview with full fidelity. The scheme is app-namespaced (not a generic
//! `htmlpreview`) to avoid colliding with other apps' custom schemes.
//!
//! Why a scheme and not the `asset:` protocol + `<base href>`: `convertFileSrc`
//! encodes the whole path as one opaque segment, so a page's **root-absolute**
//! URLs (`/index.js`, `/assets/app.css`, importmap `~/` → `/`) resolve against
//! the asset origin root (the filesystem root), not the project folder — they
//! 404. Here every preview gets its own origin `asciimark-preview://<token>`,
//! whose root maps to the file's directory, so `/index.js` → `<dir>/index.js`
//! and ES modules / importmaps / hash routing all work.
//!
//! ## Isolation
//! The previewed page lives in the `asciimark-preview://<token>` origin,
//! distinct from the app's `tauri://localhost`. The frontend frames it sandboxed
//! (`allow-scripts allow-same-origin`, where "same-origin" means the preview's
//! OWN origin, not the app's). Tauri injects its IPC bridge per top-level
//! webview, not into page-created sub-frames, and no capability grants this
//! origin any command — so the previewed page cannot reach the Tauri IPC or the
//! host DOM. Only directories explicitly registered via `html_preview_register`
//! are servable (an allowlist), and each request is path-traversal-guarded both
//! lexically and via canonicalization.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use percent_encoding::percent_decode_str;
use regex::Regex;
use tauri::http::{Request, Response};
use tauri::{AppHandle, Manager, Runtime};

/// The custom URI scheme. App-namespaced to avoid collisions; the frontend
/// builds `asciimark-preview://<token>/<file>` URLs against this.
pub const SCHEME: &str = "asciimark-preview";

/// Query marker the CSS-module transform appends to a rewritten import so the
/// handler serves that `.css` as a constructable-stylesheet JS module instead
/// of a raw stylesheet. See `rewrite_css_module_imports` / `css_module_js`.
const CSS_MODULE_MARKER: &str = "asciimark-css-module";

/// Maps preview tokens to the directory they serve, plus an optional in-memory
/// overlay so the file currently open in the editor previews its UNSAVED buffer
/// (the rest of the tree still comes from disk).
#[derive(Default)]
pub struct HtmlPreviewState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    next_id: u64,
    by_token: HashMap<String, PathBuf>,
    by_dir: HashMap<PathBuf, String>,
    /// token → (normalized rel path, live content) for the open file.
    overlay: HashMap<String, (String, String)>,
}

/// Register `dir` for previewing and return its (stable, per-session) token.
/// Idempotent: the same canonical directory always yields the same token, so
/// the iframe URL stays cache-friendly across re-previews.
#[tauri::command]
pub fn html_preview_register(
    state: tauri::State<'_, HtmlPreviewState>,
    dir: String,
) -> Result<String, String> {
    let canon = std::fs::canonicalize(&dir).map_err(|e| e.to_string())?;
    if !canon.is_dir() {
        return Err("html_preview_register: not a directory".into());
    }
    let mut inner = state.inner.lock().unwrap();
    if let Some(token) = inner.by_dir.get(&canon) {
        return Ok(token.clone());
    }
    let token = format!("r{}", inner.next_id);
    inner.next_id += 1;
    inner.by_token.insert(token.clone(), canon.clone());
    inner.by_dir.insert(canon, token.clone());
    Ok(token)
}

/// Set the live overlay for `token`: requests for `rel_path` serve `content`
/// (the editor's current, possibly unsaved, buffer) instead of the disk file.
#[tauri::command]
pub fn html_preview_set_overlay(
    state: tauri::State<'_, HtmlPreviewState>,
    token: String,
    rel_path: String,
    content: String,
) {
    let mut inner = state.inner.lock().unwrap();
    if inner.by_token.contains_key(&token) {
        inner.overlay.insert(token, (clean_rel(&rel_path), content));
    }
}

/// Drop the live overlay for `token` (e.g. when the preview closes), so future
/// requests fall back to disk.
#[tauri::command]
pub fn html_preview_clear_overlay(state: tauri::State<'_, HtmlPreviewState>, token: String) {
    state.inner.lock().unwrap().overlay.remove(&token);
}

/// Serve one `asciimark-preview://<token>/<path>` request. Registered on the Tauri
/// builder; runs on Tauri's protocol thread (blocking file IO is fine — preview
/// assets are small and local).
pub fn serve<R: Runtime>(app: &AppHandle<R>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let state = app.state::<HtmlPreviewState>();
    let uri = request.uri();
    let token = uri.host().unwrap_or("").to_string();
    // Path arrives percent-encoded; decode, then lexically strip `..`/`.`/root.
    let decoded = percent_decode_str(uri.path()).decode_utf8_lossy();
    let mut rel = clean_rel(&decoded);
    if rel.is_empty() {
        rel = "index.html".to_string();
    }

    // A rewritten CSS-module import (see rewrite_css_module_imports) asks for
    // the `.css` as a JS module exporting a constructable stylesheet.
    let as_css_module = uri.query().is_some_and(|q| q.contains(CSS_MODULE_MARKER));

    let inner = state.inner.lock().unwrap();
    let Some(root) = inner.by_token.get(&token).cloned() else {
        return not_found();
    };
    // Live overlay wins for the open file (shows unsaved edits). The entry doc
    // is HTML, never a CSS module or JS, so serve it verbatim.
    if let Some((orel, content)) = inner.overlay.get(&token) {
        if *orel == rel {
            return ok(inject_preview_chrome(content).into_bytes(), content_type_for("page.html"));
        }
    }
    drop(inner);

    // `clean_rel` already removed traversal lexically; canonicalize is the
    // second guard, catching symlinks that point outside the root.
    let candidate = root.join(&rel);
    let Ok(canon) = std::fs::canonicalize(&candidate) else {
        return not_found();
    };
    if !canon.starts_with(&root) {
        return not_found();
    }
    let Ok(bytes) = std::fs::read(&canon) else {
        return not_found();
    };

    // WKWebView rejects `import … with { type: "css" }`, so the preview acts as
    // a tiny bundler: CSS imported as a module is served as a JS module that
    // builds a CSSStyleSheet, and JS files have their CSS-module imports
    // rewritten to hit that path. Binary/invalid-UTF-8 files pass through.
    if as_css_module {
        let css = String::from_utf8_lossy(&bytes);
        return ok(css_module_js(&css).into_bytes(), content_type_for("m.js"));
    }
    if is_js_module(&rel) {
        if let Ok(js) = std::str::from_utf8(&bytes) {
            return ok(
                rewrite_css_module_imports(js).into_bytes(),
                content_type_for(&rel),
            );
        }
    }
    if is_html(&rel) {
        if let Ok(html) = std::str::from_utf8(&bytes) {
            return ok(inject_preview_chrome(html).into_bytes(), content_type_for(&rel));
        }
    }
    ok(bytes, content_type_for(&rel))
}

fn is_html(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    lower.ends_with(".html") || lower.ends_with(".htm")
}

/// A discreet, theme-agnostic scrollbar for the previewed page. The iframe is a
/// separate document/origin, so neither the app's global scrollbar CSS nor
/// <ScrollArea> reach inside it — without this, a page that doesn't style its
/// own scrollbar shows WKWebView's thick default. Injected at the very top of
/// <head> so a page that DOES style its scrollbar still overrides ours.
///
/// Deliberately uses ONLY `::-webkit-scrollbar` (a fixed-width custom bar) and
/// NOT the standard `scrollbar-width`/`scrollbar-color`: in WebKit, setting
/// those switches the element to the NATIVE macOS overlay scrollbar (which
/// fattens on hover/scroll) and makes WebKit ignore `::-webkit-scrollbar`. So
/// the standard props are intentionally absent — they'd reintroduce the thick
/// native bar this fix removes.
const PREVIEW_SCROLLBAR_CSS: &str = "<style data-asciimark-preview>\
::-webkit-scrollbar{width:8px;height:8px}\
::-webkit-scrollbar-track{background:transparent}\
::-webkit-scrollbar-thumb{background-color:rgba(128,128,128,.45);border:1px solid transparent;background-clip:padding-box;border-radius:9999px}\
::-webkit-scrollbar-thumb:hover{background-color:rgba(128,128,128,.65)}\
</style>";

/// Insert `PREVIEW_SCROLLBAR_CSS` right after the opening `<head>` (so the page
/// can still override it), or prepend it when there's no head.
fn inject_preview_chrome(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    if let Some(h) = lower.find("<head") {
        if let Some(gt) = lower[h..].find('>') {
            let pos = h + gt + 1;
            return format!("{}{}{}", &html[..pos], PREVIEW_SCROLLBAR_CSS, &html[pos..]);
        }
    }
    format!("{PREVIEW_SCROLLBAR_CSS}{html}")
}

/// True for files the browser loads as ES modules (where CSS-module imports may
/// appear and need rewriting).
fn is_js_module(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    lower.ends_with(".js") || lower.ends_with(".mjs") || lower.ends_with(".cjs")
}

/// Rewrite `import x from "y.css" with { type: "css" }` (and the legacy
/// `assert { type: "css" }`) into `import x from "y.css?asciimark-css-module"`,
/// dropping the unsupported import attribute. The marked URL is served by
/// `serve` as a JS module (see `css_module_js`). Best-effort and conservative:
/// it only touches imports that carry a `type: "css"` attribute, so ordinary
/// code is untouched. Files without such imports return unchanged (cheap).
fn rewrite_css_module_imports(js: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(
            r#"(?s)\bimport\s+([A-Za-z_$][\w$]*)\s+from\s+(?:"([^"]+)"|'([^']+)')\s*(?:with|assert)\s*\{\s*type\s*:\s*(?:"css"|'css')\s*,?\s*\}"#,
        )
        .expect("valid css-module import regex")
    });
    re.replace_all(js, |caps: &regex::Captures| {
        let binding = &caps[1];
        let spec = caps
            .get(2)
            .or_else(|| caps.get(3))
            .map(|m| m.as_str())
            .unwrap_or("");
        let sep = if spec.contains('?') { '&' } else { '?' };
        format!("import {binding} from \"{spec}{sep}{CSS_MODULE_MARKER}\"")
    })
    .into_owned()
}

/// Wrap CSS text as a JS module exporting a constructable CSSStyleSheet — the
/// runtime shape `import sheet from "x.css" with { type: "css" }` would have
/// produced. The CSS is embedded as a JSON string literal (valid JS), so any
/// quotes/newlines/unicode are escaped safely.
fn css_module_js(css: &str) -> String {
    let literal = serde_json::to_string(css).unwrap_or_else(|_| "\"\"".to_string());
    format!("const sheet = new CSSStyleSheet();\nsheet.replaceSync({literal});\nexport default sheet;\n")
}

/// Lexically normalize a URL path into a safe relative path: percent-decoded
/// already, here we drop the leading slash and every `.`/`..`/root component,
/// keeping only `Normal` segments. `..` can never climb out of the root.
fn clean_rel(path: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    for comp in Path::new(path).components() {
        if let Component::Normal(s) = comp {
            parts.push(s.to_string_lossy().to_string());
        }
    }
    parts.join("/")
}

/// Content-Type by extension. Critical: `.js`/`.mjs` MUST be `text/javascript`
/// (not `text/plain`) or the webview refuses to execute `<script type=module>`,
/// which is the whole point of serving SPAs.
fn content_type_for(rel: &str) -> &'static str {
    let ext = Path::new(rel)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "webmanifest" => "application/manifest+json; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "txt" | "md" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "wasm" => "application/wasm",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => "application/octet-stream",
    }
}

fn ok(bytes: Vec<u8>, content_type: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(200)
        .header("Content-Type", content_type)
        // The preview page is same-origin to its own assets; no app code reads
        // these, so keep them uncached during live editing.
        .header("Cache-Control", "no-store")
        .body(bytes)
        .unwrap()
}

fn not_found() -> Response<Vec<u8>> {
    Response::builder()
        .status(404)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(b"Not Found".to_vec())
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_rel_strips_traversal_and_roots() {
        // Mutation: keeping `..` would let `htmlpreview://t/../../etc/passwd`
        // climb out of the served directory.
        assert_eq!(clean_rel("/../../etc/passwd"), "etc/passwd");
        assert_eq!(clean_rel("/assets/../assets/app.js"), "assets/assets/app.js");
        assert_eq!(clean_rel("/./index.html"), "index.html");
        assert_eq!(clean_rel("/"), "");
        assert_eq!(clean_rel("/a/b/c.css"), "a/b/c.css");
    }

    #[test]
    fn clean_rel_join_stays_under_root() {
        let root = Path::new("/srv/preview");
        let joined = root.join(clean_rel("/../../../etc/shadow"));
        assert!(joined.starts_with(root), "join escaped root: {joined:?}");
    }

    #[test]
    fn content_type_modules_are_javascript() {
        // Mutation: returning text/plain here breaks ES module execution.
        assert_eq!(content_type_for("a.js"), "text/javascript; charset=utf-8");
        assert_eq!(content_type_for("a.mjs"), "text/javascript; charset=utf-8");
        assert_eq!(content_type_for("index.html"), "text/html; charset=utf-8");
        assert_eq!(content_type_for("s.css"), "text/css; charset=utf-8");
        assert_eq!(content_type_for("blob.bin"), "application/octet-stream");
    }

    #[test]
    fn rewrites_css_module_import_with_attribute() {
        // Mutation: leaving `with { type: "css" }` makes WKWebView throw
        // `Import attribute type "css" is not valid` and abort the module.
        let out = rewrite_css_module_imports(
            r#"import sheet from "./z-proto.css" with { type: "css" };"#,
        );
        assert_eq!(
            out,
            r#"import sheet from "./z-proto.css?asciimark-css-module";"#
        );
        assert!(!out.contains("type"));
    }

    #[test]
    fn rewrites_legacy_assert_and_single_quotes() {
        let out = rewrite_css_module_imports(
            "import s from './a/b.css' assert { type: 'css' }\n",
        );
        assert_eq!(out, "import s from \"./a/b.css?asciimark-css-module\"\n");
    }

    #[test]
    fn css_import_keeps_existing_query_with_ampersand() {
        let out = rewrite_css_module_imports(
            r#"import s from "./x.css?v=2" with { type: "css" };"#,
        );
        assert!(out.contains(r#""./x.css?v=2&asciimark-css-module""#), "{out}");
    }

    #[test]
    fn leaves_unrelated_imports_untouched() {
        // Mutation: an over-broad regex would corrupt ordinary imports or
        // JSON-module imports (which WKWebView DOES support).
        let src = "import x from \"./m.js\";\nimport d from \"./d.json\" with { type: \"json\" };\n";
        assert_eq!(rewrite_css_module_imports(src), src);
    }

    #[test]
    fn css_module_js_exports_a_constructable_sheet() {
        let js = css_module_js(".a{content:\"x\"}\n");
        assert!(js.contains("new CSSStyleSheet()"));
        assert!(js.contains("replaceSync("));
        assert!(js.contains("export default sheet"));
        // CSS embedded as a JSON string literal → quotes/newlines escaped.
        assert!(js.contains(r#"".a{content:\"x\"}\n""#), "{js}");
    }

    #[test]
    fn is_js_module_matches_module_extensions() {
        assert!(is_js_module("a.js"));
        assert!(is_js_module("dir/b.mjs"));
        assert!(is_js_module("c.cjs"));
        assert!(!is_js_module("style.css"));
        assert!(!is_js_module("page.html"));
    }

    #[test]
    fn injects_scrollbar_style_after_head() {
        let out = inject_preview_chrome("<html><head><title>x</title></head><body>y</body></html>");
        // Lands right after <head>, before the page's own head content, so the
        // page can still override it.
        assert!(out.contains("<head><style data-asciimark-preview>"), "{out}");
        assert!(out.find("data-asciimark-preview").unwrap() < out.find("<title>").unwrap());
        assert!(out.contains("::-webkit-scrollbar-thumb"));
    }

    #[test]
    fn injects_scrollbar_style_when_no_head() {
        // Mutation: skipping the prepend would leave a head-less fragment with
        // WKWebView's thick default scrollbar.
        let out = inject_preview_chrome("<p>fragment</p>");
        assert!(out.starts_with("<style data-asciimark-preview>"));
        assert!(out.ends_with("<p>fragment</p>"));
    }

    #[test]
    fn is_html_matches_html_extensions() {
        assert!(is_html("index.html"));
        assert!(is_html("a/b.htm"));
        assert!(!is_html("app.js"));
        assert!(!is_html("style.css"));
    }
}
