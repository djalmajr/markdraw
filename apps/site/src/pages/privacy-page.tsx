export function PrivacyPage() {
  return (
    <div class="page-stack">
      <section class="content-panel privacy-panel">
        <h1 class="content-title">Privacy Policy</h1>
        <p>
          <strong>Last updated:</strong> May 5, 2026
        </p>
        <h2>Data collection</h2>
        <p>
          AsciiMark does not collect analytics, trackers, or telemetry, and does not send personal
          data to any AsciiMark-controlled server. There is no AsciiMark backend.
        </p>
        <h2>Scope (extension and desktop)</h2>
        <p>This policy applies to both the Chrome extension and the desktop app.</p>
        <h2>Local processing</h2>
        <p>
          Document parsing and rendering happen locally inside your browser tab (extension) or
          inside the Tauri webview (desktop app). Document text is never uploaded by AsciiMark
          infrastructure. The only exceptions are explicit, user-triggered network requests
          listed below.
        </p>
        <h2>Local storage usage</h2>
        <p>
          AsciiMark persists user-controlled state in the browser's <code>localStorage</code> and,
          on the extension, in <code>IndexedDB</code> and <code>chrome.storage.session</code>.
          Nothing in this list leaves your machine.
        </p>
        <ul>
          <li>Theme preference (<code>light</code> / <code>dark</code> / <code>system</code>).</li>
          <li>Editor preferences (indent mode, line numbers, wrap, invisibles, font).</li>
          <li>Preview font preferences (family and size).</li>
          <li>Recent files and recent folders, plus pinned favorites.</li>
          <li>
            Tab session per pane (open files and the active tab) and the pane layout (number of
            panes, active pane, split ratio).
          </li>
          <li>Sidebar width and visibility, table-of-contents visibility and depth.</li>
          <li>Extension only: directory handles in <code>IndexedDB</code> for session restore.</li>
          <li>
            Extension only: temporary URL-mode payload in <code>chrome.storage.session</code> —
            captured by the content script when redirecting to the viewer page, cleared on
            session end.
          </li>
        </ul>
        <h2>Permissions explained</h2>
        <ul>
          <li>
            <strong>storage</strong> (extension): used for the temporary URL-mode payload above
            via <code>chrome.storage.session</code>.
          </li>
          <li>
            <strong>host_permissions: <code>https://kroki.io/*</code></strong> (extension): the
            only host the extension can fetch. Used solely to render Kroki diagram blocks.
          </li>
          <li>
            <strong>File URL access</strong> (optional, extension): enables previewing local
            <code> file://</code> documents. Off by default; toggled at
            <code> chrome://extensions</code>.
          </li>
        </ul>
        <h2>Network requests</h2>
        <ul>
          <li>
            <strong>Document URLs (extension)</strong>: when the extension renders a remote
            <code> .adoc</code> or <code>.md</code> URL, it fetches the file from that URL the
            same way a browser would — directly between your machine and the document host.
          </li>
          <li>
            <strong>Kroki rendering</strong>: diagram blocks (<code>plantuml</code>,
            <code> graphviz</code>, <code>mermaid</code>, etc.) are sent as plain text to
            <code> https://kroki.io</code> via POST and the response is a static SVG. No
            JavaScript is fetched. Skipped if the document has no diagram blocks.
          </li>
          <li>
            <strong>Auto-updater (desktop)</strong>: on startup the desktop app checks
            <code> https://github.com/djalmajr/asciimark-releases/releases/latest/download/latest.json</code>
            for a newer version. If you accept an update prompt, the signed binary is downloaded
            from the same public GitHub repository. The check sends no document content — it
            only contacts GitHub.
          </li>
        </ul>
        <h2>Sharing safety (extension)</h2>
        <p>
          When you copy the source URL of a document being viewed in the extension, AsciiMark
          strips query parameters (such as GitHub's short-lived <code>?token=…</code> on raw
          private-repo URLs) before placing the URL on the clipboard. This prevents the token
          from leaking when the URL is pasted into chats or issues. The original URL the viewer
          uses is unchanged.
        </p>
        <h2>Third-party libraries</h2>
        <p>
          AsciiMark bundles open-source packages, all running locally:
        </p>
        <ul>
          <li>@asciidoctor/core (AsciiDoc parser)</li>
          <li>markdown-it and plugins (Markdown parser)</li>
          <li>Prism (syntax highlighting)</li>
          <li>Mermaid (diagrams rendered locally; some Kroki diagrams use the service above)</li>
          <li>KaTeX (math rendering)</li>
          <li>CodeMirror (editor)</li>
          <li>SolidJS (UI framework) and Kobalte (UI primitives)</li>
          <li>Tauri (desktop runtime) and tauri-plugin-updater (desktop only)</li>
        </ul>
        <h2>Third-party services</h2>
        <ul>
          <li>
            <strong>Kroki</strong> (<code>https://kroki.io</code>) — only when your document
            contains supported Kroki diagram blocks.
          </li>
          <li>
            <strong>GitHub</strong> (<code>github.com/djalmajr/asciimark-releases</code>) — only
            for desktop auto-updates and downloads of installer / update artifacts.
          </li>
        </ul>
        <h2>Policy changes</h2>
        <p>
          Any future updates to this policy are published on this page. The
          <strong> Last updated</strong> date at the top reflects the most recent change.
        </p>
        <h2>Contact</h2>
        <p>
          For privacy questions, open an issue at{" "}
          <a href="https://github.com/djalmajr/asciimark-releases/issues">
            github.com/djalmajr/asciimark-releases/issues
          </a>
          .
        </p>
      </section>
    </div>
  );
}
