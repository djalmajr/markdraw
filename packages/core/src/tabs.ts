import type { Frontmatter } from "./frontmatter.ts";

export type TabId = string;

export interface TabState {
  id: TabId;
  filePath: string;
  rootId: string;
  fileName: string;
  editorContent: string;
  savedContent: string;
  html: string;
  frontmatter: Frontmatter | null;
  editorMode: "edit" | "split" | "preview";
  editorScrollTop: number;
  previewScrollTop: number;
  isPinned: boolean;
  includePaths: string[];
  /** Tab content needs to be loaded from disk (e.g. restored from session). */
  needsLoad: boolean;
}

export interface PersistedTab {
  id: TabId;
  filePath: string;
  rootId: string;
  fileName: string;
  isPinned: boolean;
  editorMode: "edit" | "split" | "preview";
}

export interface PersistedTabSession {
  tabs: PersistedTab[];
  activeTabId: TabId | null;
}

export function makeTabId(rootId: string, filePath: string): TabId {
  return `${rootId}::${filePath}`;
}

export function parseTabId(tabId: TabId): { rootId: string; filePath: string } {
  const idx = tabId.indexOf("::");
  if (idx < 0) return { rootId: "", filePath: tabId };
  return { rootId: tabId.slice(0, idx), filePath: tabId.slice(idx + 2) };
}

const STORAGE_KEY = "asciimark-tab-session";

function isPersistedTab(item: unknown): item is PersistedTab {
  if (typeof item !== "object" || item === null) return false;
  const t = item as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.filePath === "string" &&
    typeof t.rootId === "string" &&
    typeof t.fileName === "string" &&
    typeof t.isPinned === "boolean" &&
    (t.editorMode === "edit" || t.editorMode === "split" || t.editorMode === "preview")
  );
}

export function getTabSession(): PersistedTabSession | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null) return null;
    const tabs = Array.isArray(parsed.tabs) ? parsed.tabs.filter(isPersistedTab) : [];
    if (tabs.length === 0) return null;
    return {
      tabs,
      activeTabId: typeof parsed.activeTabId === "string" ? parsed.activeTabId : null,
    };
  } catch {
    return null;
  }
}

export function setTabSession(session: PersistedTabSession): void {
  const persisted: PersistedTabSession = {
    tabs: session.tabs.map((t) => ({
      id: t.id,
      filePath: t.filePath,
      rootId: t.rootId,
      fileName: t.fileName,
      isPinned: t.isPinned,
      editorMode: t.editorMode,
    })),
    activeTabId: session.activeTabId,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
}

export function clearTabSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}
