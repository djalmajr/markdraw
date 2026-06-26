import { describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "@solidjs/testing-library";
import { HtmlPreview, type HtmlPreviewFolderRoot } from "./html-preview.tsx";

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function frame(container: HTMLElement): HTMLIFrameElement {
  const el = container.querySelector("iframe.html-preview-frame");
  if (!el) throw new Error("html-preview-frame not rendered");
  return el as HTMLIFrameElement;
}

describe("HtmlPreview", () => {
  it("renders the source inside a sandboxed iframe (no allow-same-origin)", () => {
    const { container } = render(() => <HtmlPreview content="<p>hi</p>" />);
    const iframe = frame(container);
    // Mutation: dropping the sandbox attribute would let the page reach the
    // host app + Tauri IPC. allow-same-origin must NEVER be present.
    const sandbox = iframe.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    expect(iframe.getAttribute("srcdoc")).toContain("<p>hi</p>");
  });

  it("injects a <base href> after an existing <head> so relative paths resolve", () => {
    const html = "<html><head><title>x</title></head><body><img src='a.png'></body></html>";
    const { container } = render(() => (
      <HtmlPreview content={html} baseHref="asset://localhost/dir/" />
    ));
    const doc = frame(container).getAttribute("srcdoc") ?? "";
    // Base lands immediately after <head>, before the title — so relative
    // resources resolve against the file's directory.
    expect(doc).toContain('<head><base href="asset://localhost/dir/">');
    expect(doc.indexOf("<base")).toBeLessThan(doc.indexOf("<title>"));
  });

  it("prepends <base> when the document has no <head>", () => {
    const { container } = render(() => (
      <HtmlPreview content="<p>fragment</p>" baseHref="asset://localhost/dir/" />
    ));
    const doc = frame(container).getAttribute("srcdoc") ?? "";
    expect(doc.startsWith('<base href="asset://localhost/dir/">')).toBe(true);
  });

  it("omits <base> entirely when no baseHref is given", () => {
    const { container } = render(() => <HtmlPreview content="<p>x</p>" />);
    const doc = frame(container).getAttribute("srcdoc") ?? "";
    expect(doc).not.toContain("<base");
  });

  it("escapes quotes in the baseHref so the injected tag can't break out", () => {
    const { container } = render(() => (
      <HtmlPreview content="<p>x</p>" baseHref={'asset://x"/><script>evil()</script>'} />
    ));
    const doc = frame(container).getAttribute("srcdoc") ?? "";
    // The double-quote is entity-encoded, so no premature attribute close.
    expect(doc).toContain("&quot;");
    expect(doc).not.toContain('"><script>evil()');
  });

  it("debounces live edits — the frame keeps the initial doc until the timer fires", async () => {
    const [content, setContent] = createSignal("<p>first</p>");
    const { container } = render(() => <HtmlPreview content={content()} />);
    expect(frame(container).getAttribute("srcdoc")).toContain("first");

    setContent("<p>second</p>");
    // Synchronously after the edit the frame still shows the old doc (debounced).
    expect(frame(container).getAttribute("srcdoc")).toContain("first");

    await new Promise((r) => setTimeout(r, 400));
    expect(frame(container).getAttribute("srcdoc")).toContain("second");
  });

  describe("folderRoot (SPA) mode", () => {
    function makeHost(over: Partial<HtmlPreviewFolderRoot> = {}): HtmlPreviewFolderRoot {
      return {
        docOrigin: (token: string) => `markdraw-preview://${token}`,
        register: vi.fn(async () => ({ token: "r0", entryRel: "index.html", ownRoot: true })),
        setOverlay: vi.fn(),
        clearOverlay: vi.fn(),
        ...over,
      };
    }

    it("loads the entry via a protocol src in a same-origin-isolated iframe", async () => {
      const host = makeHost();
      const { container } = render(() => (
        <HtmlPreview content="<p>spa</p>" folderRoot={host} />
      ));
      await tick();
      const iframe = frame(container);
      // Mutation: dropping allow-same-origin forces an opaque origin → ES
      // modules + root-absolute paths break (the whole point of this mode).
      const sandbox = iframe.getAttribute("sandbox") ?? "";
      expect(sandbox).toContain("allow-scripts");
      expect(sandbox).toContain("allow-same-origin");
      // src points at the registered origin's ROOT — path `/` so SPA path
      // routers match; the entry + token travel in the query. No srcdoc.
      expect(iframe.getAttribute("src")).toBe(
        "markdraw-preview://r0/?am-token=r0&am-entry=index.html&v=0",
      );
      expect(iframe.getAttribute("srcdoc")).toBeNull();
    });

    it("pushes the live buffer as an overlay before first load", async () => {
      const host = makeHost();
      render(() => <HtmlPreview content="<p>live</p>" folderRoot={host} />);
      await tick();
      expect(host.setOverlay).toHaveBeenCalledWith("r0", "index.html", "<p>live</p>");
    });

    it("debounced edits re-push the overlay and bump the cache-buster", async () => {
      const [content, setContent] = createSignal("<p>v1</p>");
      const host = makeHost();
      const { container } = render(() => (
        <HtmlPreview content={content()} folderRoot={host} />
      ));
      await tick();
      expect(frame(container).getAttribute("src")).toBe(
        "markdraw-preview://r0/?am-token=r0&am-entry=index.html&v=0",
      );

      setContent("<p>v2</p>");
      await tick(450);
      expect(host.setOverlay).toHaveBeenLastCalledWith("r0", "index.html", "<p>v2</p>");
      expect(frame(container).getAttribute("src")).toBe(
        "markdraw-preview://r0/?am-token=r0&am-entry=index.html&v=1",
      );
    });

    it("clears the overlay on unmount so requests fall back to disk", async () => {
      const host = makeHost();
      const { unmount } = render(() => <HtmlPreview content="<p>x</p>" folderRoot={host} />);
      await tick();
      unmount();
      expect(host.clearOverlay).toHaveBeenCalledWith("r0", "index.html");
    });

    it("relative-document mode loads the entry at its TRUE path (no am-entry)", async () => {
      // ownRoot:false → served from the workspace folder at the file's real
      // path, so the browser resolves `../` against the file's actual location.
      const host = makeHost({
        register: vi.fn(async () => ({
          token: "r3",
          entryRel: "course/lessons/0001.html",
          ownRoot: false,
        })),
      });
      const { container } = render(() => (
        <HtmlPreview content="<p>doc</p>" folderRoot={host} />
      ));
      await tick();
      expect(frame(container).getAttribute("src")).toBe(
        "markdraw-preview://r3/course/lessons/0001.html?am-token=r3&v=0",
      );
      // The overlay is keyed by the FULL relative path in document mode.
      expect(host.setOverlay).toHaveBeenCalledWith("r3", "course/lessons/0001.html", "<p>doc</p>");
    });

    it("renders nothing when registration fails (null target)", async () => {
      const host = makeHost({ register: vi.fn(async () => null) });
      const { container } = render(() => (
        <HtmlPreview content="<p>nope</p>" folderRoot={host} />
      ));
      await tick();
      // No usable src → no iframe at all (blank pane) rather than an
      // unrooted srcdoc that would mis-resolve assets.
      expect(container.querySelector("iframe.html-preview-frame")).toBeNull();
      expect(host.setOverlay).not.toHaveBeenCalled();
    });

    it("unmounts the previous document the moment the file switches", async () => {
      const hostA = makeHost();
      let resolveB!: (v: { token: string; entryRel: string; ownRoot: boolean }) => void;
      const hostB = makeHost({
        register: vi.fn(() => new Promise<{ token: string; entryRel: string; ownRoot: boolean }>((r) => {
          resolveB = r;
        })),
      });
      const [folderRoot, setFolderRoot] = createSignal(hostA);
      const { container } = render(() => (
        <HtmlPreview content="<p>x</p>" folderRoot={folderRoot()} />
      ));
      await tick();
      expect(frame(container).getAttribute("src")).toContain("am-token=r0");

      // Switch files while the new registration is still in flight: the old
      // iframe must be GONE immediately — the resource still hands out the
      // stale target, so keeping the iframe would ghost the previous doc.
      setFolderRoot(hostB);
      await tick(0);
      expect(container.querySelector("iframe.html-preview-frame")).toBeNull();

      resolveB({ token: "r9", entryRel: "other.html", ownRoot: true });
      await tick();
      expect(frame(container).getAttribute("src")).toBe(
        "markdraw-preview://r9/?am-token=r9&am-entry=other.html&v=0",
      );
    });
  });
});
