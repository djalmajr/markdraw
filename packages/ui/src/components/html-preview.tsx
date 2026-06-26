import {
  createEffect,
  createResource,
  createSignal,
  on,
  onCleanup,
  Show,
  untrack,
  type JSX,
} from "solid-js";

/** Desktop folder-rooted preview host. When provided, a directory is served as
 *  an isolated `markdraw-preview://<token>` origin. The Rust side picks WHICH
 *  directory from the entry on disk: a self-rooted SPA (importmap / root-
 *  absolute paths) serves from its OWN dir at `/` so ES modules, importmaps and
 *  path routers work; a relative document serves from the WORKSPACE folder at
 *  the entry's true path so `../shared` climbs to sibling dirs like `file://`.
 *  The live editor buffer is pushed as an overlay so unsaved edits preview. */
export interface HtmlPreviewFolderRoot {
  /** Platform-correct origin the entry DOCUMENT is served from — no path:
   *  the doc loads at `/` (entry + token travel in the query) so SPAs whose
   *  router matches `location.pathname` see their root route. WKWebView/
   *  WebKitGTK navigate the bare scheme (`markdraw-preview://<token>` — the
   *  token IS the host), but WebView2 can't — on Windows Tauri serves the
   *  scheme as `http://markdraw-preview.localhost` and the token rides the
   *  query alone. */
  docOrigin: (token: string) => string;
  /** Register the previewed file; resolves to its token, the entry path
   *  relative to the SERVED directory, and `ownRoot` — true when the file is a
   *  self-rooted SPA served from its own dir at `/`, false when it's a relative
   *  document served from the workspace folder at its true path. Null on
   *  failure. */
  register: () => Promise<{ token: string; entryRel: string; ownRoot: boolean } | null>;
  /** Serve `content` for `relPath` instead of the disk file (live buffer). */
  setOverlay: (token: string, relPath: string, content: string) => void | Promise<void>;
  /** Drop this file's overlay so requests for it fall back to disk. */
  clearOverlay: (token: string, relPath: string) => void | Promise<void>;
}

export interface HtmlPreviewProps {
  /** The HTML source (the live editor content). */
  content: string;
  /** Desktop SPA mode. Absent (web/extension) → the srcdoc fallback below. */
  folderRoot?: HtmlPreviewFolderRoot;
  /** srcdoc fallback only: asset:// URL of the file's directory (trailing
   *  slash) so relative resources resolve. Ignored in folderRoot mode. */
  baseHref?: string;
}

const OVERLAY_DEBOUNCE_MS = 350;
const SANDBOX_FOLDER = "allow-scripts allow-same-origin allow-popups allow-forms allow-modals";
const SANDBOX_SRCDOC = "allow-scripts allow-popups allow-forms allow-modals";

/** Inject a `<base href>` so relative resources resolve against the file's
 *  directory — after an existing `<head>` when present, else prepended. */
function withBase(html: string, baseHref?: string): string {
  if (!baseHref) return html;
  const tag = `<base href="${baseHref.replace(/"/g, "&quot;")}">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${tag}`) : `${tag}${html}`;
}

/**
 * Live, SANDBOXED preview of an HTML file. Two modes:
 *
 * - **folderRoot (desktop):** the file's directory is served as a dedicated,
 *   isolated origin (`markdraw-preview://<token>`); the iframe loads the entry
 *   via `src` so root-absolute URLs, ES modules and importmaps resolve — real
 *   SPAs render. The live buffer is pushed as an overlay and the frame reloads
 *   (debounced) so unsaved edits preview. The origin is distinct from the app's
 *   and granted no capabilities, so the page can't reach the host or Tauri IPC.
 *
 * - **srcdoc fallback (web/extension):** the source is rendered in an
 *   `<iframe srcdoc>` with `<base href="asset://…">` and `sandbox="allow-scripts"`
 *   (no `allow-same-origin` → opaque origin). Self-contained pages render; pages
 *   with root-absolute asset paths don't (that's what folderRoot mode is for).
 */
export function HtmlPreview(props: HtmlPreviewProps): JSX.Element {
  // ── srcdoc fallback ───────────────────────────────────────────────────────
  const [doc, setDoc] = createSignal(withBase(props.content, props.baseHref));
  let srcdocTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    if (props.folderRoot) return; // folderRoot mode drives its own iframe
    const next = withBase(props.content, props.baseHref);
    clearTimeout(srcdocTimer);
    srcdocTimer = setTimeout(() => setDoc(next), OVERLAY_DEBOUNCE_MS);
  });
  onCleanup(() => clearTimeout(srcdocTimer));

  // ── folderRoot (SPA) mode ─────────────────────────────────────────────────
  const [target] = createResource(
    () => props.folderRoot ?? null,
    (fr) => (fr ? fr.register() : Promise.resolve(null)),
  );
  // version < 0 → not yet loaded (no src). Bumped after each overlay push so
  // the frame reloads to reflect the live buffer.
  const [version, setVersion] = createSignal(-1);
  let overlayTimer: ReturnType<typeof setTimeout> | undefined;

  // Push the current buffer as the overlay, then reveal/reload the frame. The
  // first load waits for the overlay so it never flashes stale disk content.
  function applyOverlay(immediate: boolean) {
    const t = target();
    const fr = props.folderRoot;
    if (!t || !fr) return;
    const content = props.content;
    clearTimeout(overlayTimer);
    const run = async () => {
      await fr.setOverlay(t.token, t.entryRel, content);
      setVersion((v) => (v < 0 ? 0 : v + 1));
    };
    if (immediate) void run();
    else overlayTimer = setTimeout(() => void run(), OVERLAY_DEBOUNCE_MS);
  }

  // Drop the previous document the MOMENT the file switches: the resource
  // still hands out the stale target while the new registration is in
  // flight, so without this the old preview lingers as a "ghost" through
  // the register + overlay round-trips until the new doc paints. version
  // -1 → src() undefined → the <Show> below unmounts the iframe.
  createEffect(on(() => props.folderRoot, () => setVersion(-1), { defer: true }));

  // First load when the file/dir (target) resolves.
  createEffect(
    on(target, (t) => {
      setVersion(-1);
      if (t) applyOverlay(true);
    }),
  );
  // Live edits → debounced overlay push + reload.
  createEffect(on(() => props.content, () => applyOverlay(false), { defer: true }));

  onCleanup(() => {
    clearTimeout(overlayTimer);
    const t = untrack(target);
    const fr = props.folderRoot;
    if (t && fr) void fr.clearOverlay(t.token, t.entryRel);
  });

  const src = (): string | undefined => {
    const t = target();
    const fr = props.folderRoot;
    const v = version();
    if (!t || !fr || v < 0) return undefined;
    const origin = fr.docOrigin(t.token);
    const token = encodeURIComponent(t.token);
    if (t.ownRoot) {
      // Self-rooted SPA: load at path `/` (entry resolved server-side from
      // `am-entry`) so path routers match their root route. `am-token`
      // identifies the preview on Windows, where the fixed
      // `markdraw-preview.localhost` host can't carry it.
      const q = `am-token=${token}&am-entry=${encodeURIComponent(t.entryRel)}`;
      return `${origin}/?${q}&v=${v}`;
    }
    // Relative document: load at the entry's TRUE path so the browser resolves
    // relative URLs (`./`, `../`) against the file's real location within the
    // workspace origin — exactly like opening the file via `file://`.
    const path = t.entryRel.split("/").map(encodeURIComponent).join("/");
    return `${origin}/${path}?am-token=${token}&v=${v}`;
  };

  return (
    <Show
      when={props.folderRoot}
      fallback={
        <iframe
          class="html-preview-frame"
          title="HTML preview"
          sandbox={SANDBOX_SRCDOC}
          srcdoc={doc()}
        />
      }
    >
      {/* Mounted only while there's a loadable src — clearing the src
          ATTRIBUTE alone would leave the previous document rendered. */}
      <Show when={src()}>
        <iframe class="html-preview-frame" title="HTML preview" sandbox={SANDBOX_FOLDER} src={src()} />
      </Show>
    </Show>
  );
}
