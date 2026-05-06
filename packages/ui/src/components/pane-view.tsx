import { Show, createEffect, createSignal, type JSX } from "solid-js";
import { useDroppable } from "@dnd-kit/solid";
import type { FSEntry } from "@asciimark/core/types.ts";
import type { RecentFile } from "@asciimark/core/recent-files.ts";
import type { RecentFolder } from "@asciimark/core/recent-folders.ts";
import type { FavoriteFile } from "@asciimark/core/favorites.ts";
import type { AppState } from "../composables/create-app-state.ts";
import type { PaneStore } from "../composables/create-pane-store.ts";
import { ContentToolbar } from "./content-toolbar.tsx";
import { Editor } from "./editor.tsx";
import { EditorToolbar } from "./editor-toolbar.tsx";
import { EmptyState } from "./empty-state.tsx";
import { Preview } from "./preview.tsx";
import { TabBar } from "./tab-bar.tsx";

/** Build the dnd id for the pane-level drop zone. Tabs from a different
 *  pane that drop here trigger a move (no exact tab target needed —
 *  empty panes still receive). */
export function toPaneDropDndId(paneIndex: number): string {
  return `pane::${paneIndex}`;
}

export function fromPaneDropDndId(dndId: unknown): number | null {
  if (typeof dndId !== "string" || !dndId.startsWith("pane::")) return null;
  const parsed = Number(dndId.slice("pane::".length));
  return Number.isInteger(parsed) ? parsed : null;
}

export interface PaneViewProps {
  /** The pane this view is bound to. All per-document signals
   *  (editorMode, selectedFile, html, editorContent, …) are read
   *  from THIS pane, NOT from the proxy on AppState. */
  pane: PaneStore;
  /** True when this pane is the focused one. Drives the active visual
   *  border and routes Enter / shortcuts. */
  isActive: boolean;
  /** Index in `paneManager.panes()`. Used to build a stable
   *  data-pane-index attribute for E2E tests. */
  paneIndex: number;
  /** Global app state — read for theme/fonts/UI prefs and shared
   *  callbacks. NEVER use it for per-doc fields (those should come
   *  from `pane`). */
  state: AppState;
  /** Width fraction (0..1). Caller computes from splitRatio. */
  flexBasis?: number;
  /** Called on mousedown anywhere inside the pane so the host can
   *  flip `paneManager.setActivePane`. */
  onActivate?: () => void;
  // ── Pass-through props (mirror AppShellProps subset) ─────────────────
  showToolbar?: boolean;
  showEditorTabs?: boolean;
  showRecentHistory?: boolean;
  hasRoot?: boolean;
  recentFiles?: RecentFile[];
  recentFolders?: RecentFolder[];
  favorites?: FavoriteFile[];
  contentWrapper?: (content: JSX.Element) => JSX.Element;
  resolveImageSrc?: (src: string) => string | null;
  onLoadFile?: (entry: FSEntry, rootId: string) => void;
  onOpenInNewTab?: (entry: FSEntry, rootId: string) => void;
  onActivateTab?: (tabId: string) => void;
  onCloseTab?: (tabId: string) => void;
  onNewTab?: () => void;
  /** Move the given tab from this pane to the other one. The host
   *  resolves which pane is "other" (and may auto-split if there's
   *  currently only one pane). Hidden when undefined. */
  onMoveTab?: (tabId: string, fromPaneIndex: number) => void;
  moveTabLabel?: string;
  /** Where the Preview should mount its TOC. AppShell hosts a single
   *  shared <aside class="toc-panel"> and only the active pane gets
   *  the ref — otherwise two Previews would fight over the same DOM
   *  target. Pass undefined for non-active panes. */
  tocContainer?: HTMLElement;
  onOpenFolder?: () => void;
  onOpenRecentFile?: (recentFile: RecentFile) => void | Promise<void>;
  onOpenRecentFolder?: (path: string) => void | Promise<void>;
  onWindowDragStart?: () => void | Promise<void>;
  onNavigate?: (path: string, fragment?: string | null) => void;
  onOpenExternal?: (url: string) => void;
  /** Called when the EmptyState's discoverability ghost button is
   *  clicked. The host opens the shortcuts modal — same handler as
   *  Cmd+/. Hidden when omitted. */
  onShowShortcutsHelp?: () => void;
}

/**
 * Renders a single pane's tab bar + editor + preview. Multiple
 * `<PaneView>` instances coexist for split mode; each one binds to
 * its own `PaneStore` so they can show different files, different
 * editor modes, and independent scroll positions simultaneously.
 *
 * The split-internal sync (editor↔preview scroll) happens within a
 * pane via the local sync signals. Cross-pane sync is intentionally
 * out of scope for the MVP.
 */
export function PaneView(props: PaneViewProps) {
  const pane = () => props.pane;
  const s = props.state;

  // Per-pane editor controls — undo/redo triggers, history flags, and
  // the scroll-to-line bus shared between this pane's editor and
  // preview. Lifting these per-pane was the whole point of the
  // refactor: two panes can scroll independently.
  const [editorUndoTrigger, setEditorUndoTrigger] = createSignal(0);
  const [editorRedoTrigger, setEditorRedoTrigger] = createSignal(0);
  const [canUndo, setCanUndo] = createSignal(false);
  const [canRedo, setCanRedo] = createSignal(false);
  const [editorSyncTargetRatio, setEditorSyncTargetRatio] = createSignal<number | null>(null);
  const [editorSyncTargetVersion, setEditorSyncTargetVersion] = createSignal(0);
  const [editorScrollToLine, setEditorScrollToLine] = createSignal<number | null>(null);
  const [editorScrollToLineVersion, setEditorScrollToLineVersion] = createSignal(0);
  const [previewSyncTargetRatio, setPreviewSyncTargetRatio] = createSignal<number | null>(null);
  const [previewSyncTargetVersion, setPreviewSyncTargetVersion] = createSignal(0);

  let editorPanelRef: HTMLDivElement | undefined;
  let previewPanelRef: HTMLDivElement | undefined;

  // Pane-level droppable so a tab dragged from the OTHER pane can land
  // here even when this pane has zero tabs (the empty splitter case).
  // The visual highlight (`.pane-view-drop-target`) only kicks in when
  // a foreign tab is being dragged over.
  const paneDroppable = useDroppable({
    get id() { return toPaneDropDndId(props.paneIndex); },
  });

  // Sync scroll: only when this pane is in split mode AND the user
  // enabled it AND a file is loaded. Other panes don't influence.
  const syncScrollActive = () =>
    pane().editorMode() === "split" && s.syncScroll() && !!pane().selectedFile();

  createEffect(() => {
    if (syncScrollActive()) return;
    setEditorSyncTargetRatio(null);
    setPreviewSyncTargetRatio(null);
  });

  // Expose the scroll-to-line setters via property assignment — used
  // when this pane is the target of a Symbol or Find-in-Files jump.
  // The pane carries them as ad-hoc fields so the host can find them
  // via `paneManager.activePane()`.
  (pane() as PaneStore & { setScrollToLine?: (line: number) => void }).setScrollToLine = (line) => {
    setEditorScrollToLine(line);
    setEditorScrollToLineVersion((v) => v + 1);
  };

  function defaultContent() {
    return (
      <Show
        when={pane().selectedFile()}
        fallback={
          <EmptyState
            favorites={s.favorites()}
            hasRoot={!!props.hasRoot}
            onOpenFolder={props.onOpenFolder}
            onOpenRecentFile={props.onOpenRecentFile}
            onOpenRecentFolder={props.onOpenRecentFolder}
            onClearRecentHistory={s.handleClearRecentHistory}
            onRemoveRecentFile={s.handleRemoveRecentFile}
            onRemoveRecentFolder={s.handleRemoveRecentFolder}
            onShowShortcutsHelp={props.onShowShortcutsHelp}
            onToggleFavorite={s.handleToggleFavorite}
            onWindowDragStart={props.onWindowDragStart}
            recentFiles={s.recentFiles()}
            recentFolders={s.recentFolders()}
            showRecentHistory={!!props.showRecentHistory}
          />
        }
      >
        <Preview
          findTrigger={s.previewFindTrigger()}
          html={pane().html()}
          frontmatter={pane().frontmatter()}
          resolveImageSrc={props.resolveImageSrc}
          loading={pane().loading()}
          searchOpen={s.previewSearchOpen()}
          syncScrollActive={syncScrollActive()}
          syncScrollTargetRatio={previewSyncTargetRatio()}
          syncScrollTargetVersion={previewSyncTargetVersion()}
          tocVisible={s.tocVisible()}
          tocContainer={props.tocContainer}
          currentFilePath={pane().selectedFile()?.path ?? null}
          pendingFragment={s.pendingFragment()}
          pendingHeadingText={s.pendingHeadingText()}
          onHeadingHandled={() => s.setPendingHeadingText(null)}
          previewOverlayHost={previewPanelRef}
          onScrollRatioChange={(ratio) => {
            if (!syncScrollActive()) return;
            setEditorSyncTargetRatio(ratio);
            setEditorSyncTargetVersion((value) => value + 1);
          }}
          onFragmentHandled={() => s.setPendingFragment(null)}
          onNavigate={props.onNavigate ?? (() => {})}
          onOpenExternal={props.onOpenExternal}
          onSearchOpenChange={s.setPreviewSearchOpen}
          onTocChange={(has) => s.setHasToc(has)}
        />
      </Show>
    );
  }

  return (
    <div
      ref={paneDroppable.ref}
      class="pane-view"
      classList={{
        "pane-view-active": props.isActive,
        "pane-view-drop-target": paneDroppable.isDropTarget(),
      }}
      data-pane-index={props.paneIndex}
      style={props.flexBasis !== undefined ? { flex: props.flexBasis } : undefined}
      onMouseDown={() => props.onActivate?.()}
    >
      <Show when={props.showEditorTabs && pane().tabs.tabs().length > 0}>
        <TabBar
          tabStore={pane().tabs}
          paneIndex={props.paneIndex}
          activeTabDirty={
            (() => {
              const active = pane().tabs.getActiveTab();
              return active ? active.editorContent !== active.savedContent : false;
            })()
          }
          onActivateTab={props.onActivateTab ?? (() => {})}
          onCloseTab={props.onCloseTab ?? (() => {})}
          onNewTab={props.onNewTab}
          onMoveToOtherPane={
            props.onMoveTab
              ? (tabId) => props.onMoveTab!(tabId, props.paneIndex)
              : undefined
          }
          moveToOtherPaneLabel={props.moveTabLabel}
        />
      </Show>
      <div class="content-panels">
        <Show when={pane().editorMode() !== "preview" && pane().selectedFile()}>
          <div
            class="editor-panel"
            ref={editorPanelRef}
            style={pane().editorMode() === "split" ? { flex: s.editorWidth() } : { flex: 1 }}
          >
            <Show when={props.showToolbar}>
              <EditorToolbar
                canRedo={canRedo()}
                canUndo={canUndo()}
                showInvisibles={s.showInvisibles()}
                showLineNumbers={s.showLineNumbers()}
                indentMode={s.indentMode()}
                indentSize={s.indentSize()}
                syncScroll={s.syncScroll()}
                wrapText={s.wrapText()}
                onRedo={() => setEditorRedoTrigger((value) => value + 1)}
                searchOpen={s.editorSearchOpen()}
                onToggleFind={() => s.setEditorSearchOpen((value) => !value)}
                onUndo={() => setEditorUndoTrigger((value) => value + 1)}
                onIndentChange={(mode, size) => {
                  s.handleIndentModeChange(mode);
                  s.handleIndentSizeChange(size);
                }}
                onToggleShowInvisibles={() => s.handleShowInvisiblesChange(!s.showInvisibles())}
                onToggleShowLineNumbers={() => s.handleLineNumbersChange(!s.showLineNumbers())}
                onToggleSyncScroll={() => s.handleSyncScrollChange(!s.syncScroll())}
                onToggleWrapText={() => s.handleWrapTextChange(!s.wrapText())}
              />
            </Show>
            <Editor
              content={pane().savedContent()}
              darkMode={s.darkMode()}
              findTrigger={s.editorFindTrigger()}
              indentMode={s.indentMode()}
              indentSize={s.indentSize()}
              showInvisibles={s.showInvisibles()}
              showLineNumbers={s.showLineNumbers()}
              wrapText={s.wrapText()}
              syncScrollActive={syncScrollActive()}
              syncScrollTargetRatio={editorSyncTargetRatio()}
              syncScrollTargetVersion={editorSyncTargetVersion()}
              scrollToLine={editorScrollToLine()}
              scrollToLineVersion={editorScrollToLineVersion()}
              redoTrigger={editorRedoTrigger()}
              searchOpen={s.editorSearchOpen()}
              undoTrigger={editorUndoTrigger()}
              onScrollRatioChange={(ratio) => {
                if (!syncScrollActive()) return;
                setPreviewSyncTargetRatio(ratio);
                setPreviewSyncTargetVersion((value) => value + 1);
              }}
              onChange={(content) => {
                // Activating before write ensures the proxy in
                // AppState's `setHtml`/`debouncedConvert` routes back
                // to THIS pane's signals.
                props.onActivate?.();
                const entry = pane().selectedFile();
                // VSCode parity: the first keystroke promotes the
                // active preview tab to a pinned tab so it's no
                // longer eligible for replacement on the next
                // file-tree click. `pinTab` is a no-op once pinned.
                const active = pane().tabs.getActiveTab();
                if (active && !active.isPinned) {
                  pane().tabs.pinTab(active.id);
                }
                if (entry) {
                  s.debouncedConvert(content, entry.path, s._readFile ?? (() => Promise.resolve(null)));
                }
              }}
              onHistoryStateChange={(historyState) => {
                setCanUndo(historyState.canUndo);
                setCanRedo(historyState.canRedo);
              }}
              onSearchOpenChange={s.setEditorSearchOpen}
            />
          </div>
        </Show>
        <Show when={pane().editorMode() === "split" && pane().selectedFile()}>
          <div
            class="resize-handle"
            onDblClick={s.onEditorResizeReset}
            onMouseDown={(e) => s.onEditorResizeStart(e, editorPanelRef, editorPanelRef)}
          />
        </Show>
        <Show when={pane().editorMode() !== "edit"}>
          <div
            class="preview-panel"
            ref={previewPanelRef}
            style={pane().editorMode() === "split" ? { flex: 100 - s.editorWidth() } : undefined}
          >
            <Show when={props.showToolbar && !!pane().selectedFile()}>
              <ContentToolbar
                autoRefresh={s.autoRefresh()}
                fontFamilies={s.FontFamilies}
                fontPrefs={s.fontPrefs()}
                fontSizes={s.FontSizes}
                onFind={s.triggerPreviewFind}
                searchOpen={s.previewSearchOpen()}
                onToggleFind={() => s.setPreviewSearchOpen((value) => !value)}
                onFontPrefsChange={s.handleFontPrefsChange}
                onToggleAutoRefresh={() => s.setAutoRefresh((v) => !v)}
              />
            </Show>
            <div class="content">
              {props.contentWrapper
                ? props.contentWrapper(defaultContent())
                : defaultContent()}
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
