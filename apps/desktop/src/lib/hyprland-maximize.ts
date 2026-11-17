const clickable = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "SUMMARY"]);
const roles = new Set(["button", "link", "menuitem", "tab", "checkbox", "radio", "switch", "option"]);

export function isDragRegion(path: EventTarget[]): boolean {
  for (const el of path) {
    if (!(el instanceof HTMLElement)) continue;
    const attr = el.getAttribute("data-tauri-drag-region");
    const interactive = clickable.has(el.tagName)
      || (el.hasAttribute("contenteditable") && el.getAttribute("contenteditable") !== "false")
      || (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1")
      || roles.has(el.getAttribute("role") ?? "");
    if (interactive && attr === null) return false;
    if (attr === null) continue;
    if (attr === "false") return false;
    if (attr === "deep") return true;
    if (attr === "" || attr === "true") return el === path[0];
  }
  return false;
}

/** Pointer travel, in CSS pixels, that turns a held press into a window move. */
export const DRAG_THRESHOLD = 4;

// The one press waiting to become a move. A new press replaces it, so a lost
// `mouseup` can never leave two moves armed (toolbar and welcome screen share it).
let pending = () => {};

/** Drop the press waiting to become a move, if any. */
export function cancelPendingDrag(): void {
  pending();
}

/**
 * Start the window move only once the held pointer has moved, as GTK's own
 * header bars do. Hyprland treats a move request as a drag from the first
 * event: with its default `binds:drag_threshold` of 0, a plain click on a
 * maximized window's toolbar unmaximizes it and recenters it under the
 * cursor, and the first click of the double click that should restore it
 * does the same. Replaces any press already waiting.
 */
export function dragOnceMoved(target: Window, press: MouseEvent, start: () => unknown): void {
  pending();
  const stop = () => {
    target.removeEventListener("mousemove", move, true);
    target.removeEventListener("mouseup", stop, true);
    target.removeEventListener("blur", stop);
    if (pending === stop) pending = () => {};
  };
  const move = (event: MouseEvent) => {
    if ((event.buttons & 1) === 0) return stop();
    const travel = Math.abs(event.clientX - press.clientX) + Math.abs(event.clientY - press.clientY);
    if (travel < DRAG_THRESHOLD) return;
    stop();
    void start();
  };
  target.addEventListener("mousemove", move, true);
  target.addEventListener("mouseup", stop, true);
  target.addEventListener("blur", stop);
  pending = stop;
}

/**
 * Title-bar behavior on Hyprland, ahead of Tauri's own drag-region script: a
 * double click toggles maximize through the compositor and a press moves the
 * window once the pointer moves (`dragOnceMoved`). Removing it also drops a
 * pending move.
 */
export function installHyprlandMaximize(
  target: Window,
  invoke: (command: string) => Promise<unknown>,
  startDragging: () => unknown,
): () => void {
  const handler = (event: MouseEvent) => {
    if (event.button !== 0 || (event.detail !== 1 && event.detail !== 2)) return;
    if (!isDragRegion(event.composedPath() as EventTarget[])) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.detail === 2) {
      cancelPendingDrag();
      void invoke("toggle_maximize_instant");
    } else {
      dragOnceMoved(target, event, startDragging);
    }
  };
  target.addEventListener("mousedown", handler, true);
  return () => {
    cancelPendingDrag();
    target.removeEventListener("mousedown", handler, true);
  };
}
