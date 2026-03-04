export function PrivacyPage() {
  return (
    <div class="page-stack">
      <section class="content-panel privacy-panel">
        <h1 class="content-title">Privacy Policy</h1>
        <p>
          <strong>Last updated:</strong> March 3, 2026
        </p>
        <h2>Data collection</h2>
        <p>
          AsciiMark does not collect analytics, trackers, or telemetry, and does not send personal
          data to AsciiMark servers.
        </p>
        <h2>Scope (extension and desktop)</h2>
        <p>This policy applies to both the Chrome extension and the desktop app.</p>
        <h2>Local processing</h2>
        <p>
          Rendering happens locally in your browser or desktop app. Document content is not
          uploaded by AsciiMark infrastructure.
        </p>
        <h2>Local storage usage</h2>
        <ul>
          <li>Recent files and recent folders in <code>localStorage</code>.</li>
          <li>
            Theme preference (<code>light</code> / <code>dark</code> / <code>system</code>) in{" "}
            <code>localStorage</code>.
          </li>
          <li>Editor preferences in <code>localStorage</code>.</li>
          <li>Document font preferences in <code>localStorage</code>.</li>
          <li>
            Extension only: directory handles in <code>IndexedDB</code> for session restore.
          </li>
          <li>
            Extension only: temporary session transfer data in <code>chrome.storage.session</code>.
          </li>
        </ul>
        <h2>Permissions explained</h2>
        <ul>
          <li>
            <strong>storage</strong>: used for extension session data and local persistence
            features.
          </li>
          <li>
            <strong>File URL access</strong> (optional): enables rendering local
            <code> file://</code> documents when user explicitly allows it in extension settings.
          </li>
        </ul>
        <h2>Network requests</h2>
        <ul>
          <li>Remote document URLs are fetched directly for rendering.</li>
          <li>
            Kroki diagram blocks send diagram source to <code>https://kroki.io</code> to generate
            SVG output.
          </li>
        </ul>
        <h2>Third-party libraries</h2>
        <p>
          AsciiMark bundles open-source packages for local parsing and rendering, including:
        </p>
        <ul>
          <li>@asciidoctor/core</li>
          <li>markdown-it and plugins</li>
          <li>Prism</li>
          <li>Mermaid</li>
          <li>KaTeX</li>
        </ul>
        <h2>Third-party services</h2>
        <p>
          AsciiMark uses Kroki (<code>https://kroki.io</code>) only when your document contains
          supported Kroki diagram blocks.
        </p>
        <h2>Policy changes</h2>
        <p>
          Any future updates to this policy are published on this page.
        </p>
        <h2>Contact</h2>
        <p>
          For privacy questions, open an issue at{" "}
          <a href="https://github.com/djalmajr/asciimark-releases/issues">github.com/djalmajr/asciimark-releases/issues</a>.
        </p>
      </section>
    </div>
  );
}
