// Floating Figma Capture button — only visible in dev mode.
//
// Writes a `#figmacapture=<key>&figmaselector=#root` hash to the URL
// (via history.replaceState — NOT a full reload) and re-injects
// `capture.js` from mcp.figma.com so it serializes the live DOM and
// drops the snapshot into the clipboard for paste-into-Figma.
//
// The Figma file key is read from `VITE_FIGMA_KEY` first, then falls
// back to localStorage. A small popover lets the user paste the key
// inline (we avoid `window.prompt`, which is unreliable inside Tauri's
// WKWebView).

import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import {
  writeText as tauriWriteText,
  writeImage as tauriWriteImage,
  writeHtml as tauriWriteHtml,
} from "@tauri-apps/plugin-clipboard-manager";

import { Button } from "@markdraw/ui/components/ui/button.tsx";
import {
  TextField,
  TextFieldInput,
} from "@markdraw/ui/components/ui/text-field.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@markdraw/ui/components/ui/popover.tsx";
import { cn } from "@markdraw/core/utils.ts";

const STORAGE_KEY = "asciimark.figma-capture-key";
const SCRIPT_ID = "figma-capture-script";
const SCRIPT_SRC = "https://mcp.figma.com/mcp/html-to-design/capture.js";

let clipboardPatched = false;

/**
 * Figma's capture.js writes the snapshot to the clipboard via
 * `navigator.clipboard.writeText` (JSON) and `navigator.clipboard.write`
 * (HTML/image). WKWebView running inside Tauri rejects both APIs because
 * the writes happen after a programmatic page reload — there is no fresh
 * user-activation context.
 *
 * We monkey-patch the clipboard API to forward to the Tauri plugin
 * (which writes via the OS clipboard from Rust, no user gesture
 * required). Patch must be installed BEFORE capture.js loads.
 */
function patchClipboardForTauri() {
  if (clipboardPatched) return;
  clipboardPatched = true;
  try {
    const nav = window.navigator as Navigator & { clipboard?: Clipboard };
    if (!nav.clipboard) {
      Object.defineProperty(nav, "clipboard", {
        value: {} as Clipboard,
        configurable: true,
        writable: true,
      });
    }
    const clip = nav.clipboard as Clipboard;

    clip.writeText = async (text: string) => {
      await tauriWriteText(text);
    };

    clip.write = async (items: ClipboardItem[]) => {
      // Process types in priority order (HTML > image > text). Each
      // Tauri clipboard call OVERWRITES the previous one, and Figma's
      // paste reader only triggers the design-import path when the
      // MIME is text/html — falling back to text/plain would land
      // the markup as a literal text frame.
      for (const item of items) {
        const types = Array.from(item.types);
        const htmlType = types.find((t) => t === "text/html");
        const imageType = types.find((t) => t.startsWith("image/"));
        const textType = types.find((t) => t === "text/plain");

        if (htmlType) {
          const blob = await item.getType(htmlType);
          await tauriWriteHtml(await blob.text());
          continue;
        }
        if (imageType) {
          const blob = await item.getType(imageType);
          const buf = await blob.arrayBuffer();
          await tauriWriteImage(Array.from(new Uint8Array(buf)));
          continue;
        }
        if (textType) {
          const blob = await item.getType(textType);
          await tauriWriteText(await blob.text());
        }
      }
    };
  } catch (err) {
    console.warn("[figma-capture] clipboard patch failed:", err);
  }
}

const FIGMA_PURPLE = "#A259FF";

function readStoredKey(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeStoredKey(key: string) {
  try {
    if (key) window.localStorage.setItem(STORAGE_KEY, key);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore quota errors */
  }
}

function isCaptureActive(): boolean {
  return window.location.hash.includes("figmacapture=");
}

/**
 * Apply the figma capture WITHOUT a full reload. Two reasons:
 *  1. TanStack-style routers (and Markdraw's pane router) often
 *     re-encode the hash on rehydration, dropping `figmaselector`.
 *  2. Reload kills the user-gesture activation context and creates
 *     a confusing flicker.
 *
 * Strategy: write the hash via `history.replaceState`, monkey-patch
 * the clipboard, and re-inject `capture.js` with a cache buster so it
 * re-executes against the *current* DOM and the *current* hash.
 */
function applyCapture(key: string) {
  patchClipboardForTauri();

  // #root is Markdraw's mount point (see apps/desktop/index.html).
  const hash =
    `#figmacapture=${encodeURIComponent(key)}` +
    `&figmaselector=${encodeURIComponent("#root")}` +
    `&figmadelay=250`;
  const url = window.location.pathname + window.location.search + hash;
  window.history.replaceState(null, "", url);

  const old = document.getElementById(SCRIPT_ID);
  if (old) old.remove();

  const script = document.createElement("script");
  script.id = SCRIPT_ID;
  script.async = true;
  script.src = `${SCRIPT_SRC}?t=${Date.now()}`;
  document.body.appendChild(script);
}

function clearCapture() {
  const cleaned = window.location.hash
    .replace(/[#&]?figmacapture=[^&]*/g, "")
    .replace(/[#&]?figmaselector=[^&]*/g, "")
    .replace(/[#&]?figmadelay=[^&]*/g, "")
    .replace(/^#?&/, "#");
  const fragment = cleaned === "#" || cleaned === "" ? "" : cleaned;
  const url = window.location.pathname + window.location.search + fragment;
  window.history.replaceState(null, "", url);
  const old = document.getElementById(SCRIPT_ID);
  if (old) old.remove();
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

interface FigmaLogoProps {
  class?: string;
  color?: string;
}

function FigmaLogo(props: FigmaLogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke={props.color ?? "currentColor"}
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
      aria-hidden="true"
    >
      <path d="M5 5.5A3.5 3.5 0 0 1 8.5 2H12v7H8.5A3.5 3.5 0 0 1 5 5.5z" />
      <path d="M12 2h3.5a3.5 3.5 0 1 1 0 7H12V2z" />
      <path d="M12 12.5a3.5 3.5 0 1 1 7 0 3.5 3.5 0 1 1-7 0z" />
      <path d="M5 19.5A3.5 3.5 0 0 1 8.5 16H12v3.5a3.5 3.5 0 1 1-7 0z" />
      <path d="M5 12.5A3.5 3.5 0 0 1 8.5 9H12v7H8.5A3.5 3.5 0 0 1 5 12.5z" />
    </svg>
  );
}

export function FigmaCaptureButton() {
  const envKey = (import.meta.env.VITE_FIGMA_KEY as string | undefined) ?? "";
  const [storedKey, setStoredKey] = createSignal<string>(readStoredKey());
  const [active, setActive] = createSignal<boolean>(isCaptureActive());
  const [open, setOpen] = createSignal(false);
  const [draftKey, setDraftKey] = createSignal("");

  const key = () => storedKey() || envKey;

  onMount(() => {
    patchClipboardForTauri();
    const onHashChange = () => setActive(isCaptureActive());
    window.addEventListener("hashchange", onHashChange);
    onCleanup(() => window.removeEventListener("hashchange", onHashChange));
  });

  createEffect(() => {
    if (open()) setDraftKey(key());
  });

  // Tracks whether the next onOpenChange(true) should be allowed
  // through. We only want the popover to appear when transitioning
  // OFF → ON; clicking the button while capture is active should just
  // toggle it off, no popover.
  let allowOpen = false;

  const handleSave = () => {
    const trimmed = draftKey().trim();
    if (!trimmed) return;
    writeStoredKey(trimmed);
    setStoredKey(trimmed);
    applyCapture(trimmed);
    setActive(true);
    window.setTimeout(() => setOpen(false), 600);
  };

  const handleForget = () => {
    writeStoredKey("");
    setStoredKey("");
    setDraftKey("");
    if (active()) {
      clearCapture();
      setActive(false);
    }
  };

  const tooltip = () =>
    active()
      ? "Capture ativo — clique para desativar"
      : key()
        ? "Ativar Figma capture"
        : "Configurar Figma capture";

  const handleClick = (e: MouseEvent) => {
    if (active()) {
      e.preventDefault();
      e.stopPropagation();
      clearCapture();
      setActive(false);
      allowOpen = false;
      setOpen(false);
      return;
    }
    allowOpen = true;
  };

  const handleOpenChange = (next: boolean) => {
    if (next && !allowOpen) return;
    if (next) allowOpen = false;
    setOpen(next);
  };

  return (
    <Popover open={open()} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        as="button"
        type="button"
        onClick={handleClick}
        title={tooltip()}
        aria-label={tooltip()}
        class={cn(
          "fixed right-4 bottom-4 z-50 inline-flex size-11 items-center justify-center rounded-full border shadow-lg backdrop-blur transition-all",
          active()
            ? "border-transparent bg-white shadow-[0_0_0_2px_#A259FF55,0_8px_24px_rgba(162,89,255,0.35)] hover:bg-white"
            : "border-border bg-background/80 hover:bg-background text-muted-foreground hover:text-foreground",
        )}
      >
        <FigmaLogo
          class="size-5"
          color={active() ? FIGMA_PURPLE : undefined}
        />
      </PopoverTrigger>
      <PopoverContent class="w-72 p-3">
        <div class="flex flex-col gap-3">
          <div>
            <div class="text-sm font-medium">Figma Capture</div>
            <p class="text-muted-foreground text-[0.625rem] leading-relaxed">
              Cole a file key do Figma. O hash{" "}
              <code class="font-mono">#figmacapture=…</code> é aplicado e
              o capture.js é re-injetado para serializar o DOM atual.
            </p>
          </div>
          <TextField value={draftKey()} onChange={(v) => setDraftKey(v)}>
            <TextFieldInput
              placeholder="aBcDeFgHiJkLmNoPqRsT"
              class="font-mono text-xs"
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleSave();
                }
              }}
              autofocus
            />
          </TextField>
          <div class="flex items-center justify-between gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={handleForget}
              disabled={!storedKey() && !active()}
              class="text-muted-foreground hover:text-destructive"
            >
              {active() ? "Limpar hash" : "Esquecer key"}
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!draftKey().trim()}>
              {active() ? "Reaplicar" : "Capturar"}
            </Button>
          </div>
          <Show when={storedKey()}>
            <div class="text-muted-foreground text-[0.625rem]">
              Key salva:{" "}
              <code class="font-mono">
                {storedKey().slice(0, 6)}…{storedKey().slice(-2)}
              </code>
            </div>
          </Show>
        </div>
      </PopoverContent>
    </Popover>
  );
}
