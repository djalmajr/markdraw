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

export function installHyprlandMaximize(target: Window, invoke: (command: string) => Promise<unknown>): () => void {
  const handler = (event: MouseEvent) => {
    if (event.button !== 0 || event.detail !== 2 || !isDragRegion(event.composedPath() as EventTarget[])) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void invoke("toggle_maximize_instant");
  };
  target.addEventListener("mousedown", handler, true);
  return () => target.removeEventListener("mousedown", handler, true);
}
