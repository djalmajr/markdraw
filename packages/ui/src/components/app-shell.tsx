import { Show, type JSX } from "solid-js";
import type { FSEntry } from "@asciimark/core/types.ts";
import type { AppState } from "../composables/create-app-state.ts";
import { AppProvider } from "../context/app-context.tsx";
import { Toolbar } from "./toolbar.tsx";
import { FileTree } from "./file-tree.tsx";
import { Preview } from "./preview.tsx";
import { Editor } from "./editor.tsx";
import { EmptyState } from "./empty-state.tsx";

interface AppShellProps {
  state: AppState;

  // Platform-specific booleans (as accessors for reactivity)
  hasRoot: boolean;
  showEditorTabs: boolean;
  showNavButtons: boolean;
  showToolbar: boolean;
  showSidebar: boolean;

  // Platform-derived toolbar strings
  toolbarFilePath: string | null;
  toolbarRootName: string;

  // Platform callbacks
  onCloseFolder?: () => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onLoadFile: (entry: FSEntry) => void;
  onNavigate: (path: string, fragment?: string | null) => void;
  onOpenFolder?: () => void;

  // Platform-specific content (extension: FileAccessWarning wrapper)
  contentWrapper?: (content: JSX.Element) => JSX.Element;

  // DnD (extension uses DOM events, desktop uses Tauri native)
  onDragLeave?: (e: DragEvent) => void;
  onDragOver?: (e: DragEvent) => void;
  onDrop?: (e: DragEvent) => void;
}

export function AppShell(props: AppShellProps) {
  let tocPanelRef: HTMLElement | undefined;
  let appRef: HTMLDivElement | undefined;
  let mainRef: HTMLDivElement | undefined;

  // Wire tocPanelRef for state methods that need it
  const s = props.state;

  const defaultContent = () => (
    <Show
      when={s.selectedFile()}
      fallback={
        <EmptyState
          hasRoot={props.hasRoot}
          onOpenFolder={props.onOpenFolder}
        />
      }
    >
      <Preview
        html={s.html()}
        loading={s.loading()}
        tocVisible={s.tocVisible()}
        tocContainer={tocPanelRef}
        currentFilePath={s.selectedFile()?.path ?? null}
        pendingFragment={s.pendingFragment()}
        onFragmentHandled={() => s.setPendingFragment(null)}
        onNavigate={props.onNavigate}
        onTocChange={(has) => s.setHasToc(has)}
      />
    </Show>
  );

  return (
    <AppProvider state={props.state}>
      <div
        class="app"
        classList={{ "drag-over": s.dragOver() }}
        ref={appRef}
        onDragOver={props.onDragOver}
        onDragLeave={props.onDragLeave}
        onDrop={props.onDrop}
      >
        <Show when={props.showToolbar}>
          <Toolbar
            autoRefresh={s.autoRefresh()}
            canGoBack={s.canGoBack()}
            canGoForward={s.canGoForward()}
            codeTheme={s.codeTheme()}
            codeThemes={s.CodeThemes}
            darkMode={s.darkMode()}
            editorMode={s.editorMode()}
            fontFamilies={s.FontFamilies}
            fontPrefs={s.fontPrefs()}
            fontSizes={s.FontSizes}
            hasFile={s.hasFile()}
            hasRoot={props.hasRoot}
            recentFiles={s.recentFiles()}
            showEditorTabs={props.showEditorTabs}
            showNavButtons={props.showNavButtons}
            sidebarVisible={s.sidebarVisible()}
            themeMode={s.themeMode()}
            tocVisible={s.tocVisible()}
            onClearRecent={s.handleClearRecent}
            onCloseFolder={props.onCloseFolder}
            onCodeThemeChange={s.handleCodeThemeChange}
            onDownloadPdf={s.handleDownloadPdf}
            onEditorModeChange={(m) => s.setEditorMode(m)}
            onExportPdf={() => s.handleExportPdf(tocPanelRef)}
            onFontPrefsChange={s.handleFontPrefsChange}
            onGoBack={props.onGoBack}
            onGoForward={props.onGoForward}
            onOpenFolder={props.onOpenFolder}
            onOpenRecent={(path) => {
              const entry = s.findEntryByPath(path);
              if (entry && entry.kind === "file") props.onLoadFile(entry);
            }}
            onThemeChange={s.handleThemeChange}
            onToggleAutoRefresh={() => s.setAutoRefresh((v) => !v)}
            onToggleSidebar={() => s.setSidebarVisible((v) => !v)}
            onToggleToc={() => s.setTocVisible((v) => !v)}
          />
        </Show>
        <div class="main" ref={mainRef}>
          <Show when={props.showSidebar}>
            <aside class="sidebar" style={{ width: `${s.sidebarWidth()}px` }}>
              <FileTree
                entries={s.tree()}
                selectedPath={s.selectedFile()?.path ?? null}
                onSelect={(entry) => props.onLoadFile(entry)}
              />
            </aside>
            <div class="resize-handle" onDblClick={s.onResizeReset} onMouseDown={(e) => s.onResizeStart(e, appRef)} />
          </Show>
          <Show when={s.editorMode() !== "preview" && s.selectedFile()}>
            <div
              class="editor-panel"
              style={s.editorMode() === "split" ? { flex: s.editorWidth() } : undefined}
            >
              <Editor
                content={s.savedContent()}
                darkMode={s.darkMode()}
                onChange={(content) => {
                  const entry = s.selectedFile();
                  if (entry) s.debouncedConvert(content, entry.path, s._readFile ?? (() => Promise.resolve(null)));
                }}
              />
            </div>
          </Show>
          <Show when={s.editorMode() === "split" && s.selectedFile()}>
            <div
              class="resize-handle"
              onDblClick={s.onEditorResizeReset}
              onMouseDown={(e) => s.onEditorResizeStart(e, mainRef, appRef)}
            />
          </Show>
          <Show when={s.editorMode() !== "edit"}>
            <div
              class="content"
              style={s.editorMode() === "split" ? { flex: 100 - s.editorWidth() } : undefined}
            >
              {props.contentWrapper
                ? props.contentWrapper(defaultContent())
                : defaultContent()
              }
            </div>
          </Show>
          <aside
            class="toc-panel"
            classList={{ "toc-hidden": !s.tocVisible() || !s.hasFile() || !s.hasToc() }}
            ref={tocPanelRef}
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
          </footer>
        </Show>
      </div>
    </AppProvider>
  );
}
