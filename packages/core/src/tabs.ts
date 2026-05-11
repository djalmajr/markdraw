import type { Frontmatter } from "./frontmatter.ts";
import * as v from "valibot";
import {
  PersistedTabSchema,
  PersistedTabSessionSchema,
  type PersistedTab,
  type PersistedTabSession,
  safeJsonParse,
  tryParse,
} from "./schemas.ts";

// Schema for the raw wrapper read from localStorage. We don't validate
// the `tabs` array deeply here — bad entries are filtered out below
// rather than failing the whole session, mirroring the recent-files
// pattern. activeTabId is allowed to be missing (null after parse).
const TabSessionWrapperSchema = v.object({
  tabs: v.array(v.unknown()),
  activeTabId: v.optional(v.union([v.string(), v.null()])),
});

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

/** Legacy single-pane session storage key. New code writes pane-scoped
 *  keys (`asciimark-tab-session-pane-N`) and falls back to this when
 *  upgrading from a single-pane install. The legacy key is removed
 *  after a successful migration so subsequent loads don't double-read. */
export const LEGACY_STORAGE_KEY = "asciimark-tab-session";

const DEFAULT_STORAGE_KEY = LEGACY_STORAGE_KEY;

export function getTabSession(storageKey: string = DEFAULT_STORAGE_KEY): PersistedTabSession | null {
  // Validate the wrapper at the storage boundary; broken individual
  // tab entries are filtered out (not session-fatal). `safeJsonParse`
  // swallows malformed JSON + shape mismatches.
  const wrapper = safeJsonParse(localStorage.getItem(storageKey), TabSessionWrapperSchema);
  if (!wrapper) return null;

  const tabs = wrapper.tabs
    .map((t) => tryParse(PersistedTabSchema, t))
    .filter((t): t is PersistedTab => t !== null);

  if (tabs.length === 0) return null;
  const activeTabId = typeof wrapper.activeTabId === "string" ? wrapper.activeTabId : null;
  return { tabs, activeTabId };
}

export function setTabSession(
  session: PersistedTabSession,
  storageKey: string = DEFAULT_STORAGE_KEY,
): void {
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
  localStorage.setItem(storageKey, JSON.stringify(validated));
}

export function clearTabSession(storageKey: string = DEFAULT_STORAGE_KEY): void {
  localStorage.removeItem(storageKey);
}

/**
 * Move a session blob from the legacy single-pane key to the new
 * pane-scoped key (typically `asciimark-tab-session-pane-0`). Idempotent
 * and harmless when no legacy data exists. Returns true when a migration
 * actually happened so the caller can log it once.
 */
export function migrateLegacyTabSession(targetKey: string): boolean {
  if (targetKey === LEGACY_STORAGE_KEY) return false;
  if (typeof localStorage === "undefined") return false;
  if (localStorage.getItem(targetKey)) return false;
  const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!legacy) return false;
  localStorage.setItem(targetKey, legacy);
  localStorage.removeItem(LEGACY_STORAGE_KEY);
  return true;
}
