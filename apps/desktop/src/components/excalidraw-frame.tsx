import { invoke } from "@tauri-apps/api/core";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
// Registers the <z-frame> custom element (from the published @zomme/frame core).
import "@zomme/frame";
import type { ExcalidrawScene } from "@asciimark/ui/composables/ai-context.ts";

interface Scene {
  appState?: Record<string, unknown>;
  elements?: unknown[];
  /** Binary blobs backing image elements (Excalidraw's top-level `files` map).
   *  Round-trips through disk so images (pasted, or a Mermaid image fallback)
   *  don't reopen broken. */
  files?: Record<string, unknown>;
}

/** Where an AI-generated diagram lands relative to existing canvas content.
 *  MIRRORS the guest's `ApplyMode` (frame repo, app-excalidraw/src/App.tsx) —
 *  keep the two string unions in sync. */
export type ExcalidrawApplyMode = "replace-selection" | "append" | "replace-all";

export interface ExcalidrawWriteInput {
  /** Mermaid source (flowchart/sequence/class/ER — the editable types). */
  mermaid: string;
  mode: ExcalidrawApplyMode;
}

export interface ExcalidrawWriteResult {
  ok: boolean;
  /** The mode actually used — `replace-selection` degrades to `append` when
   *  nothing is selected, so the caller (and the model) sees what happened. */
  mode: ExcalidrawApplyMode;
  added: number;
  removed: number;
  error?: string;
}

/** The host-facing handle a mounted `<ExcalidrawFrame>` registers for its file:
 *  read the live scene (⌘I context) and write a diagram into it (AI tool). */
export interface ExcalidrawFrameApi {
  getScene: () => Promise<ExcalidrawScene | null>;
  applyMermaid: (input: ExcalidrawWriteInput) => Promise<ExcalidrawWriteResult>;
}

interface ExcalidrawFrameProps {
  /** Absolute path of the `.excalidraw` file on disk. */
  filePath: string;
  /** Register/unregister the host handle for THIS file (read scene + write
   *  diagram). Called with the API while mounted and `null` on cleanup; re-keyed
   *  if `filePath` changes on a reused instance. */
  onFrameApi?: (filePath: string, api: ExcalidrawFrameApi | null) => void;
}

const RESERVED = new Set([
  "name",
  "src",
  "sandbox",
  "base",
  "pathname",
  "class",
  "id",
  "style",
  "ref",
  "children",
]);
const isEventKey = (key: string) => /^on[A-Z]/.test(key);

// Inline port of @zomme/frame-solid's <Frame> host wrapper: reactive attributes,
// `on<Event>` → addEventListener, everything else → DOM property forwarded to
// the guest through the z-frame.
function Frame(props: Record<string, unknown> & { name: string; src: string }): HTMLElement {
  const el = document.createElement("z-frame");
  // Hand the element back so the host can call guest-registered RPCs on it
  // (e.g. `el.getScene()`); RESERVED keeps `ref` out of the property-forward loop.
  if (typeof props.ref === "function") (props.ref as (e: HTMLElement) => void)(el);
  const attached: [string, EventListener][] = [];
  const setAttr = (name: string, value: unknown) => {
    if (value == null) el.removeAttribute(name);
    else el.setAttribute(name, String(value));
  };

  // Set `sandbox`/`pathname` BEFORE `src`: the z-frame builds the iframe when
  // `src` lands (reading `pathname` to form the final URL), so setting them
  // afterwards forces a wasteful iframe recreation on mount.
  createEffect(() => setAttr("name", props.name));
  createEffect(() => setAttr("sandbox", (props.sandbox as string) ?? "allow-scripts allow-same-origin"));
  createEffect(() => setAttr("pathname", props.pathname));
  createEffect(() => setAttr("src", props.src));
  createEffect(() => setAttr("style", props.style));

  onMount(() => {
    for (const key of Object.keys(props)) {
      if (!isEventKey(key) || typeof props[key] !== "function") continue;
      const eventName = key.slice(2).toLowerCase();
      const handler: EventListener = (event) => {
        const fn = props[key];
        if (typeof fn === "function") (fn as (e: Event) => void)(event);
      };
      el.addEventListener(eventName, handler);
      attached.push([eventName, handler]);
    }
  });
  onCleanup(() => {
    for (const [eventName, handler] of attached) el.removeEventListener(eventName, handler);
  });

  createEffect(() => {
    for (const key of Object.keys(props)) {
      if (RESERVED.has(key) || isEventKey(key)) continue;
      (el as unknown as Record<string, unknown>)[key] = props[key];
    }
  });

  return el;
}

function sceneToFile(scene: Scene): string {
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "asciimark",
    appState: scene.appState ?? {},
    elements: scene.elements ?? [],
    files: scene.files ?? {},
  });
}

/**
 * Embedded Excalidraw editor for a `.excalidraw` file, shown in the pane in
 * place of the markdown/asciidoc preview (caminho B). Desktop-only: the guest
 * (the real Excalidraw editor) runs in the z-frame's iframe; this host loads
 * the file (`read_file`) into it and persists edits (`write_file`) back to disk.
 *
 * Persistence lives HERE, not in the iframe: the guest pushes its current scene
 * on every (coalesced) change; we keep the latest, debounce the disk write, and
 * **flush on cleanup** — which runs while the iframe is still alive, before a
 * tab switch (file change) or unmount. That's why the last edit isn't lost when
 * you switch files (the previous bug: the debounce lived in the iframe and died
 * with it).
 */
export function ExcalidrawFrame(props: ExcalidrawFrameProps) {
  const [scene, setScene] = createSignal<Scene | undefined>(undefined);
  let latest: Scene | undefined;
  let writeTimer: ReturnType<typeof setTimeout> | undefined;

  const writeNow = (path: string, s: Scene) => {
    void invoke("write_file", { path, content: sceneToFile(s) });
  };

  // (Re)load when the target file changes; flush the previous file's latest edit
  // before switching (and on unmount) via the effect's onCleanup.
  createEffect(() => {
    const path = props.filePath;
    setScene(undefined);
    latest = undefined;
    invoke<string>("read_file", { path })
      .then((content) => {
        const json = JSON.parse(content) as Scene;
        setScene({
          appState: json.appState ?? {},
          elements: json.elements ?? [],
          files: json.files ?? {},
        });
      })
      .catch(() => {
        setScene({ appState: {}, elements: [], files: {} });
      });

    onCleanup(() => {
      clearTimeout(writeTimer);
      writeTimer = undefined;
      if (latest) writeNow(path, latest);
    });
  });

  // Called by the guest (RPC) on every coalesced change. Keep the latest scene
  // and debounce the disk write; onCleanup flushes whatever is pending.
  const save = async (s: Scene) => {
    latest = s;
    const path = props.filePath;
    clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      writeTimer = undefined;
      writeNow(path, s);
    }, 400);
    return { ok: true };
  };

  // The guest ships as a static asset under the app's own origin (see
  // scripts/prepare-excalidraw-guest.mjs, which copies its build into
  // public/excalidraw/). Loading it from the app's own origin makes it
  // same-origin with the host in BOTH dev (vite :2444) and prod (Tauri app
  // protocol) — no standalone server, and no cross-origin frame block.
  //
  // The z-frame forms the iframe URL as `src` (an origin/base) + `pathname`
  // (the route, default "/"). We must land on the EXACT file `/excalidraw/
  // index.html`: vite's dev server SPA-falls-back to the host's own index.html
  // for any directory/non-file path (so `/excalidraw/` would recursively load
  // AsciiMark itself). So pass the origin as `src` and the full file path as
  // `pathname`. `src` is also absolute, as the z-frame does `new URL(this.src)`.
  const guestOrigin = window.location.origin;

  // Captured z-frame element — the guest registers `getScene`/`applyMermaid` as
  // callable methods on it (RPC) once the iframe handshake completes.
  let frameEl:
    | (HTMLElement & {
        getScene?: () => Promise<ExcalidrawScene>;
        applyMermaid?: (input: ExcalidrawWriteInput) => Promise<ExcalidrawWriteResult>;
      })
    | undefined;

  // The handle is stable (its closures read the stable `frameEl`); only its
  // registry key (filePath) is reactive — so register in an effect that re-keys
  // on a file switch rather than a one-shot onMount.
  const api: ExcalidrawFrameApi = {
    getScene: async () => {
      if (typeof frameEl?.getScene !== "function") return null;
      try {
        return (await frameEl.getScene()) ?? null;
      } catch {
        return null;
      }
    },
    applyMermaid: async (input) => {
      const fail = (error: string): ExcalidrawWriteResult => ({
        ok: false,
        mode: input.mode,
        added: 0,
        removed: 0,
        error,
      });
      if (typeof frameEl?.applyMermaid !== "function") return fail("Excalidraw editor not ready");
      try {
        return await frameEl.applyMermaid(input);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  };
  createEffect(() => {
    const path = props.filePath;
    props.onFrameApi?.(path, api);
    onCleanup(() => props.onFrameApi?.(path, null));
  });

  return (
    <Frame
      name="excalidraw"
      src={guestOrigin}
      pathname="/excalidraw/index.html"
      style="width:100%;height:100%;border:0;display:block"
      drawingData={scene()}
      save={save}
      ref={(el: HTMLElement) => (frameEl = el as typeof frameEl)}
    />
  );
}
