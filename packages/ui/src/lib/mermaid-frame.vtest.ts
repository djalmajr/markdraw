import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MermaidFrameWindow } from "./mermaid-frame.ts";

const main = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));
vi.mock("mermaid", () => ({ default: main }));
vi.mock("./mermaid-frame-entry.ts?worker&url", () => ({ default: "/assets/mermaid-frame-entry.js" }));

const SOURCE = "graph LR; A-->B";
const SVG = { svg: '<svg viewBox="0 0 10 10"></svg>' };
const CONFIG = {
  startOnLoad: false,
  theme: "default",
  look: "classic",
  layout: "dagre",
  securityLevel: "strict",
  fontFamily: "inherit",
};

let module: typeof import("./mermaid-frame.ts");
let article: HTMLElement;
let child: Document;
let realm: MermaidFrameWindow;
let api: { initialize: ReturnType<typeof vi.fn>; render: ReturnType<typeof vi.fn> };
let iframe: HTMLIFrameElement | undefined;
let frames: HTMLIFrameElement[];
let frameLoadEvent: Event | undefined;
let entryScript: HTMLScriptElement | undefined;
let releasePreviews: Array<() => void>;
let warning: ReturnType<typeof vi.spyOn<typeof console, "warn">>;

function mountPreview() {
  const release = module.retainMermaidFrame();
  const unmount = () => {
    releasePreviews = releasePreviews.filter((cleanup) => cleanup !== unmount);
    release();
  };
  releasePreviews.push(unmount);
  return unmount;
}

function loadFrameEntry() {
  expect(iframe?.isConnected).toBe(true);
  frameLoadEvent = new Event("load");
  iframe!.dispatchEvent(frameLoadEvent);
  if (!entryScript) throw new Error("iframe did not request the entry script");
  return entryScript;
}

function signalEntryReady(script: HTMLScriptElement) {
  realm.markdrawMermaid = api;
  script.dispatchEvent(new Event("load"));
}

function render(id: string, source = SOURCE, theme: "dark" | "default" = "default", isStale?: () => boolean) {
  return module.withMermaidLock(() => module.renderInFrame(id, source, theme, article, isStale));
}

beforeEach(async () => {
  vi.resetModules();
  main.initialize.mockReset();
  main.render.mockReset().mockResolvedValue(SVG);
  warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  module = await import("./mermaid-frame.ts");

  article = document.createElement("article");
  document.body.append(article);
  child = document.implementation.createHTMLDocument();
  realm = {} as MermaidFrameWindow;
  api = { initialize: vi.fn(), render: vi.fn().mockResolvedValue(SVG) };
  iframe = undefined;
  frames = [];
  frameLoadEvent = undefined;
  entryScript = undefined;
  releasePreviews = [];

  vi.spyOn(child.head, "append").mockImplementation((script) => {
    if (script instanceof HTMLScriptElement) entryScript = script;
  });
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag, options) => {
    const element = createElement(tag, options);
    if (tag === "iframe") {
      iframe = element as HTMLIFrameElement;
      frames.push(iframe);
      const dispatchEvent = iframe.dispatchEvent.bind(iframe);
      vi.spyOn(iframe, "dispatchEvent").mockImplementation((event) =>
        event.type === "load" && event !== frameLoadEvent ? true : dispatchEvent(event)
      );
      Object.defineProperties(iframe, {
        contentDocument: { get: () => child },
        contentWindow: { get: () => realm },
      });
    }
    return element;
  });
});

afterEach(async () => {
  try {
    for (const release of releasePreviews) release();
    await module.withMermaidLock(async () => {});
  } finally {
    article.remove();
    for (const frame of frames) frame.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

describe("Mermaid iframe", () => {
  it("loads its own entry on demand and prewarms only after it is ready", async () => {
    mountPreview();
    expect(iframe).toBeUndefined();

    const pending = module.ensureMermaidWarm(article);
    expect(module.ensureMermaidWarm(article)).toBe(pending);
    await vi.waitFor(() => expect(iframe?.isConnected).toBe(true));
    const entry = loadFrameEntry();
    expect(entry.src).toBe(new URL("/assets/mermaid-frame-entry.js", document.baseURI).href);
    expect(entry.type).toBe("module");
    expect(iframe!.style.visibility).toBe("hidden");
    expect(iframe!.style.width).toBe("1600px");
    expect(iframe!.style.height).toBe("1200px");
    expect(main.render).not.toHaveBeenCalled();
    expect(api.render).not.toHaveBeenCalled();

    signalEntryReady(entry);
    await pending;
    await expect(render("mermaid-first")).resolves.toEqual(SVG);
    expect(api.render).toHaveBeenNthCalledWith(1, "mermaid-prewarm", expect.stringContaining("cylinder"));
    expect(api.render).toHaveBeenNthCalledWith(2, "mermaid-first", SOURCE);
    expect(main.render).not.toHaveBeenCalled();
  });

  it("copies computed article typography before each render", async () => {
    mountPreview();
    const typography = vi.fn(() => ({
      fontFamily: child.body.style.fontFamily,
      fontSize: child.body.style.fontSize,
      lineHeight: child.body.style.lineHeight,
    }));
    api.render.mockImplementation(async () => {
      typography();
      return SVG;
    });
    article.style.cssText = "font-family:Georgia,serif;font-size:18px;line-height:27px";
    const first = render("mermaid-first");
    await vi.waitFor(() => expect(iframe?.isConnected).toBe(true));
    signalEntryReady(loadFrameEntry());
    await expect(first).resolves.toEqual(SVG);

    article.style.cssText = "font-family:monospace;font-size:20px;line-height:32px";
    await expect(render("mermaid-next")).resolves.toEqual(SVG);
    expect(typography.mock.results.map(({ value }) => value)).toEqual([
      { fontFamily: "Georgia, serif", fontSize: "18px", lineHeight: "27px" },
      { fontFamily: "monospace", fontSize: "20px", lineHeight: "32px" },
    ]);
  });

  it("initializes once per theme and preserves the Mermaid 11 appearance", async () => {
    mountPreview();
    const first = render("mermaid-first");
    await vi.waitFor(() => expect(iframe?.isConnected).toBe(true));
    signalEntryReady(loadFrameEntry());
    await first;

    await render("mermaid-same-theme");
    await render("mermaid-dark", SOURCE, "dark");
    await render("mermaid-dark-again", SOURCE, "dark");
    expect(api.initialize.mock.calls).toEqual([[CONFIG], [{ ...CONFIG, theme: "dark" }]]);
  });

  it("serializes render requests from distinct mounted previews", async () => {
    mountPreview();
    mountPreview();
    let finishFirst!: (value: typeof SVG) => void;
    api.render.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));

    const first = render("mermaid-first");
    const second = render("mermaid-second");
    try {
      await vi.waitFor(() => expect(iframe?.isConnected).toBe(true));
      signalEntryReady(loadFrameEntry());
      await vi.waitFor(() => expect(api.render).toHaveBeenCalledWith("mermaid-first", SOURCE));
      expect(api.render).toHaveBeenCalledTimes(1);
    } finally {
      finishFirst?.(SVG);
    }
    await expect(first).resolves.toEqual(SVG);
    await expect(second).resolves.toEqual(SVG);
    expect(api.render).toHaveBeenLastCalledWith("mermaid-second", SOURCE);
  });

  it("falls back after five seconds and keeps using the main document after remount", async () => {
    vi.useFakeTimers();
    const unmount = mountPreview();
    const pending = render("mermaid-timeout", SOURCE, "dark");
    const result = pending.catch((error) => error);
    await vi.advanceTimersByTimeAsync(4999);
    const initialFrame = iframe;
    expect(initialFrame?.isConnected).toBe(true);
    loadFrameEntry();
    expect(main.render).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual(SVG);
    expect(initialFrame?.isConnected).toBe(false);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(main.initialize).toHaveBeenCalledWith({ ...CONFIG, theme: "dark" });
    expect(main.render).toHaveBeenCalledWith("mermaid-timeout", SOURCE);

    unmount();
    mountPreview();
    await expect(render("mermaid-next")).resolves.toEqual(SVG);
    expect(iframe).toBe(initialFrame);
    expect(main.render).toHaveBeenLastCalledWith("mermaid-next", SOURCE);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it("falls back when a lazy Mermaid module cannot load in the iframe", async () => {
    mountPreview();
    const pending = render("mermaid-chunk-error");
    await vi.waitFor(() => expect(iframe?.isConnected).toBe(true));
    api.render.mockRejectedValueOnce({ name: "TypeError", message: "Importing a module script failed." });
    signalEntryReady(loadFrameEntry());
    await expect(pending).resolves.toEqual(SVG);
    expect(main.render).toHaveBeenCalledWith("mermaid-chunk-error", SOURCE);
    expect(iframe?.isConnected).toBe(false);
  });

  it("surfaces syntax errors without switching renderers and cleans up temporary markup", async () => {
    mountPreview();
    const syntax = { name: "UnknownDiagramError", message: "No diagram type detected" };
    api.render.mockImplementationOnce(async (id: string) => {
      const temp = child.createElement("div");
      temp.id = `d${id}`;
      child.body.append(temp);
      throw syntax;
    });
    const pending = render("mermaid-bad", "invalid diagram source");
    const result = pending.catch((error) => error);
    await vi.waitFor(() => expect(iframe?.isConnected).toBe(true));
    signalEntryReady(loadFrameEntry());
    expect(await result).toBe(syntax);
    expect(child.getElementById("dmermaid-bad")).toBeNull();
    await expect(render("mermaid-valid")).resolves.toEqual(SVG);
    expect(api.render).toHaveBeenLastCalledWith("mermaid-valid", SOURCE);
    expect(main.render).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
  });

  it("removes the iframe only after the last preview unmounts", async () => {
    const unmountFirst = mountPreview();
    const unmountLast = mountPreview();
    const pending = render("mermaid-first");
    await vi.waitFor(() => expect(iframe?.isConnected).toBe(true));
    const initialFrame = iframe;
    signalEntryReady(loadFrameEntry());
    await pending;

    unmountFirst();
    expect(initialFrame?.isConnected).toBe(true);
    await render("mermaid-other-preview");
    expect(iframe).toBe(initialFrame);
    unmountLast();
    expect(initialFrame?.isConnected).toBe(false);

    mountPreview();
    const next = render("mermaid-remounted");
    await vi.waitFor(() => expect(iframe).not.toBe(initialFrame));
    signalEntryReady(loadFrameEntry());
    await expect(next).resolves.toEqual(SVG);
  });

  it("abandons loading on last unmount without enabling the fallback", async () => {
    const unmount = mountPreview();
    const pending = render("mermaid-unmounted");
    const result = pending.catch((error) => error);
    await vi.waitFor(() => expect(iframe?.isConnected).toBe(true));
    const initialFrame = iframe;
    const oldEntry = loadFrameEntry();
    unmount();
    signalEntryReady(oldEntry);
    expect(await result).toMatchObject({ name: "AbortError" });
    expect(initialFrame?.isConnected).toBe(false);
    expect(main.render).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
  });

  it("releases the lock when teardown interrupts an active iframe render", async () => {
    const unmount = mountPreview();
    let finishRender: ((svg: typeof SVG) => void) | undefined;
    api.render.mockImplementationOnce(() => new Promise((resolve) => { finishRender = resolve; }));
    const pending = render("mermaid-unmounted");
    const disposition = vi.fn();
    void pending.then(disposition, disposition);
    try {
      await vi.waitFor(() => expect(iframe?.isConnected).toBe(true));
      signalEntryReady(loadFrameEntry());
      await vi.waitFor(() => expect(finishRender).toBeTypeOf("function"));
      unmount();
      await vi.waitFor(() => expect(disposition).toHaveBeenCalledWith(expect.objectContaining({ name: "AbortError" })));
    } finally {
      finishRender?.(SVG);
    }
    expect(warning).not.toHaveBeenCalled();
  });

  it("does not start a superseded render when the entry becomes ready", async () => {
    mountPreview();
    let stale = false;
    const pending = render("mermaid-stale", SOURCE, "default", () => stale);
    const result = pending.catch((error) => error);
    await vi.waitFor(() => expect(iframe?.isConnected).toBe(true));
    const entry = loadFrameEntry();
    stale = true;
    signalEntryReady(entry);
    expect(await result).toMatchObject({ name: "AbortError" });
    expect(api.render).not.toHaveBeenCalled();
    expect(main.render).not.toHaveBeenCalled();
    await expect(render("mermaid-current")).resolves.toEqual(SVG);
  });
});
