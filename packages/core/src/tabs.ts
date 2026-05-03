import type { Frontmatter } from "./frontmatter.ts";
import {
  PersistedTabSchema,
  PersistedTabSessionSchema,
  type PersistedTab,
  type PersistedTabSession,
  tryParse,
} from "./schemas.ts";

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

export type { PersistedTab, PersistedTabSession };

export function makeTabId(rootId: string, filePath: string): TabId {
  return `${rootId}::${filePath}`;
}

export function parseTabId(tabId: TabId): { rootId: string; filePath: string } {
  const idx = tabId.indexOf("::");
  if (idx < 0) return { rootId: "", filePath: tabId };
  return { rootId: tabId.slice(0, idx), filePath: tabId.slice(idx + 2) };
}

const STORAGE_KEY = "asciimark-tab-session";

export function getTabSession(): PersistedTabSession | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;

    // Validate the wrapper, but tolerate individual broken tabs by filtering
    // them out instead of rejecting the entire session.
    const raw = JSON.parse(stored);
    if (typeof raw !== "object" || raw === null) return null;

    const tabs = Array.isArray((raw as { tabs?: unknown }).tabs)
      ? ((raw as { tabs: unknown[] }).tabs
          .map((t) => tryParse(PersistedTabSchema, t))
          .filter((t): t is PersistedTab => t !== null))
      : [];

    if (tabs.length === 0) return null;
    const activeTabId = typeof (raw as { activeTabId?: unknown }).activeTabId === "string"
      ? (raw as { activeTabId: string }).activeTabId
      : null;
    return { tabs, activeTabId };
  } catch {
    return null;
  }
}

export function setTabSession(session: PersistedTabSession): void {
  // Normalize through the schema so accidental extra runtime fields
  // never reach storage.
  const normalized: PersistedTabSession = {
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
  // Throws on caller-side bugs that would otherwise corrupt storage silently.
  const validated = tryParse(PersistedTabSessionSchema, normalized);
  if (!validated) {
    throw new Error("setTabSession: invalid PersistedTabSession");
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(validated));
}

export function clearTabSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}
