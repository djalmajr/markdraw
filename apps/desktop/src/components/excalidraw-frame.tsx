import { invoke } from "@tauri-apps/api/core";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
// Registers the <z-frame> custom element (from the published @zomme/frame core).
import "@zomme/frame";

interface Scene {
  appState?: Record<string, unknown>;
  elements?: unknown[];
}

interface ExcalidrawFrameProps {
  /** Absolute path of the `.excalidraw` file on disk. */
  filePath: string;
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
  const attached: [string, EventListener][] = [];
  const setAttr = (name: string, value: unknown) => {
    if (value == null) el.removeAttribute(name);
    else el.setAttribute(name, String(value));
  };

  // Set `sandbox` BEFORE `src`: the z-frame builds the iframe when `src` lands,
  // so setting sandbox afterwards forces a wasteful iframe recreation on mount.
  createEffect(() => setAttr("name", props.name));
  createEffect(() => setAttr("sandbox", (props.sandbox as string) ?? "allow-scripts allow-same-origin"));
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
        setScene({ appState: json.appState ?? {}, elements: json.elements ?? [] });
      })
      .catch(() => {
        setScene({ appState: {}, elements: [] });
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

  return (
    <Frame
      name="excalidraw"
      // TODO(prod): serve the guest as a bundled static asset instead of the
      // app-excalidraw vite dev server. Match the host's hostname (127.0.0.1
      // vs localhost are different origins): the z-frame needs same-origin
      // with the guest, so deriving it from window.location avoids the
      // "Blocked a frame ... Protocols, domains, and ports must match" error.
      src={`http://${typeof window !== "undefined" ? window.location.hostname : "localhost"}:4204/`}
      style="width:100%;height:100%;border:0;display:block"
      drawingData={scene()}
      save={save}
    />
  );
}
