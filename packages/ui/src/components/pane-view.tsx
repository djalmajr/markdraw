import { Show, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useDroppable } from "../lib/dnd/index.ts";
import type { FSEntry } from "@markdraw/core/types.ts";
import { fileKind, UNSUPPORTED_CONTENT } from "@markdraw/core/utils.ts";
import { setStoredTableWrap } from "@markdraw/core/editor-prefs.ts";
import * as m from "@markdraw/i18n";
import { useLocale } from "@markdraw/i18n/solid";
import type { RecentFile } from "@markdraw/core/recent-files.ts";
import type { RecentFolder } from "@markdraw/core/recent-folders.ts";
import type { FavoriteFile } from "@markdraw/core/favorites.ts";
import { effectivePaneEditorMode, type AppState, type FragmentSource } from "../composables/create-app-state.ts";
import type { PaneStore } from "../composables/create-pane-store.ts";
import type { TabScrollPositions } from "../composables/create-tab-store.ts";
import { ContentToolbar } from "./content-toolbar.tsx";
import { Editor, type EditorApi } from "./editor.tsx";
import { EditorToolbar } from "./editor-toolbar.tsx";
import { EmptyState } from "./empty-state.tsx";
import { MediaViewer } from "./media-viewer.tsx";
import { Preview } from "./preview.tsx";
import { HtmlPreview } from "./html-preview.tsx";
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

export function capturePreviewScroll(article: HTMLElement, content: HTMLElement): TabScrollPositions {
  const blocks = Array.from(article.children);
  const scrollTop = content.scrollTop;
  if (blocks.length === 0) {
    return { previewScrollTop: scrollTop, previewScrollAnchor: null };
  }
  const contentTop = content.getBoundingClientRect().top;
  let blockIndex = blocks.findIndex((block) => block.getBoundingClientRect().bottom > contentTop + 1);
  if (blockIndex < 0) blockIndex = blocks.length - 1;
  return {
    previewScrollTop: scrollTop,
    previewScrollAnchor: {
      blockIndex,
      offset: blocks[blockIndex]!.getBoundingClientRect().top - contentTop,
    },
  };
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
  /** Resolve a workspace-relative file path into an asset URL the webview
   *  can load (desktop via `convertFileSrc`). Used by the media viewer to
   *  display images/PDFs. Returns null when the host can't resolve it. */
  resolveFileSrc?: (rootId: string, relativePath: string) => string | null;
  /** Blob fallback for the media viewer when `resolveFileSrc` yields null for a
   *  file the host can still read (desktop: dot-folder files via a confined
   *  byte read). Returns null when the host has no such route. */
  resolveFileBlob?: (rootId: string, relativePath: string) => (() => Promise<Blob>) | null;
  /** Desktop-only: render the embedded Excalidraw editor for a `.excalidraw`
   *  file. The extension leaves this undefined, so it never shows the editor. */
  renderExcalidraw?: (file: FSEntry, rootId: string) => JSX.Element;
  /** Desktop-only: serve an HTML file's directory (SPA) or its workspace folder
   *  (relative document) as an isolated origin — see HtmlPreviewFolderRoot.
   *  Undefined (web/extension) → the srcdoc fallback (relative paths only). */
  htmlPreviewHost?: {
    /** Platform-correct origin the entry document is served from (WebView2
     *  serves custom schemes as http://<scheme>.localhost — see
     *  HtmlPreviewFolderRoot). */
    docOrigin: (token: string) => string;
    register: (rootId: string, fileRelPath: string) => Promise<{ token: string; entryRel: string; ownRoot: boolean } | null>;
    setOverlay: (token: string, relPath: string, content: string) => void | Promise<void>;
    clearOverlay: (token: string, relPath: string) => void | Promise<void>;
  };
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
  onWindowDragStart?: (event?: MouseEvent) => void | Promise<void>;
  onNavigate?: (path: string, fragment?: string | null) => void;
  // Keep the id argument for AppShell's existing callback signature.
  onUnresolvedFragment?: (id: string, source: FragmentSource) => void;
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
  const isActive = createMemo(() => props.isActive);
  const editorMode = createMemo(() => effectivePaneEditorMode(pane()));
  const onSelectionPopover = (info: Parameters<AppState["setSelectionPopover"]>[0]) => {
    if (untrack(isActive)) s.setSelectionPopover(info);
  };

  // A closed pane's id is reused by the next split (`pane-1` again): drop its
  // anchor requests when this pane leaves the layout, so the new pane never
  // inherits them. A pane that only remounts (still listed) keeps its own.
  onCleanup(() => {
    const closing = pane();
    const listed = s.paneManager ? untrack(s.paneManager.panes) : [closing];
    if (!listed.includes(closing)) s.setPendingHtmlNavigation(closing.paneId, null);
  });
  const matchesPane = (target: { rootId: string; path: string }) =>
    pane().selectedRootId() === target.rootId && pane().selectedFile()?.path === target.path;
  // F6: a pending fragment belongs to the pane that navigated. Other panes
  // render no pending fragment, so their Previews never consume or clear it.
  const ownsPendingFragment = () => {
    const owner = s.pendingFragmentOwner?.();
    return !owner || owner === pane().paneId;
  };
  const pendingFragment = () => ownsPendingFragment() ? s.pendingFragment() : null;
  const pendingHtmlNavigation = () => {
    const target = s.pendingHtmlNavigation()[pane().paneId];
    return target && matchesPane(target) ? target : null;
  };
  const htmlFragment = () => {
    const pending = pendingHtmlNavigation();
    if (pending) return pending.fragment;
    const applied = s.appliedHtmlNavigation()[pane().paneId];
    return applied && matchesPane(applied) ? applied.fragment : null;
  };
  createEffect(
    () => props.htmlPreviewHost ? [pane().selectedRootId(), pane().selectedFile()?.path] as const : null,
    (selection) => {
      if (!selection) return;
      const [rootId, path] = selection;
      const applied = untrack(s.appliedHtmlNavigation)[pane().paneId];
      if (applied && (applied.rootId !== rootId || applied.path !== path)) {
        s.clearAppliedHtmlNavigation(pane().paneId);
      }
    },
    { defer: true },
  );

  // When the selected file is an image or PDF, the media viewer takes
  // over the whole content area — there's no text to edit or convert.
  // Derived from THIS pane's file (not the AppState proxy) so split panes
  // route independently.
  const mediaKind = () => {
    const f = pane().selectedFile();
    if (!f) return null;
    const k = fileKind(f.name);
    return k === "image" || k === "pdf" ? k : null;
  };
  const isMedia = () => mediaKind() !== null;
  // Blob route first: when the host can read the file through its own
  // confined route (desktop: dot-folder files the asset protocol refuses),
  // `resolveFileSrc` would hand the viewer a URL that cannot load.
  const mediaBlob = () => {
    const f = pane().selectedFile();
    const rootId = pane().selectedRootId();
    if (!f || !rootId || !props.resolveFileBlob) return null;
    return props.resolveFileBlob(rootId, f.path);
  };
  const mediaSrc = () => {
    const f = pane().selectedFile();
    const rootId = pane().selectedRootId();
    if (!f || !rootId || !props.resolveFileSrc || mediaBlob()) return null;
    return props.resolveFileSrc(rootId, f.path);
  };

  // A `.excalidraw` file opens in the embedded Excalidraw editor instead of the
  // editor/preview pipeline. Desktop-only: the host must provide
  // `renderExcalidraw` (the extension doesn't, so it never enters this branch).
  const isExcalidraw = () => {
    const f = pane().selectedFile();
    return !!f && !!props.renderExcalidraw && fileKind(f.name) === "excalidraw";
  };

  // `.html`/`.htm` files preview in a sandboxed iframe (their own scripts/styles
  // render with full fidelity) instead of the Markdown/AsciiDoc sanitizer.
  const isHtml = () => {
    const f = pane().selectedFile();
    return !!f && fileKind(f.name) === "html";
  };
  // asset:// URL of the file's directory (with a REAL trailing slash) so the
  // previewed HTML resolves its relative resources (CSS / images / links).
  //
  // `convertFileSrc` percent-encodes the WHOLE path as one opaque segment
  // (macOS: `asset://localhost/%2FUsers%2F…%2Ffile.html`), so the path has no
  // real `/` separators to slice on — and a base ending in `%2F` isn't a
  // directory boundary the browser will append to. We resolve the directory's
  // path instead, strip any trailing separator, and append a literal `/`. The
  // asset handler percent-decodes `%2F` and `/` alike, so the mixed URL
  // (`…%2Fdir/style.css`) still maps to the right file on disk.
  const htmlBaseHref = (): string | undefined => {
    const f = pane().selectedFile();
    const rootId = pane().selectedRootId();
    if (!f || !rootId || !props.resolveFileSrc) return undefined;
    const slash = f.path.lastIndexOf("/");
    const dirRel = slash >= 0 ? f.path.slice(0, slash) : "";
    const src = props.resolveFileSrc(rootId, dirRel);
    if (!src) return undefined;
    return `${src.replace(/(%2[fF]|\/)+$/, "")}/`;
  };

  // Desktop SPA preview: a per-file host the HtmlPreview registers to serve the
  // file's directory as an isolated origin. A NEW object identity per file (the
  // closure captures f.path/rootId) makes the preview re-register on switch.
  const htmlFolderRoot = createMemo(() => {
    if (!isHtml()) return undefined;
    const host = props.htmlPreviewHost;
    const f = pane().selectedFile();
    const rootId = pane().selectedRootId();
    if (!host || !f || !rootId) return undefined;
    return {
      docOrigin: host.docOrigin,
      register: () => host.register(rootId, f.path),
      setOverlay: host.setOverlay,
      clearOverlay: host.clearOverlay,
    };
  });

  // The file-loader writes UNSUPPORTED_CONTENT into html when the file can
  // be neither rendered nor edited (a binary that isn't an image/PDF). Show
  // the notice instead of editor/preview.
  const isUnsupported = () => pane().html() === UNSUPPORTED_CONTENT;

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
  // The container that holds both the editor panel and the preview
  // panel side by side. The editor/preview resize handler needs to
  // query for `.editor-panel` and `.content` (inside `.preview-panel`)
  // to compute the new split percentage — passing `editorPanelRef`
  // as the search root would never find either sibling, which is the
  // bug that made the drag-handle silently do nothing.
  let contentPanelsRef: HTMLDivElement | undefined;

  pane().tabs.setScrollCapture?.((tabId) => {
    const content = previewPanelRef?.querySelector<HTMLElement>(".content");
    if (!content) return {};
    const article = content.querySelector<HTMLElement>(".doc-body");
    // While a file loads the old article remains hidden in the DOM. Only a
    // drawn article tagged with this very tab may update its saved position.
    if (!article || article.children.length === 0 || article.dataset.previewTabId !== tabId) {
      return {};
    }
    return capturePreviewScroll(article, content);
  });

  const getTabScrollRestore = () => {
    const tab = pane().tabs.getActiveTab?.();
    if (!tab) return null;
    return {
      tabId: tab.id,
      path: tab.filePath,
      scrollTop: tab.previewScrollTop,
      anchor: tab.previewScrollAnchor,
    };
  };

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
    editorMode() === "split" && s.syncScroll() && !!pane().selectedFile();

  createEffect(
    () => syncScrollActive(),
    (active) => {
      if (active) return;
      setEditorSyncTargetRatio(null);
      setPreviewSyncTargetRatio(null);
    },
  );

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
        <Show
          when={isHtml()}
          fallback={
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
          wrapTables={pane().tableWrap()}
          tocContainer={props.tocContainer}
          currentFilePath={pane().selectedFile()?.path ?? null}
          currentTabId={pane().tabs.activeTabId?.() ?? null}
          tabActivationVersion={pane().tabs.activationVersion?.()}
          getTabScrollRestore={getTabScrollRestore}
          pendingFragment={pendingFragment()}
          pendingHeadingText={s.pendingHeadingText()}
          onHeadingHandled={() => s.setPendingHeadingText(null)}
          onHeadingDiscarded={(heading) => {
            if (untrack(s.pendingHeadingText) === heading) s.setPendingHeadingText(null);
          }}
          previewOverlayHost={previewPanelRef}
          onScrollRatioChange={(ratio) => {
            if (!syncScrollActive()) return;
            setEditorSyncTargetRatio(ratio);
            setEditorSyncTargetVersion((value) => value + 1);
          }}
          onFragmentHandled={() => {
            if (untrack(ownsPendingFragment)) s.setPendingFragment(null);
          }}
          onFragmentDiscarded={(fragment) => {
            if (untrack(ownsPendingFragment) && untrack(s.pendingFragment) === fragment) {
              s.setPendingFragment(null);
            }
          }}
          onNavigate={(target, fragment) => props.onNavigate?.(target, fragment)}
          onUnresolvedFragment={(id) => {
            const clickedPane = pane();
            const tab = clickedPane.tabs.getActiveTab();
            if (!tab || clickedPane.selectedFile()?.path !== tab.filePath) return;
            props.onUnresolvedFragment?.(id, Object.freeze({
              id,
              paneId: clickedPane.paneId,
              tabId: tab.id,
              rootId: tab.rootId,
              path: tab.filePath,
            }));
          }}
          onOpenExternal={props.onOpenExternal}
          onSearchOpenChange={s.setPreviewSearchOpen}
          onSelectionPopover={onSelectionPopover}
          onTocChange={(has) => s.setHasToc(has)}
        />
          }
        >
          <HtmlPreview
            content={pane().editorContent()}
            baseHref={htmlBaseHref()}
            folderRoot={htmlFolderRoot()}
            fragment={htmlFragment()}
            onFragmentHandled={() => {
              const target = untrack(pendingHtmlNavigation);
              if (!target) return;
              s.consumePendingHtmlNavigation(pane().paneId, target);
              if (target.fragment && ownsPendingFragment()
                && untrack(s.pendingFragment) === target.fragment) s.setPendingFragment(null);
            }}
          />
        </Show>
      </Show>
    );
  }

  return (
    <div
      ref={paneDroppable.ref}
      class={["pane-view", {
        "pane-view-active": props.isActive,
        "pane-view-drop-target": paneDroppable.isDropTarget(),
      }]}
      
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
      <div class="content-panels" ref={contentPanelsRef}>
        <Show when={isExcalidraw()}>
          <div class="preview-panel">
            {props.renderExcalidraw?.(pane().selectedFile()!, pane().selectedRootId()!)}
          </div>
        </Show>
        <Show when={isMedia()}>
          <div class="preview-panel">
            <MediaViewer
              kind={mediaKind()!}
              src={mediaSrc()}
              loadBlob={mediaBlob()}
              fileName={pane().selectedFile()!.name}
            />
          </div>
        </Show>
        <Show when={isUnsupported()}>
          <div class="preview-panel">
            <div class="media-stage">
              <div class="media-message">
                {(useLocale(), m.viewer_unsupported_format({ name: pane().selectedFile()?.name ?? "" }))}
              </div>
            </div>
          </div>
        </Show>
        <Show when={!isMedia() && !isExcalidraw() && !isUnsupported() && editorMode() !== "preview" && pane().selectedFile()}>
          <div
            class="editor-panel"
            ref={editorPanelRef}
            style={editorMode() === "split" ? { flex: s.editorWidth() } : { flex: 1 }}
          >
            <Show when={props.showToolbar}>
              <EditorToolbar
                canRedo={canRedo()}
                canUndo={canUndo()}
                showInvisibles={s.showInvisibles()}
                showLineNumbers={s.showLineNumbers()}
                showSyncScroll={editorMode() === "split"}
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
              fileName={pane().selectedFile()?.name}
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
              onReady={(api) => {
                // Ad-hoc handle on the pane so the host (⌘I / inline overlay)
                // can read the selection and apply AI edits to THIS pane.
                (pane() as PaneStore & { editorApi?: EditorApi }).editorApi = api;
              }}
              onSelectionPopover={onSelectionPopover}
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
        <Show when={!isMedia() && !isExcalidraw() && !isUnsupported() && editorMode() === "split" && pane().selectedFile()}>
          <div
            class="resize-handle"
            onDblClick={s.onEditorResizeReset}
            onMouseDown={(e) => s.onEditorResizeStart(e, contentPanelsRef, contentPanelsRef)}
          />
        </Show>
        <Show when={!isMedia() && !isExcalidraw() && !isUnsupported() && editorMode() !== "edit"}>
          <div
            class="preview-panel"
            ref={previewPanelRef}
            style={editorMode() === "split" ? { flex: 100 - s.editorWidth() } : undefined}
          >
            {/* HTML renders in an isolated iframe with its own styles, so the
                preview toolbar's font / table-wrap / find controls don't apply
                — hide it (it also removed an empty band at the top of SPAs). */}
            <Show when={props.showToolbar && !!pane().selectedFile() && !isHtml()}>
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
                tableWrap={pane().tableWrap()}
                onToggleTableWrap={() => {
                  // Per-pane: flip THIS pane's signal only. Persist the
                  // new value as the seed so freshly split panes and the
                  // next session inherit the last choice; live panes stay
                  // independent (each already captured its own seed).
                  const next = !pane().tableWrap();
                  pane().setTableWrap(next);
                  setStoredTableWrap(next);
                }}
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
