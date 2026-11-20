import type { PaneManager } from "@markdraw/ui/composables/create-pane-manager.ts";
import type { PaneStore } from "@markdraw/ui/composables/create-pane-store.ts";
import type { EditorApi } from "@markdraw/ui/components/editor.tsx";
import { SCRATCH_ROOT_ID } from "./scratch.ts";

export type McpStateKind = "tabs" | "active_document" | "selection";
export interface McpStateRequest { id: string; kind: McpStateKind }

export function captureMcpState(
  manager: PaneManager,
  roots: ReadonlyMap<string, string>,
  dom: Pick<Document, "activeElement" | "getSelection">,
  kind: McpStateKind,
) {
  const activeIndex = manager.activePaneIndex();
  const panes = manager.panes().map((pane, index) => {
    const activeId = pane.tabs.activeTabId();
    const tabs = pane.tabs.tabs();
    const text = pane.editorContent();
    const saved = pane.savedContent();
    return { pane, index, activeId, tabs, text, saved };
  });
  const active = panes[activeIndex];
  const tab = active?.tabs.find((item) => item.id === active.activeId);
  const filePath = (rootId: string, path: string): string | null => {
    if (!path || rootId === SCRATCH_ROOT_ID) return null;
    const root = roots.get(rootId);
    if (!root) throw new Error("unavailable");
    return `${root.replace(/[\\/]+$/, "")}/${path}`;
  };
  const tabs = {
    panes: panes.filter((entry) => entry.tabs.length > 0).map((entry) => ({
      index: entry.index,
      active: entry.index === activeIndex,
      tabs: entry.tabs.map((item) => ({
        id: item.id,
        title: item.fileName,
        filePath: filePath(item.rootId, item.filePath),
        active: item.id === entry.activeId,
        dirty: item.id === entry.activeId && !item.needsLoad
          ? entry.text !== entry.saved
          : item.editorContent !== item.savedContent,
      })),
    })),
  };
  if (!active || !tab) return { tabs, active_document: { document: null }, selection: { selection: null } };
  const selected = active.pane.selectedFile();
  if (tab.needsLoad || active.pane.loading() ||
      (tab.filePath && (selected?.path !== tab.filePath || active.pane.selectedRootId() !== tab.rootId))) {
    if (kind !== "tabs") throw new Error("unavailable");
    return { tabs, active_document: { document: null }, selection: { selection: null } };
  }
  const ext = tab.fileName.includes(".") ? tab.fileName.split(".").pop()!.toLowerCase() : "";
  const document = {
    document: {
      tabId: tab.id,
      title: tab.fileName,
      filePath: filePath(tab.rootId, tab.filePath),
      dirty: active.text !== active.saved,
      language: ext,
      text: active.text,
    },
  };
  // The selection travels with the text of its document and, for the editor,
  // its offsets in it (UTF-16 units, as the editor counts): Rust masks the whole
  // document first and cuts the range out of that, so a value selected alone
  // is still hidden by the text around it. The preview has no offsets; Rust
  // finds the rendered text in the source or refuses it.
  type Selection =
    | { source: "editor"; tabId: string; documentText: string; start: number; end: number }
    | { source: "preview"; tabId: string; documentText: string; text: string };
  let selection: Selection | null = null;
  const focus = dom.activeElement;
  const focusPane = focus?.closest("[data-pane-index]");
  if (focus?.closest(".cm-editor") && focusPane?.getAttribute("data-pane-index") === String(activeIndex)) {
    const range = (active.pane as PaneStore & { editorApi?: EditorApi }).editorApi?.getSelection();
    // The offsets are only sent when they describe this very text.
    if (range?.text.trim() && active.text.slice(range.from, range.to) === range.text) {
      selection = { source: "editor", tabId: tab.id, documentText: active.text, start: range.from, end: range.to };
    }
  } else if (focus?.tagName !== "IFRAME") {
    const selectedText = dom.getSelection();
    const asElement = (node: Node | null | undefined) => node?.nodeType === 1 ? node as Element : node?.parentElement;
    const anchor = asElement(selectedText?.anchorNode);
    const end = asElement(selectedText?.focusNode);
    const body = anchor?.closest(".doc-body");
    if (selectedText && !selectedText.isCollapsed && selectedText.rangeCount && body &&
        end?.closest(".doc-body") === body &&
        body.closest("[data-pane-index]")?.getAttribute("data-pane-index") === String(activeIndex)) {
      const text = selectedText.toString();
      if (text.trim()) selection = { source: "preview", tabId: tab.id, documentText: active.text, text };
    }
  }
  return { tabs, active_document: document, selection: { selection } };
}

export function respondToMcpState(
  request: McpStateRequest,
  snapshot: () => ReturnType<typeof captureMcpState>,
  invoke: (command: string, args: { response: unknown }) => Promise<unknown>,
): Promise<unknown> {
  let response: unknown;
  try {
    const data = snapshot()[request.kind];
    if (!data) throw new Error("unavailable");
    response = { id: request.id, ok: true, data };
  } catch {
    response = { id: request.id, ok: false, error: "unavailable" };
  }
  return invoke("mcp_state_respond", { response });
}

export function listenForMcpState(
  listen: (event: string, handler: (event: { payload: McpStateRequest }) => void) => Promise<() => void>,
  snapshot: (kind: McpStateKind) => ReturnType<typeof captureMcpState>,
  send: (command: string, args: { response: unknown }) => Promise<unknown>,
): Promise<() => void> {
  return listen("mcp-state-request", ({ payload }) => {
    void respondToMcpState(payload, () => snapshot(payload.kind), send).catch(() => {});
  });
}
