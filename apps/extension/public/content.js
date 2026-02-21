// Content script: injected into pages matching *.adoc / *.md patterns
// Captures file content and redirects to the extension viewer
(() => {
  // Only act on plain-text pages (Chrome renders them as a single <pre> inside <body>)
  if (document.body.children.length !== 1) return;
  const pre = document.body.querySelector("pre");
  if (!pre) return;

  // Capture the raw file content before redirecting
  const content = pre.textContent || "";
  const url = location.href;

  // Store content in session storage so the viewer can read it without needing
  // host_permissions to fetch the file from the service worker
  chrome.storage.session.set({ urlContent: { url, content } }, () => {
    const viewerUrl =
      chrome.runtime.getURL("index.html") +
      "?url=" +
      encodeURIComponent(url);

    location.replace(viewerUrl);
  });
})();
