import { invoke } from "@tauri-apps/api/core";
import { createEffect, createSignal, onCleanup, onMount, untrack } from "solid-js";
// Registers the <z-frame> custom element (from the published @zomme/frame core).
import "@zomme/frame";
import { SHORTCUTS, detectPlatform } from "@asciimark/core/keyboard-shortcuts.ts";
import { effectiveKeys, matchBinding } from "@asciimark/core/keybindings.ts";
// Canonical `.excalidraw` serializer — shared with the headless generator so the
// on-disk envelope has a single source of truth (see packages/diagram).
import { sceneToFile } from "@asciimark/diagram/scene.ts";
import type { ExcalidrawScene } from "@asciimark/ui/composables/ai-context.ts";

export interface Scene {
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
  /** Temporarily disables host-side persistence while the backing file is
   *  being deleted/moved away by the shell. */
  suppressSave?: boolean;
  /** Bump to force a reload of the file from disk without changing `filePath` —
   *  used when the host rewrites the backing file (e.g. AI spec generation) and
   *  needs the open canvas to pick up the new content. Pair with `suppressSave`
   *  around the rewrite so the reload doesn't flush stale edits over it. */
  reloadToken?: number;
  /** Ephemeral (scratch) mode: never read or write the backing file. The canvas
   *  starts from `initialScene` (held in host memory across tab switches) and
   *  every change is reported via `onScene` instead of persisting to disk. Disk
   *  is touched only when the host later saves the scene elsewhere. */
  ephemeral?: boolean;
  initialScene?: Scene;
  onScene?: (scene: Scene) => void;
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
    if (props.suppressSave) return;
    void invoke("write_file", { path, content: sceneToFile(s) });
  };

  createEffect(() => {
    if (!props.suppressSave) return;
    clearTimeout(writeTimer);
    writeTimer = undefined;
  });

  // (Re)load when the target file changes; flush the previous file's latest edit
  // before switching (and on unmount) via the effect's onCleanup.
  createEffect(() => {
    const path = props.filePath;
    // Track the reload nonce so a host-side rewrite re-runs this effect and
    // re-reads the file even when `filePath` is unchanged.
    void props.reloadToken;
    // Ephemeral (scratch) mode: seed from the host-held scene and never touch
    // disk. `untrack` so a later host scene update (on every edit) doesn't
    // re-run this effect and reset the canvas — we only re-seed when `filePath`
    // (a tracked dep) changes, i.e. on a real switch between scratch canvases.
    if (props.ephemeral) {
      setScene(untrack(() => props.initialScene) ?? { appState: {}, elements: [], files: {} });
      latest = undefined;
      return;
    }
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
    if (props.suppressSave) return { ok: true };
    // Ephemeral scratch: hand the scene to the host (kept in memory) instead of
    // writing it to disk. Materialized only on an explicit save-as.
    if (props.ephemeral) {
      props.onScene?.(s);
      return { ok: true };
    }
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

  // ── Host shortcut forwarding ──────────────────────────────────────────────
  // Keydown never crosses the iframe boundary, so with the canvas focused no
  // host shortcut (e.g. ⌘I "ai.inlineAction") would ever fire. The guest is
  // same-origin (served from our own origin, see `guestOrigin`), so once the
  // z-frame handshake completes we can reach into its document and listen in
  // the capture phase. Only chords that match the SHORTCUTS catalog (with the
  // user's overrides) are forwarded — window also hosts opportunistic listeners
  // (e.g. the preview's Ctrl+F) that would happily claim any forwarded clone
  // and steal chords Excalidraw owns natively, so everything off-catalog stays
  // inside the canvas. A matched clone is dispatched on the HOST window, and
  // only if a binding consumes it (defaultPrevented) do we swallow the
  // original. The clone lands on the host window, never back inside the
  // iframe, so forwarding cannot recurse.
  const forwardedDocs = new WeakSet<Document>();
  let detachKeyForwarding: (() => void) | undefined;

  const hostClaimsChord = (e: KeyboardEvent): boolean => {
    const platform = detectPlatform(typeof navigator === "undefined" ? "" : navigator.platform);
    return SHORTCUTS.some((s) => matchBinding(e, effectiveKeys(s.id, platform)));
  };

  const forwardHostShortcuts = (e: KeyboardEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    if (!hostClaimsChord(e)) return;
    const clone = new KeyboardEvent("keydown", {
      altKey: e.altKey,
      bubbles: true,
      cancelable: true,
      code: e.code,
      ctrlKey: e.ctrlKey,
      key: e.key,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
    });
    window.dispatchEvent(clone);
    if (clone.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // Runs on every z-frame "ready" — which re-fires on reconnect. The WeakSet
  // keeps the listener single per document while still re-attaching when the
  // iframe (and thus its document) is recreated; the stale document's listener
  // is detached before the new one is wired.
  const attachKeyForwarding = () => {
    const doc = frameEl?.querySelector("iframe")?.contentDocument;
    if (!doc || forwardedDocs.has(doc)) return;
    detachKeyForwarding?.();
    forwardedDocs.add(doc);
    doc.addEventListener("keydown", forwardHostShortcuts, true);
    detachKeyForwarding = () => {
      forwardedDocs.delete(doc);
      doc.removeEventListener("keydown", forwardHostShortcuts, true);
    };
  };

  onCleanup(() => {
    detachKeyForwarding?.();
    detachKeyForwarding = undefined;
  });

  return (
    <Frame
      name="excalidraw"
      src={guestOrigin}
      pathname="/excalidraw/index.html"
      style="width:100%;height:100%;border:0;display:block"
      drawingData={scene()}
      save={save}
      onReady={attachKeyForwarding}
      ref={(el: HTMLElement) => (frameEl = el as typeof frameEl)}
    />
  );
}
