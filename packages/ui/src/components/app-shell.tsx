import { For, Show, createEffect, createMemo, createSignal, type JSX } from "solid-js";
import { DragDropProvider, DragOverlay } from "@dnd-kit/solid";
import type { FSEntry } from "@asciimark/core/types.ts";
import * as m from "@asciimark/i18n";
import { useLocale } from "@asciimark/i18n/solid";
import type { RecentFile } from "@asciimark/core/recent-files.ts";
import { flattenWorkspace, type IndexedFile } from "@asciimark/core/file-index.ts";
import type { AppState } from "../composables/create-app-state.ts";
import type { PaneStore } from "../composables/create-pane-store.ts";
import type { TabStore } from "../composables/create-tab-store.ts";
import { AppProvider } from "../context/app-context.tsx";
import { Toolbar } from "./toolbar.tsx";
import { FileTree } from "./file-tree.tsx";
import { EmptyState } from "./empty-state.tsx";
import { Toaster } from "./ui/toast.tsx";
import { ConfirmDialog } from "./confirm-dialog.tsx";
import { AboutDialog } from "./about-dialog.tsx";
import { PaneView, fromPaneDropDndId } from "./pane-view.tsx";
import { PaneSplitter } from "./pane-splitter.tsx";
import { fromTabDndId } from "./tab-bar.tsx";
import { TocPanel } from "./toc-panel.tsx";
import { BacklinksList, type BacklinkEntry } from "./backlinks-list.tsx";
import { AiPanel } from "./ai-panel.tsx";
import { AiInlineOverlay } from "./ai-inline-overlay.tsx";
import {
  SettingsDialog,
  type IndexingTier,
  type SettingsAiProvider,
} from "./settings-dialog.tsx";
import { QuickOpen } from "./quick-open.tsx";
import { ShortcutsHelp } from "./shortcuts-help.tsx";
import { CommandPalette } from "./command-palette.tsx";
import type { Command } from "@asciimark/core/command-palette.ts";
import { SymbolPalette } from "./symbol-palette.tsx";
import { WorkspaceSymbolPalette } from "./workspace-symbol-palette.tsx";
import { extractHeadings, type Heading } from "@asciimark/core/headings.ts";
import { FindInFiles, type FileMatch, type MatchSelection } from "./find-in-files.tsx";

interface AppShellProps {
  state: AppState;

  // Platform-specific booleans (as accessors for reactivity)
  hasRoot: boolean;
  showRecentHistory?: boolean;
  showEditorTabs: boolean;
  showNavButtons: boolean;
  showToolbar: boolean;
  showPdfExport?: boolean;
  showSidebar: boolean;
  /**
   * Flag indicating the app is drawing its own caption buttons in the
   * top-right (currently Windows with `decorations: false`). Used to
   * route the toolbar controls to the left so they don't overlap.
   * The actual caption button component is rendered by the host app,
   * since it depends on Tauri APIs not available in packages/ui.
   */
  showWindowControls?: boolean;
  windowFrameToolbar?: boolean;
  /** Desktop-only: render the "Window" submenu in the toolbar
   *  dropdown that toggles the OS-close behaviour between
   *  "minimize to tray" and "quit app". Extensions leave this
   *  undefined; the submenu is hidden because the gesture has no
   *  meaning in a browser tab. */
  showCloseBehaviorToggle?: boolean;

  // Platform-derived toolbar strings
  toolbarFilePath: string | null;
  toolbarRootName: string;

  // Platform callbacks
  /**
   * Trigger a manual app-update check. Only desktop wires this; web/extension
   * leave it undefined and the menu item is hidden.
   */
  onCheckForUpdates?: () => void;
  /**
   * Open the standalone Release Notes dialog. Only desktop wires this;
   * extension leaves it undefined and the menu item is hidden.
   */
  onReleaseNotes?: () => void;
  onCloseRoot?: (rootId: string) => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onLoadFile: (entry: FSEntry, rootId: string) => void;
  /** Label for the AI provider chip (e.g. "Ollama · local"), or null/undefined
   *  → "No provider". DJA-12. */
  aiProviderLabel?: string | null;
  /** Opens Settings → AI (AI panel empty-state CTA). Wired by DJA-15. */
  onOpenSettings?: () => void;
  // Settings modal (DJA-15)
  settingsOpen?: boolean;
  onSettingsClose?: () => void;
  aiProviders?: SettingsAiProvider[];
  aiSelectedModel?: string | null;
  /** MCP servers (config + live status) for the Settings → MCP section, plus
   *  add/remove/toggle handlers. Forwarded to SettingsDialog. */
  mcpServers?: Array<{
    id: string;
    name?: string;
    transport: "stdio" | "http";
    enabled: boolean;
    connected: boolean;
    toolCount: number;
    command?: string;
    url?: string;
    error?: string;
  }>;
  onSaveMcpServer?: (server: {
    id: string;
    name?: string;
    transport: "stdio" | "http";
    command?: string;
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
    enabled: boolean;
  }) => void | Promise<void>;
  onRemoveMcpServer?: (id: string) => void | Promise<void>;
  onToggleMcpServer?: (id: string, enabled: boolean) => void | Promise<void>;
  indexingTier?: IndexingTier;
  onIndexingTierChange?: (tier: IndexingTier) => void;
  aiStreaming?: boolean;
  onAiStreamingChange?: (enabled: boolean) => void;
  onListModels?: (providerId: string, apiKey: string) => Promise<string[]>;
  onSaveAiProvider?: (opts: {
    providerId: string;
    apiKey: string;
    modelId: string;
  }) => void | Promise<void>;
  onOpenInNewTab?: (entry: FSEntry, rootId: string) => void;
  onDoubleClickFile?: (entry: FSEntry, rootId: string) => void;
  onNavigate: (path: string, fragment?: string | null) => void;
  onOpenExternal?: (url: string) => void;
  onOpenFolder?: () => void;
  onOpenRecentFile?: (recentFile: RecentFile) => void | Promise<void>;
  onOpenRecentFolder?: (path: string) => void | Promise<void>;
  /**
   * Copy the absolute filesystem path of a tree entry. Platforms with
   * filesystem access (desktop) pass this; the file tree falls back to
   * copying the workspace-relative path when omitted.
   */
  onCopyPath?: (entry: FSEntry, rootId: string) => void | Promise<void>;
  /** Desktop-only: reveal a file/folder in the OS file manager (Finder /
   *  Explorer / file manager). Omitted on web/extension. */
  onRevealInFileManager?: (entry: FSEntry, rootId: string) => void | Promise<void>;
  /**
   * Rename a file or directory. Only platforms with write access (desktop)
   * pass this; if absent, the file tree hides the Rename menu item.
   */
  onRename?: (entry: FSEntry, rootId: string, newName: string) => Promise<void>;
  onDelete?: (entry: FSEntry, rootId: string) => Promise<void>;
  /** Desktop-only: commit an inline-created file/folder under `parentPath`. */
  onCreate?: (parentPath: string, name: string, kind: "file" | "folder", rootId: string) => void;
  /** Desktop-only: move an entry into a directory ("" = workspace root). */
  onMove?: (entry: FSEntry, targetDirRel: string, rootId: string, targetRootId?: string) => void | Promise<void>;
  /** Desktop-only: copy an entry into a directory ("" = workspace root). */
  onCopy?: (entry: FSEntry, targetDirRel: string, rootId: string, targetRootId?: string) => void | Promise<void>;
  /**
   * Resolve an `<img>` src in the rendered document. Desktop maps relative
   * paths to Tauri asset URLs so the webview can load files from disk.
   */
  resolveImageSrc?: (src: string) => string | null;
  /** Resolve a workspace-relative file path into an asset URL for the
   *  builtin image/PDF viewer. Desktop maps it through Tauri's asset
   *  protocol. */
  resolveFileSrc?: (rootId: string, relativePath: string) => string | null;
  /** Desktop-only: render the embedded Excalidraw editor for a `.excalidraw`
   *  file. Passed straight through to each PaneView. */
  renderExcalidraw?: (file: FSEntry, rootId: string) => JSX.Element;
  onToggleShowHiddenEntries?: (enabled: boolean) => void | Promise<void>;
  /** Desktop-only: paired with the new file-tree dropdown toggle that
   *  filters entries through `.gitignore`. The shell flips
   *  `respectGitignore` state and forwards the new value so the host
   *  can refresh the workspace roots. Extension passes nothing → the
   *  toggle is hidden. */
  onToggleRespectGitignore?: (enabled: boolean) => void | Promise<void>;
  /**
   * Force-reload a single workspace root from disk. Optional — currently
   * wired by the extension to recover from stale handles after a permission
   * regrant. Desktop relies on the watcher and does not pass this.
   */
  onRefreshRoot?: (rootId: string) => void | Promise<void>;
  onReorderRoots?: (newOrder: string[]) => void;
  tabStore?: TabStore;
  onActivateTab?: (tabId: string) => void;
  onCloseTab?: (tabId: string) => void;
  onNewTab?: () => void;
  onWindowDragStart?: () => void | Promise<void>;
  onWindowTitleDoubleClick?: () => void | Promise<void>;

  /**
   * Quick Open (Cmd/Ctrl+P) overlay state. The host owns the open/closed
   * boolean and the recents set so platforms without a recents store can
   * keep the overlay working without changes here.
   */
  quickOpenOpen?: boolean;
  quickOpenRecents?: ReadonlySet<string>;
  onQuickOpenSelect?: (file: IndexedFile) => void;
  onQuickOpenClose?: () => void;

  /** Shortcuts help (Cmd/Ctrl+/) modal state. Host-owned for the same
   *  reason as Quick Open. */
  shortcutsHelpOpen?: boolean;
  onShortcutsHelpClose?: () => void;
  /** Toolbar fires this when the user picks "Keyboard shortcuts" from the
   *  hamburger menu. AppShell flips the host's open signal via this. */
  onShortcutsHelpOpen?: () => void;

  /** Command palette (Cmd/Ctrl+Shift+P). Same host-owned pattern. The
   *  catalog is built by the host because the side-effects bound to
   *  each command (open dialog, invoke IPC, mutate signals) are
   *  host-only. */
  commandPaletteOpen?: boolean;
  commandCatalog?: readonly Command[];
  onCommandPaletteClose?: () => void;

  /** Go-to-Symbol palette (Cmd/Ctrl+Shift+O). AppShell extracts headings
   *  from the active file's editor content; the host only owns the
   *  open/close toggle. */
  symbolPaletteOpen?: boolean;
  onSymbolPaletteClose?: () => void;

  /** Workspace-wide symbol palette (Cmd/Ctrl+T). The host builds the
   *  symbol list (reading every doc's content) and AppShell renders
   *  + handles the navigation hop. Open/close toggle owned by host. */
  workspaceSymbolPaletteOpen?: boolean;
  workspaceSymbols?: ReadonlyArray<import("@asciimark/core/workspace-symbols.ts").WorkspaceSymbol>;
  onWorkspaceSymbolPaletteClose?: () => void;

  /** Find in Files (Cmd/Ctrl+Shift+F). AppShell renders the modal; the
   *  host provides the search function (typically the IPC client) and
   *  the close handler. The id of the active root is read from the
   *  current state so the host doesn't have to thread it. */
  findInFilesOpen?: boolean;
  findInFilesSearch?: (
    rootId: string,
    query: string,
    options: { caseSensitive: boolean },
  ) => Promise<FileMatch[]>;
  onFindInFilesClose?: () => void;

  /** Move a tab from `fromPaneIndex` to the other pane. When omitted,
   *  the "Move to Other Pane" context menu item is hidden. Host wires
   *  the actual cross-pane open + close orchestration. */
  onMoveTab?: (tabId: string, fromPaneIndex: number) => void;

  // Platform-specific content (extension: FileAccessWarning wrapper)
  contentWrapper?: (content: JSX.Element) => JSX.Element;

  // DnD (extension uses DOM events, desktop uses Tauri native)
  onDragLeave?: (e: DragEvent) => void;
  onDragOver?: (e: DragEvent) => void;
  onDrop?: (e: DragEvent) => void;

  /**
   * Enable the split-pane affordances: toolbar split toggle,
   * "Open in Split Pane" tab menu, and the active-pane border accent.
   * The browser extension turns this off (split makes no sense in a
   * single browser tab — duplicating preview/editor inside ~600px is
   * just wasted real estate). Defaults to true so desktop keeps it.
   */
  enableSplit?: boolean;

  /** Reload the active document. Wired by the host (extension URL mode
   *  re-fetches; folder mode re-reads from disk). When omitted, the
   *  toolbar Reload button is hidden. */
  onReload?: () => void;
  /** Copy the source URL of the active document. Used by the extension
   *  in URL mode for share/bookmark workflows. Hidden when omitted. */
  onCopySource?: () => void;
  /** Copy the raw text content (markdown/asciidoc source) of the active
   *  document. Hidden when omitted. */
  onCopyContent?: () => void;

  /** Render per-row menus in the file tree (three-dot dropdown +
   *  right-click context menu). Defaults to true; the extension turns
   *  this off because Copy path is the only meaningful entry there
   *  and a single-item menu just adds noise. */
  showFileTreeItemMenu?: boolean;

  /** About dialog. Hidden when `aboutVersion` is undefined (the
   *  extension passes nothing — there's no separate version concept
   *  for the in-tab viewer beyond what `manifest.json` already shows
   *  in `chrome://extensions`). */
  aboutOpen?: boolean;
  aboutVersion?: string;
  aboutCommit?: string;
  onAboutClose?: () => void;
  onAboutOpen?: () => void;
}

export function AppShell(props: AppShellProps) {
  let tocContainerRef: HTMLDivElement | undefined;
  let tocPanelRef: HTMLElement | undefined;
  let appRef: HTMLDivElement | undefined;
  let panesContainerRef: HTMLDivElement | undefined;

  const s = props.state;

  // Compute the flex basis for pane[i] given the split ratio. With 1
  // pane, that pane takes the whole row. With 2, the splitter ratio
  // governs the share — pane 0 gets `ratio`, pane 1 gets `1 - ratio`.
  // Multiplied by 100 because flex-grow expects unitless integers.
  function paneFlexBasis(index: number, count: number, ratio: number): number {
    if (count <= 1) return 1;
    return index === 0 ? ratio : 1 - ratio;
  }

  // Visible panes: hide secondary panes when no workspace is open. The
  // persisted layout might restore 2 panes from a prior session; with
  // no workspace each empty pane shows the dropzone EmptyState — which
  // duplicates the affordance and confuses the welcome screen. We
  // keep the persisted state intact so reopening a workspace brings
  // the split back automatically; we just don't render pane[1] yet.
  const visiblePanes = createMemo(() => {
    const all = s.paneManager.panes();
    if (!props.hasRoot) return all.slice(0, 1);
    return all;
  });

  /**
   * Single drag handler for the cross-pane DragDropProvider. Three
   * cases the user can produce by dragging a tab:
   *   1. Same-pane reorder — drop on a sibling tab; we swap them.
   *   2. Cross-pane move (onto a tab) — call `onMoveTab` so the host
   *      duplicates the tab to the target pane and closes the source.
   *   3. Cross-pane move (onto pane drop zone) — same as (2). The
   *      drop zone covers empty panes that have no tab to land on.
   *
   * Mutation-survival contracts (covered by the live e2e + the unit
   * tests on `handleMoveTab` in app.tsx):
   *   - Skipping the same-pane check would route a sibling-tab drop
   *     into `onMoveTab`, losing the file altogether on the same pane.
   *   - Reading targetPane from a wrong place sends the tab to the
   *     wrong pane.
   */
  // Use `any` because `@dnd-kit/solid`'s emitted shapes for the drag
  // event aren't exported as a single nameable type — the runtime
  // shape we care about is `event.operation.{source,target}.id`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handleTabDragEnd(event: any) {
    if (event?.canceled) return;
    const sourceId = event?.operation?.source?.id;
    const targetId = event?.operation?.target?.id;

    const source = fromTabDndId(sourceId);
    if (!source) return;

    const sourcePane = s.paneManager.panes()[source.paneIndex];
    if (!sourcePane) return;

    // Case A: target is a tab (could be in the same pane or another).
    const targetTab = fromTabDndId(targetId);
    if (targetTab) {
      if (targetTab.paneIndex === source.paneIndex) {
        // Same-pane reorder: swap source and target inside the bar.
        const order = sourcePane.tabs.tabs().map((t) => t.id);
        const sIdx = order.indexOf(source.tabId);
        const tIdx = order.indexOf(targetTab.tabId);
        if (sIdx === -1 || tIdx === -1 || sIdx === tIdx) return;
        const next = [...order];
        next[sIdx] = order[tIdx]!;
        next[tIdx] = order[sIdx]!;
        sourcePane.tabs.reorderTabs(next);
        return;
      }
      // Cross-pane: move via the host handler.
      props.onMoveTab?.(source.tabId, source.paneIndex);
      return;
    }

    // Case B: target is a pane drop zone.
    const targetPaneIdx = fromPaneDropDndId(targetId);
    if (targetPaneIdx !== null && targetPaneIdx !== source.paneIndex) {
      props.onMoveTab?.(source.tabId, source.paneIndex);
    }
  }

  function setTocExpanded(expanded: boolean) {
    if (!tocContainerRef) return;
    const items = tocContainerRef.querySelectorAll<HTMLLIElement>("#toc li.toc-collapsible");
    for (const item of items) {
      item.classList.toggle("toc-expanded", expanded);
      item.classList.toggle("toc-collapsed", !expanded);
      const toggle = item.querySelector<HTMLElement>(":scope > .toc-toggle");
      if (toggle) {
        toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
      }
    }
  }

  // When no file is open the active pane unmounts its <Preview>, so
  // `onTocChange` never gets called to clear `hasToc` — without this
  // effect the panel keeps showing the previous file's toc tree (left
  // over from when it was the active doc) instead of the empty-state
  // message. We also drop the orphan DOM nodes from the shared
  // container so the `<Show when={!s.hasToc()}>` placeholder gets a
  // clean canvas to render on.
  createEffect(() => {
    if (s.hasFile()) return;
    s.setHasToc(false);
    if (tocContainerRef) tocContainerRef.textContent = "";
  });

  // Lazily flatten the workspace only while the Quick Open overlay is open.
  // `state.rootsList` is reactive, so the memo refreshes when files are
  // added or roots change underneath an open overlay.
  const quickOpenFiles = createMemo<IndexedFile[]>(() => {
    if (!props.quickOpenOpen) return [];
    return flattenWorkspace(s.rootsList());
  });

  // Symbol palette source: parse headings from the active file's editor
  // content, dispatched by extension. Computed lazily — only when the
  // overlay is open. Falls back to empty when no file is selected.
  const symbolHeadings = createMemo<Heading[]>(() => {
    if (!props.symbolPaletteOpen) return [];
    const file = s.selectedFile();
    if (!file) return [];
    return extractHeadings(file.path, s.editorContent());
  });

  // Find-in-Files match selected → open the file via the host's
  // `onLoadFile` and bump the active pane's scrollToLine so the line
  // is centered. The bump is deferred a microtask to give Solid time
  // to flush the file load (which includes a fetch + convert pass)
  // before the editor receives the new content. The scrollToLine
  // setter is attached on the pane by `<PaneView>` itself (so we can
  // address whichever pane is active when the user picked the match).
  function handleFindInFilesSelect(selection: MatchSelection) {
    const entry = s.findEntryByPath(selection.path, selection.rootId);
    if (entry && entry.kind === "file") {
      props.onLoadFile(entry, selection.rootId);
      queueMicrotask(() => {
        setTimeout(() => {
          const pane = s.paneManager.activePane() as PaneStore & {
            setScrollToLine?: (line: number) => void;
          };
          pane.setScrollToLine?.(selection.line);
        }, 0);
      });
    }
    props.onFindInFilesClose?.();
  }

  return (
    <AppProvider state={props.state}>
      <Toaster />
      <ConfirmDialog />
      <QuickOpen
        open={!!props.quickOpenOpen}
        files={quickOpenFiles()}
        recents={props.quickOpenRecents}
        onSelect={(file) => props.onQuickOpenSelect?.(file)}
        onClose={() => props.onQuickOpenClose?.()}
      />
      <ShortcutsHelp
        open={!!props.shortcutsHelpOpen}
        onClose={() => props.onShortcutsHelpClose?.()}
      />
      <AiInlineOverlay store={s.aiInline} />
      <Show when={props.settingsOpen}>
        <SettingsDialog
          open={!!props.settingsOpen}
          onClose={() => props.onSettingsClose?.()}
          aiProviders={props.aiProviders ?? []}
          selectedModel={props.aiSelectedModel ?? null}
          indexingTier={props.indexingTier ?? "lite"}
          onTierChange={(t) => props.onIndexingTierChange?.(t)}
          onListModels={(id, key) =>
            props.onListModels?.(id, key) ?? Promise.resolve([])
          }
          onSaveProvider={(o) => props.onSaveAiProvider?.(o)}
          mcpServers={props.mcpServers ?? []}
          onSaveMcpServer={(s) => props.onSaveMcpServer?.(s)}
          onRemoveMcpServer={(id) => props.onRemoveMcpServer?.(id)}
          onToggleMcpServer={(id, enabled) => props.onToggleMcpServer?.(id, enabled)}
          aiStreaming={props.aiStreaming ?? false}
          onAiStreamingChange={(v) => props.onAiStreamingChange?.(v)}
          appVersion={props.aboutVersion}
        />
      </Show>
      <Show when={props.aboutVersion}>
        <AboutDialog
          open={!!props.aboutOpen}
          version={props.aboutVersion!}
          commit={props.aboutCommit}
          onClose={() => props.onAboutClose?.()}
        />
      </Show>
      <CommandPalette
        open={!!props.commandPaletteOpen}
        commands={props.commandCatalog ?? []}
        onClose={() => props.onCommandPaletteClose?.()}
      />
      <SymbolPalette
        open={!!props.symbolPaletteOpen}
        headings={symbolHeadings()}
        onSelect={(heading) => {
          // Route to the active pane's scrollToLine setter (attached
          // by its <PaneView> instance). Mutating the pane signal
          // re-tracks the editor effect even when the same line is
          // jumped to twice in a row.
          const pane = s.paneManager.activePane() as PaneStore & {
            setScrollToLine?: (line: number) => void;
          };
          pane.setScrollToLine?.(heading.line);
          props.onSymbolPaletteClose?.();
        }}
        onClose={() => props.onSymbolPaletteClose?.()}
      />
      <WorkspaceSymbolPalette
        open={!!props.workspaceSymbolPaletteOpen}
        symbols={props.workspaceSymbols ?? []}
        onSelect={(symbol) => {
          // Open the file in the active pane (load-in-active-tab
          // semantics — single-click style).
          props.onLoadFile?.(
            { kind: "file", name: symbol.fileName, path: symbol.path },
            symbol.rootId,
          );
          // Two-pronged scroll: editor jumps by line (works in
          // edit/split modes), preview jumps by heading text after
          // the html renders (works in preview/split modes).
          // setPendingHeadingText is read in Preview's afterSwap;
          // setScrollToLine is consumed by the PaneView wiring.
          s.setPendingHeadingText(symbol.heading.text);
          queueMicrotask(() => {
            const pane = s.paneManager.activePane() as PaneStore & {
              setScrollToLine?: (line: number) => void;
            };
            pane.setScrollToLine?.(symbol.heading.line);
          });
          props.onWorkspaceSymbolPaletteClose?.();
        }}
        onClose={() => props.onWorkspaceSymbolPaletteClose?.()}
      />
      <FindInFiles
        open={!!props.findInFilesOpen}
        rootId={s.selectedRootId()}
        search={props.findInFilesSearch ?? (() => Promise.resolve([]))}
        onSelect={handleFindInFilesSelect}
        onClose={() => props.onFindInFilesClose?.()}
      />
      <div
        class="app"
        classList={{
          "drag-over": s.dragOver(),
          "window-frame-toolbar": !!props.windowFrameToolbar,
          // Reader / Zen mode — drives the chrome-collapsing rules
          // in `index.css`. The `<Show>` blocks below for sidebar /
          // TOC stay reactive; this class shortcuts the visual
          // hide without unmounting heavy subtrees so toggling is
          // instant.
          "reader-mode": s.readerMode(),
        }}
        ref={appRef}
        onDragOver={props.onDragOver}
        onDragLeave={props.onDragLeave}
        onDrop={props.onDrop}
      >
        <Show when={props.showToolbar}>
          <Toolbar
            canGoBack={s.canGoBack()}
            canGoForward={s.canGoForward()}
            darkMode={s.darkMode()}
            editorMode={s.editorMode()}
            hasFile={s.hasFile()}
            hasRoot={props.hasRoot}
            onCheckForUpdates={props.onCheckForUpdates}
            onReleaseNotes={props.onReleaseNotes}
            onShortcutsHelp={props.onShortcutsHelpOpen}
            onAbout={props.aboutVersion ? props.onAboutOpen : undefined}
            onOpenSettings={props.onOpenSettings}
            isSplit={visiblePanes().length > 1}
            onToggleSplit={
              props.enableSplit === false
                ? undefined
                : () => {
                    if (s.paneManager.panes().length > 1) {
                      s.paneManager.collapseRightPane();
                    } else {
                      s.paneManager.splitFromActive();
                    }
                  }
            }
            supportsPreview={s.canPreview()}
            supportsEdit={s.canEdit()}
            inWindowFrame={!!props.windowFrameToolbar}
            controlsOnLeft={!!props.showWindowControls}
            recentFiles={s.recentFiles()}
            recentFolders={s.recentFolders()}
            showEditorTabs={props.showEditorTabs}
            showNavButtons={props.showNavButtons}
            showRecentHistory={!!props.showRecentHistory}
            sidebarVisible={s.sidebarVisible()}
            themeMode={s.themeMode()}
            closeBehavior={props.showCloseBehaviorToggle ? s.closeBehavior() : undefined}
            tocVisible={s.tocVisible()}
            onEditorModeChange={(m) => s.setEditorMode(m)}
            onExportPdf={props.showPdfExport !== false ? s.handleExportPdf : undefined}
            onGoBack={props.onGoBack}
            onGoForward={props.onGoForward}
            onOpenFolder={props.onOpenFolder}
            onOpenRecentFile={props.onOpenRecentFile}
            onOpenRecentFolder={props.onOpenRecentFolder}
            onThemeChange={s.handleThemeChange}
            onCloseBehaviorChange={
              props.showCloseBehaviorToggle ? s.handleCloseBehaviorChange : undefined
            }
            onToggleSidebar={() => s.setSidebarVisible((v) => !v)}
            onToggleToc={() => s.setTocVisible((v) => !v)}
            onReload={props.onReload}
            onCopySource={props.onCopySource}
            onCopyContent={props.onCopyContent}
            onWindowDragStart={props.onWindowDragStart}
            onWindowTitleDoubleClick={props.onWindowTitleDoubleClick}
          />
        </Show>
        <div class="main">
          <Show when={props.showSidebar}>
            <aside class="sidebar" style={{ width: `${s.sidebarWidth()}px` }}>
              <FileTree
                showItemMenu={props.showFileTreeItemMenu}
                roots={s.rootsList()}
                selectedPath={s.selectedFile()?.path ?? null}
                selectedRootId={s.selectedRootId()}
                showHiddenEntries={s.showHiddenEntries()}
                showAllDirs={s.showAllDirs()}
                showAllFiles={s.showAllFiles()}
                respectGitignore={s.respectGitignore()}
                onCloseRoot={props.onCloseRoot}
                onCopyPath={props.onCopyPath}
                onRevealInFileManager={props.onRevealInFileManager}
                onRename={props.onRename}
                onDelete={props.onDelete}
                onCreate={props.onCreate}
                onMove={props.onMove}
                onCopy={props.onCopy}
                onReorderRoots={props.onReorderRoots}
                onSelect={(entry, rootId) => props.onLoadFile(entry, rootId)}
                onOpenInNewTab={props.onOpenInNewTab}
                onDoubleClickFile={props.onDoubleClickFile}
                onToggleRootCollapsed={(id) => s.toggleRootCollapsed(id)}
                onToggleShowHiddenEntries={props.onToggleShowHiddenEntries
                  ? () => {
                    const next = !s.showHiddenEntries();
                    s.setShowHiddenEntries(next);
                    void props.onToggleShowHiddenEntries?.(next);
                  }
                  : undefined}
                onToggleRespectGitignore={props.onToggleRespectGitignore
                  ? () => {
                    const next = !s.respectGitignore();
                    s.handleRespectGitignoreChange(next);
                    void props.onToggleRespectGitignore?.(next);
                  }
                  : undefined}
                onToggleShowAllDirs={() => s.setShowAllDirs((v) => !v)}
                onToggleShowAllFiles={() => s.setShowAllFiles((v) => !v)}
              />
            </aside>
            <div class="resize-handle" onDblClick={s.onResizeReset} onMouseDown={(e) => s.onResizeStart(e, appRef)} />
          </Show>
          <div class="content-area">
            <DragDropProvider onDragEnd={handleTabDragEnd}>
              <div class="panes-container" ref={panesContainerRef}>
                <For each={visiblePanes()}>
                  {(pane, i) => (
                    <>
                      <Show when={i() > 0}>
                        <PaneSplitter
                          ratio={s.paneManager.splitRatio()}
                          container={() => panesContainerRef}
                          onResize={s.paneManager.setSplitRatio}
                        />
                      </Show>
                      <PaneView
                        pane={pane}
                        paneIndex={i()}
                        isActive={
                          // The active-pane border accent only makes
                          // sense when there is something to
                          // distinguish from. With a single visible
                          // pane there is no "other" to point at — the
                          // 2px primary stripe just creates an empty
                          // bar at the top (visible in the extension's
                          // ~600px window). Restrict the active flag to
                          // multi-pane layouts.
                          visiblePanes().length > 1 &&
                          i() === s.paneManager.activePaneIndex()
                        }
                        state={s}
                        flexBasis={paneFlexBasis(i(), visiblePanes().length, s.paneManager.splitRatio())}
                        tocContainer={
                          // Only one pane mounts its TOC into the
                          // shared aside.toc-panel — otherwise two
                          // Previews race over the same DOM node.
                          // With a single visible pane that's pane 0;
                          // with two panes that's whichever is active.
                          (visiblePanes().length === 1
                            ? i() === 0
                            : i() === s.paneManager.activePaneIndex())
                            ? tocContainerRef
                            : undefined
                        }
                        showToolbar={props.showToolbar}
                        showEditorTabs={props.showEditorTabs}
                        showRecentHistory={props.showRecentHistory}
                        hasRoot={props.hasRoot}
                        contentWrapper={props.contentWrapper}
                        resolveImageSrc={props.resolveImageSrc}
                        resolveFileSrc={props.resolveFileSrc}
                        renderExcalidraw={props.renderExcalidraw}
                        onLoadFile={props.onLoadFile}
                        onOpenInNewTab={props.onOpenInNewTab}
                        onActivateTab={props.onActivateTab}
                        onCloseTab={props.onCloseTab}
                        onNewTab={props.onNewTab}
                        onMoveTab={
                          props.enableSplit === false ? undefined : props.onMoveTab
                        }
                        moveTabLabel={
                          s.paneManager.panes().length > 1
                            ? "Move to Other Pane"
                            : "Open in Split Pane"
                        }
                        onOpenFolder={props.onOpenFolder}
                        onOpenRecentFile={props.onOpenRecentFile}
                        onOpenRecentFolder={props.onOpenRecentFolder}
                        onWindowDragStart={props.onWindowDragStart}
                        onNavigate={props.onNavigate}
                        onOpenExternal={props.onOpenExternal}
                        onShowShortcutsHelp={props.onShortcutsHelpOpen}
                        onActivate={() => s.paneManager.setActivePane(i())}
                      />
                    </>
                  )}
                </For>
              </div>
              <DragOverlay>
                {(draggable) => {
                  const parsed = draggable ? fromTabDndId(draggable.id) : null;
                  if (!parsed) return null;
                  const sourcePane = s.paneManager.panes()[parsed.paneIndex];
                  const tab = sourcePane?.tabs.getTab(parsed.tabId);
                  return (
                    <div class="tab-bar-item tab-bar-item-active tab-bar-drag-overlay">
                      <span class="tab-bar-item-name">{tab?.fileName ?? ""}</span>
                    </div>
                  );
                }}
              </DragOverlay>
            </DragDropProvider>
          </div>
          <Show when={s.tocVisible() && !!props.hasRoot}>
            <div
              class="resize-handle resize-handle-toc"
              onDblClick={s.onTocResizeReset}
              onMouseDown={(e) => s.onTocResizeStart(e, appRef)}
            />
          </Show>
          <TocPanel
            tocVisible={s.tocVisible()}
            hasRoot={!!props.hasRoot}
            width={s.tocWidth()}
            hasToc={s.hasToc()}
            tocLevels={s.tocLevels()}
            setTocLevels={s.setTocLevels}
            setTocExpanded={setTocExpanded}
            contentRef={(el) => { tocContainerRef = el; }}
            panelRef={(el) => { tocPanelRef = el; }}
            backlinksCount={s.activeBacklinks().length}
            activeTab={s.aiActiveTab()}
            onActiveTabChange={s.setAiActiveTab}
            aiSlot={
              <AiPanel
                store={s.aiChat}
                focusTrigger={s.aiComposerFocusTrigger()}
                providerLabel={props.aiProviderLabel}
                onOpenSettings={props.onOpenSettings}
              />
            }
            backlinksSlot={
              <BacklinksList
                entries={s.activeBacklinks().map<BacklinkEntry>((path) => ({
                  path,
                  label: path.includes("/")
                    ? path.slice(path.lastIndexOf("/") + 1)
                    : path,
                  rootId: s.selectedRootId() ?? undefined,
                }))}
                onSelect={(entry) => {
                  if (!entry.rootId) return;
                  props.onLoadFile?.(
                    { kind: "file", name: entry.label, path: entry.path },
                    entry.rootId,
                  );
                }}
              />
            }
          />
        </div>
        <Show when={props.showToolbar && (props.toolbarRootName || props.toolbarFilePath)}>
          <footer class="status-bar no-print">
            <span class="status-breadcrumb">
              <Show when={props.toolbarRootName}>
                <span class="status-root">{props.toolbarRootName}</span>
              </Show>
              <Show when={props.toolbarFilePath}>
                <Show when={props.toolbarRootName}>
                  <span class="status-sep">/</span>
                </Show>
                <span class="status-file">{props.toolbarFilePath}</span>
              </Show>
            </span>
            <Show when={s.hasFile() && s.readingMetrics().words > 0}>
              <span class="status-metrics">
                <span class="status-words">
                  {s.readingMetrics().words.toLocaleString()} words
                </span>
                <Show when={s.readingTimeLabel()}>
                  <span class="status-sep">·</span>
                  <span class="status-reading-time">{s.readingTimeLabel()}</span>
                </Show>
              </span>
            </Show>
          </footer>
        </Show>
      </div>
    </AppProvider>
  );
}
