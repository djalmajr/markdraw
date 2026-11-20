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

/** Storage key for the roots that were open when the session was last saved.
 *  A persisted tab session is only restorable while its root is open, so a
 *  webview reload (Vite HMR in dev) that drops the in-memory roots leaves the
 *  tabs orphaned in storage without this list. */
export const OPEN_ROOTS_STORAGE_KEY = "markdraw-open-roots-v1";

/** A root open at the end of the session. `id` is the root id tabs are filed
 *  under (the absolute path today); `path` is what gets reopened on disk. */
export interface OpenRoot {
  id: string;
  path: string;
}

const OpenRootsSchema = v.array(
  v.object({
    id: v.string(),
    path: v.string(),
  }),
);

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
 *  keys (`markdraw-tab-session-pane-N`) and falls back to this when
 *  upgrading from a single-pane install. The legacy key is removed
 *  after a successful migration so subsequent loads don't double-read. */
export const LEGACY_STORAGE_KEY = "markdraw-tab-session";

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
 * pane-scoped key (typically `markdraw-tab-session-pane-0`). Idempotent
 * and harmless when no legacy data exists. Returns true when a migration
 * actually happened so the caller can log it once.
 */
/**
 * The saved inventory of open roots, deduped by path so the same folder opened
 * twice is reopened once. `null` means there is no usable inventory: the key
 * was never written (a version that predates it), or its content is corrupt or
 * from another version. That is different from an inventory that is empty (the
 * user closed every folder): only a real inventory can say a root is gone.
 */
export function loadOpenRoots(storageKey: string = OPEN_ROOTS_STORAGE_KEY): OpenRoot[] | null {
  if (typeof localStorage === "undefined") return null;
  const parsed = safeJsonParse(localStorage.getItem(storageKey), OpenRootsSchema);
  if (!parsed) return null;

  const seen = new Set<string>();
  const roots: OpenRoot[] = [];
  for (const root of parsed) {
    if (root.path.length === 0 || seen.has(root.path)) continue;
    seen.add(root.path);
    roots.push({ id: root.id, path: root.path });
  }
  return roots;
}

/**
 * Roots to reopen after a reload. Corrupt or foreign-version storage returns
 * an empty list instead of failing startup (see `loadOpenRoots` to tell that
 * apart from an empty inventory).
 */
export function getOpenRoots(storageKey: string = OPEN_ROOTS_STORAGE_KEY): OpenRoot[] {
  return loadOpenRoots(storageKey) ?? [];
}

/** Replace the persisted open-root list. An empty list is written as `[]`, not
 *  removed: "no folder open" is a known inventory, unlike a missing key. */
export function setOpenRoots(
  roots: Iterable<OpenRoot>,
  storageKey: string = OPEN_ROOTS_STORAGE_KEY,
): void {
  if (typeof localStorage === "undefined") return;
  const seen = new Set<string>();
  const normalized: OpenRoot[] = [];
  for (const root of roots) {
    if (root.path.length === 0 || seen.has(root.path)) continue;
    seen.add(root.path);
    normalized.push({ id: root.id, path: root.path });
  }
  localStorage.setItem(storageKey, JSON.stringify(normalized));
}

/** Storage key for the roots whose saved tabs predate the open-roots list.
 *  Updating from a version without `OPEN_ROOTS_STORAGE_KEY` leaves tabs filed
 *  under roots nobody knows to reopen; the first list written afterwards holds
 *  only the folders opened since, so it cannot tell those roots are gone. They
 *  stay here until the folder is opened or its absence is confirmed. */
export const PENDING_TAB_ROOTS_STORAGE_KEY = "markdraw-pending-tab-roots-v1";

const PendingTabRootsSchema = v.array(v.string());

/** Root ids whose saved tabs are kept until the root opens or is confirmed
 *  gone. Missing, corrupt or foreign-version storage reads as none. */
export function getPendingTabRoots(storageKey: string = PENDING_TAB_ROOTS_STORAGE_KEY): string[] {
  if (typeof localStorage === "undefined") return [];
  const parsed = safeJsonParse(localStorage.getItem(storageKey), PendingTabRootsSchema);
  return parsed ? [...new Set(parsed.filter((id) => id.length > 0))] : [];
}

/** Replace the pending list. An empty list removes the key: nothing is pending. */
export function setPendingTabRoots(
  rootIds: Iterable<string>,
  storageKey: string = PENDING_TAB_ROOTS_STORAGE_KEY,
): void {
  if (typeof localStorage === "undefined") return;
  const ids = [...new Set(rootIds)].filter((id) => id.length > 0);
  if (ids.length === 0) localStorage.removeItem(storageKey);
  else localStorage.setItem(storageKey, JSON.stringify(ids));
}

export interface TabRestorePlan {
  /** Roots that had never been restored before this call. The caller records
   *  them so a root opened later restores its own tabs without replaying the
   *  tabs of roots already handled. */
  rootIds: string[];
  /** Persisted tabs (with `needsLoad` semantics implied) for those roots. */
  tabs: PersistedTab[];
  /** Persisted active tab, when it belongs to this batch. */
  activeTabId: string | null;
}

/**
 * Decide which tabs a batch of newly opened roots may restore. Restoring is
 * idempotent per root: a root already in `restoredRootIds` contributes nothing,
 * so opening a second folder after startup still restores that folder's tabs.
 */
export function planTabRestore(
  session: PersistedTabSession | null,
  openRootIds: Iterable<string>,
  restoredRootIds: ReadonlySet<string>,
): TabRestorePlan {
  const rootIds = [...new Set(openRootIds)].filter((id) => !restoredRootIds.has(id));
  if (rootIds.length === 0) return { rootIds, tabs: [], activeTabId: null };

  const fresh = new Set(rootIds);
  const tabs = session?.tabs.filter((tab) => fresh.has(tab.rootId)) ?? [];
  const activeTabId =
    session && tabs.some((tab) => tab.id === session.activeTabId) ? session.activeTabId : null;
  return { rootIds, tabs, activeTabId };
}

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
