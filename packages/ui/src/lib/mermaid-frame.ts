import frameEntryUrl from "./mermaid-frame-entry.ts?worker&url";
import { MERMAID_CONFIG } from "./mermaid-cache.ts";

type Theme = "dark" | "default";
type MermaidApi = Pick<typeof import("mermaid").default, "initialize" | "render">;
type SvgResult = { svg: string };

export type MermaidFrameWindow = Window & { markdrawMermaid?: MermaidApi };

type Frame = {
  ready: Promise<{ api: MermaidApi; document: Document }>;
  theme?: Theme;
  dispose: () => void;
  signal: AbortSignal;
};

let frame: Frame | undefined;
let previewCount = 0;
let mainDocumentOnly = false;
let mainTheme: Theme | undefined;
let mermaidQueue: Promise<void> = Promise.resolve();
let warmPromise: Promise<void> | undefined;

export function retainMermaidFrame(): () => void {
  previewCount++;
  return () => {
    if (--previewCount > 0) return;
    frame?.dispose();
    frame = undefined;
    warmPromise = undefined;
  };
}

export function withMermaidLock<T>(work: () => Promise<T>): Promise<T> {
  const result = mermaidQueue.then(work);
  mermaidQueue = result.then(() => {}, () => {});
  return result;
}

function openFrame(host: Document): Frame {
  const iframe = host.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.tabIndex = -1;
  iframe.style.cssText = "position:fixed;left:-10000px;width:1600px;height:1200px;visibility:hidden";
  iframe.srcdoc = "<!doctype html><html><head></head><body></body></html>";
  const controller = new AbortController();
  const { signal } = controller;
  const listeners = new AbortController();
  const onLoad = { once: true, signal: listeners.signal };
  let timer: ReturnType<typeof setTimeout>;

  const ready = new Promise<{ api: MermaidApi; document: Document }>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Mermaid iframe did not load within 5 seconds")), 5000);
    signal.addEventListener("abort", () => reject(signal.reason), onLoad);
    iframe.addEventListener("load", () => {
      try {
        const realm = iframe.contentWindow as MermaidFrameWindow | null;
        const child = iframe.contentDocument;
        if (!realm || !child?.body) throw new Error("Mermaid iframe document is unavailable");

        const script = child.createElement("script");
        if (import.meta.env.DEV) script.type = "module";
        script.src = new URL(frameEntryUrl, host.baseURI).href;
        script.addEventListener("load", () => {
          const api = realm.markdrawMermaid;
          if (api) resolve({ api, document: child });
          else reject(new Error("Mermaid iframe entry did not expose its API"));
        }, onLoad);
        script.addEventListener("error", () => reject(new Error("Mermaid iframe entry failed to load")), onLoad);
        child.head.append(script);
      } catch (error) {
        reject(error);
      }
    }, onLoad);
    host.body.append(iframe);
  }).finally(() => {
    clearTimeout(timer);
    listeners.abort();
  });

  return {
    ready,
    signal,
    dispose: () => {
      controller.abort();
      iframe.remove();
    },
  };
}

function initMermaid(api: MermaidApi, theme: Theme) {
  api.initialize({ startOnLoad: false, theme, ...MERMAID_CONFIG });
}

function checkCurrent(isStale: () => boolean, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (isStale()) throw new DOMException("Mermaid render was superseded", "AbortError");
}

// Lazy diagram modules can fail after the iframe entry has loaded. Mermaid
// propagates the browser's import error through the same promise as parse errors.
function isModuleLoadError(error: unknown): boolean {
  const err = error as { name?: string; message?: string } | undefined;
  return err?.name === "TypeError" && typeof err.message === "string"
    && /^(?:Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module)/i.test(err.message);
}

async function finishRender(
  result: Promise<SvgResult>,
  id: string,
  doc: Document,
  signal?: AbortSignal,
): Promise<SvgResult> {
  let cancel: (() => void) | undefined;
  try {
    if (signal) {
      const disposed = new Promise<never>((_, reject) => {
        cancel = () => reject(signal.reason);
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
      });
      result = Promise.race([result, disposed]);
    }
    const { svg } = await result;
    return { svg };
  } finally {
    if (cancel) signal?.removeEventListener("abort", cancel);
    doc.getElementById(`d${id}`)?.remove();
  }
}

export async function renderInFrame(
  id: string,
  source: string,
  theme: Theme,
  article: HTMLElement,
  isStale: () => boolean = () => false,
): Promise<SvgResult> {
  const host = article.ownerDocument;
  checkCurrent(isStale);

  if (!mainDocumentOnly) {
    let current: Frame | undefined;
    let rendering = false;
    try {
      current = frame ??= openFrame(host);
      const { api, document: child } = await current.ready;
      checkCurrent(isStale, current.signal);

      const { fontFamily, fontSize, lineHeight } = host.defaultView!.getComputedStyle(article);
      Object.assign(child.body.style, { fontFamily, fontSize, lineHeight });
      if (current.theme !== theme) {
        initMermaid(api, theme);
        current.theme = theme;
      }
      const result = api.render(id, source);
      rendering = true;
      return await finishRender(result, id, child, current.signal);
    } catch (error) {
      if (current?.signal.aborted || isStale()) throw error;
      if (rendering && !isModuleLoadError(error)) throw error;
      mainDocumentOnly = true;
      current?.dispose();
      frame = undefined;
      console.warn("[mermaid] iframe unavailable, rendering in the main document", error);
    }
  }

  const { default: api } = await import("mermaid");
  checkCurrent(isStale);
  if (mainTheme !== theme) {
    initMermaid(api, theme);
    mainTheme = theme;
  }
  return finishRender(api.render(id, source), id, host);
}

export function ensureMermaidWarm(article: HTMLElement): Promise<void> {
  if (warmPromise) return warmPromise;
  const host = article.ownerDocument;
  const warming = Promise.resolve(host.fonts?.ready)
    .catch(() => {})
    .then(() => withMermaidLock(async () => {
      if (warmPromise !== warming) return;
      if (!article.isConnected) {
        warmPromise = undefined;
        return;
      }
      const theme = host.documentElement.classList.contains("dark") ? "dark" : "default";
      // Exercise the common lazy shape renderers before a user-facing render.
      await renderInFrame(
        "mermaid-prewarm",
        "graph LR\nA[box] --> B(rounded)\nB --> C{diamond}\nC -->|label| D[(cylinder)]\nD --> E([stadium])",
        theme,
        article,
        () => warmPromise !== warming,
      );
    }))
    .catch((error) => {
      if (warmPromise === warming) console.warn("[mermaid] pre-warm failed", error);
    });
  warmPromise = warming;
  return warming;
}
