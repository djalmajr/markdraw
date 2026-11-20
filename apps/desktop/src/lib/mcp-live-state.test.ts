import { describe, expect, it } from "bun:test";
import type { PaneManager } from "@markdraw/ui/composables/create-pane-manager.ts";
import { captureMcpState, listenForMcpState, respondToMcpState, type McpStateKind, type McpStateRequest } from "./mcp-live-state.ts";

function fixture() {
  const first = { id: "a", fileName: "one.md", filePath: "one.md", rootId: "root", editorContent: "old", savedContent: "old", needsLoad: false };
  const second = { id: "b", fileName: "two.adoc", filePath: "two.adoc", rootId: "root", editorContent: "saved", savedContent: "saved", needsLoad: false };
  let current = first;
  let text = "unsaved";
  let loading = false;
  let editorText = "unsa";
  let activeIndex = 0;
  let selectedRoot = "root";
  const pane = {
    tabs: { activeTabId: () => current.id, tabs: () => [first, second] },
    editorContent: () => text, savedContent: () => current.savedContent,
    selectedFile: () => ({ path: current.filePath }), selectedRootId: () => selectedRoot, loading: () => loading,
    editorApi: { getSelection: () => ({ from: 0, to: editorText.length, text: editorText }) },
  };
  const other = { ...pane, tabs: { activeTabId: () => second.id, tabs: () => [second] }, editorContent: () => "saved", savedContent: () => "saved" };
  const manager = { activePaneIndex: () => activeIndex, panes: () => [pane, other] } as unknown as PaneManager;
  let activeElement: unknown = null;
  let selection: unknown = null;
  const dom = { get activeElement() { return activeElement; }, getSelection: () => selection } as unknown as Document;
  const take = (kind: McpStateKind) => captureMcpState(manager, new Map([["root", "/workspace"]]), dom, kind);
  return { take, first, setCurrent: (value: typeof first) => { current = value; }, second, setText: (value: string) => { text = value; }, setLoading: (value: boolean) => { loading = value; }, setEditorText: (value: string) => { editorText = value; }, setFocus: (value: unknown) => { activeElement = value; }, setSelection: (value: unknown) => { selection = value; }, setActiveIndex: (value: number) => { activeIndex = value; }, setSelectedRoot: (value: string) => { selectedRoot = value; } };
}

const paneElement = { getAttribute: () => "0" };
const editorFocus = { closest: (selector: string) => selector === ".cm-editor" ? {} : paneElement };
const previewBody = { closest: () => paneElement };
const previewAnchor = { nodeType: 1, closest: () => previewBody };

describe("MCP live state", () => {
  it("returns empty data without a pane or tab", () => {
    const manager = { activePaneIndex: () => 0, panes: () => [] } as unknown as PaneManager;
    const data = captureMcpState(manager, new Map(), {} as Document, "tabs");
    expect(data).toEqual({ tabs: { panes: [] }, active_document: { document: null }, selection: { selection: null } });
  });
  it("returns a scratch buffer without a folder, but rejects a lost workspace root", async () => {
    const tab = { id: "scratch", fileName: "Untitled.md", filePath: "scratch://Untitled.md", rootId: "__scratch__", editorContent: "", savedContent: "", needsLoad: false };
    const pane = { tabs: { activeTabId: () => tab.id, tabs: () => [tab] }, editorContent: () => "draft", savedContent: () => "", selectedFile: () => ({ path: tab.filePath }), selectedRootId: () => tab.rootId, loading: () => false };
    const manager = { activePaneIndex: () => 0, panes: () => [pane] } as unknown as PaneManager;
    const dom = { activeElement: null, getSelection: () => null } as unknown as Document;
    expect(captureMcpState(manager, new Map(), dom, "active_document").active_document).toEqual({ document: { tabId: "scratch", title: "Untitled.md", filePath: null, dirty: true, language: "md", text: "draft" } });
    tab.rootId = "removed";
    const calls: unknown[] = [];
    await respondToMcpState({ id: "missing-root", kind: "tabs" }, () => captureMcpState(manager, new Map(), dom, "tabs"), async (_command, args) => { calls.push(args); });
    expect(calls).toEqual([{ response: { id: "missing-root", ok: false, error: "unavailable" } }]);
  });
  it("returns exact per-pane tabs and current unsaved buffer", () => {
    const f = fixture();
    expect(f.take("tabs").tabs).toEqual({ panes: [
      { index: 0, active: true, tabs: [
        { id: "a", title: "one.md", filePath: "/workspace/one.md", active: true, dirty: true },
        { id: "b", title: "two.adoc", filePath: "/workspace/two.adoc", active: false, dirty: false },
      ] },
      { index: 1, active: false, tabs: [{ id: "b", title: "two.adoc", filePath: "/workspace/two.adoc", active: true, dirty: false }] },
    ] });
    expect(f.take("active_document").active_document).toEqual({ document: { tabId: "a", title: "one.md", filePath: "/workspace/one.md", dirty: true, language: "md", text: "unsaved" } });
    f.setCurrent(f.second); f.setText("new buffer");
    expect(f.take("active_document").active_document.document).toMatchObject({ tabId: "b", text: "new buffer", language: "adoc" });
    f.setActiveIndex(1);
    expect(f.take("active_document").active_document.document).toMatchObject({ tabId: "b", text: "saved", dirty: false });
    expect(f.take("tabs").tabs.panes.map((pane) => pane.active)).toEqual([false, true]);
    f.setFocus(editorFocus);
    expect(f.take("selection").selection).toEqual({ selection: null });
  });
  it("uses focused editor or live preview, never a stale editor range", () => {
    const f = fixture();
    expect(f.take("selection").selection).toEqual({ selection: null });
    f.setFocus(editorFocus);
    expect(f.take("selection").selection).toEqual({ selection: { source: "editor", tabId: "a", documentText: "unsaved", start: 0, end: 4 } });
    // Offsets that do not describe the document text are never sent.
    f.setEditorText("not in the buffer");
    expect(f.take("selection").selection).toEqual({ selection: null });
    f.setEditorText("unsa");
    f.setFocus(null);
    f.setSelection({ anchorNode: previewAnchor, focusNode: previewAnchor, isCollapsed: false, rangeCount: 1, toString: () => "preview text" });
    expect(f.take("selection").selection).toEqual({ selection: { source: "preview", tabId: "a", documentText: "unsaved", text: "preview text" } });
    f.setFocus({ tagName: "IFRAME", closest: () => null });
    expect(f.take("selection").selection).toEqual({ selection: null });
    f.setFocus(null);
    f.setSelection({ anchorNode: previewAnchor, focusNode: { nodeType: 1, closest: () => null }, isCollapsed: false, rangeCount: 1, toString: () => "cross pane" });
    expect(f.take("selection").selection).toEqual({ selection: null });
    f.setSelection(null);
    expect(f.take("selection").selection).toEqual({ selection: null });
  });
  it("registers the request listener, sends the correlated response and unregisters", async () => {
    const f = fixture();
    let handler: ((event: { payload: McpStateRequest }) => void) | null = null;
    const calls: unknown[] = [];
    const stop = await listenForMcpState(async (event, callback) => {
      expect(event).toBe("mcp-state-request");
      handler = callback;
      return () => { handler = null; };
    }, (kind) => f.take(kind), async (command, args) => { calls.push({ command, args }); });
    const deliver = () => handler?.({ payload: { id: "wire", kind: "tabs" } });
    deliver();
    expect(calls).toEqual([{ command: "mcp_state_respond", args: { response: { id: "wire", ok: true, data: f.take("tabs").tabs } } }]);
    stop();
    deliver();
    expect(calls).toHaveLength(1);
  });
  it("responds once, snapshots before awaiting, and reports capture errors", async () => {
    const f = fixture();
    const calls: unknown[] = [];
    const send = async (command: string, args: unknown) => { calls.push({ command, args }); throw new Error("invoke failed"); };
    const pending = respondToMcpState({ id: "1", kind: "active_document" }, () => f.take("active_document"), send);
    f.setText("later");
    await expect(pending).rejects.toThrow("invoke failed");
    expect(calls).toEqual([{ command: "mcp_state_respond", args: { response: { id: "1", ok: true, data: { document: { tabId: "a", title: "one.md", filePath: "/workspace/one.md", dirty: true, language: "md", text: "unsaved" } } } } }]);
    f.setLoading(true);
    await respondToMcpState({ id: "2", kind: "selection" }, () => f.take("selection"), async (_command, args) => { calls.push(args); });
    expect(calls[1]).toEqual({ response: { id: "2", ok: false, error: "unavailable" } });
    expect(f.take("tabs").tabs.panes).toHaveLength(2);
    f.setLoading(false);
    f.setSelectedRoot("different-root");
    await respondToMcpState({ id: "3", kind: "active_document" }, () => f.take("active_document"), async (_command, args) => { calls.push(args); });
    expect(calls[2]).toEqual({ response: { id: "3", ok: false, error: "unavailable" } });
  });
});
